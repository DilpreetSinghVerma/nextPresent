package com.nextpresent.remote

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * VolumeKeyAccessibilityService — 100% precise screen-off/lock-screen volume key interception.
 *
 * This service receives raw ACTION_DOWN and ACTION_UP events directly from the input system,
 * even when the screen is off or the device is locked. It is the PRIMARY source of truth for
 * volume key events when the screen is off. To avoid double-triggering, it signals
 * PresenterService to suppress its ContentObserver/Broadcast-based detection while this
 * service is handling an active key press.
 *
 * Logic:
 *  - Quick tap (< 180ms hold): immediately change slide on ACTION_UP
 *  - Hold (>= 180ms):          start laser on screen-off → stop laser on ACTION_UP, NO slide change
 */
class VolumeKeyAccessibilityService : AccessibilityService() {

    private val keyHandler = Handler(Looper.getMainLooper())
    private var holdLaserRunnable: Runnable? = null
    private var isVolUpHeld = false
    private var isVolDownHeld = false
    private var hasLaserStarted = false

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val keyCode = event.keyCode
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.onKeyEvent(event)
        }

        val isUpKey = (keyCode == KeyEvent.KEYCODE_VOLUME_UP)
        val service = PresenterService.instance

        if (event.action == KeyEvent.ACTION_DOWN) {
            if (isUpKey) isVolUpHeld = true else isVolDownHeld = true

            if (event.repeatCount == 0) {
                // Cancel any pending hold runnable
                holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }

                // Tell service to suppress its own volume observer to avoid double-firing
                service?.suppressVolumeObserver = true

                // Schedule hold-to-laser timer (180ms)
                if (service?.isLaserRunning() != true) {
                    hasLaserStarted = false
                    val r = Runnable {
                        if (isVolUpHeld || isVolDownHeld) {
                            hasLaserStarted = true
                            service?.startBackgroundLaser()
                        }
                    }
                    holdLaserRunnable = r
                    keyHandler.postDelayed(r, 180L)
                }
            }
            return true // consume key

        } else if (event.action == KeyEvent.ACTION_UP) {
            if (isUpKey) isVolUpHeld = false else isVolDownHeld = false

            // Cancel pending hold timer
            holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }
            holdLaserRunnable = null

            if (hasLaserStarted || service?.isLaserRunning() == true) {
                // Held → stop laser, NO slide change
                service?.stopBackgroundLaser()
                hasLaserStarted = false
            } else {
                // Quick tap → change slide IMMEDIATELY (zero extra delay)
                val action = if (isUpKey) "NEXT" else "PREV"
                service?.sendSlideAction(action)
                service?.vibrateFeedback(35)
            }

            // Re-enable service's volume observer after a short window
            // to avoid it catching the system volume-reset echo
            keyHandler.postDelayed({
                service?.suppressVolumeObserver = false
            }, 350L)

            return true // consume key
        }

        return super.onKeyEvent(event)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
}
