package com.nextpresent.remote

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * VolumeKeyAccessibilityService — intercepts raw hardware volume key events.
 *
 * GESTURE MODEL (screen-on, when accessibility permission is granted):
 *   Single tap Vol Up/Down   → change slide (Next/Prev)
 *   Double-tap Vol Up/Down   → toggle laser ON/OFF
 *
 * The service sets suppressVolumeObserver=true while handling a key to prevent
 * PresenterService's ContentObserver/BroadcastReceiver from double-triggering.
 */
class VolumeKeyAccessibilityService : AccessibilityService() {

    private val keyHandler = Handler(Looper.getMainLooper())

    // Double-tap state
    private val DOUBLE_TAP_WINDOW_MS = 400L
    private var lastTapTs: Long = 0L
    private var lastTapIsUp: Boolean = false
    private var pendingTapRunnable: Runnable? = null

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val keyCode = event.keyCode
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.onKeyEvent(event)
        }

        // Only act on ACTION_DOWN (repeatCount == 0) to avoid double-firing on repeat
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) {
            return true // consume all volume key events
        }

        val isUp = (keyCode == KeyEvent.KEYCODE_VOLUME_UP)
        val service = PresenterService.instance ?: return true

        // Suppress ContentObserver/Broadcast path for 700ms
        service.suppressVolumeObserver = true
        keyHandler.removeCallbacksAndMessages("suppress_clear")
        keyHandler.postAtTime({
            service.suppressVolumeObserver = false
        }, "suppress_clear", android.os.SystemClock.uptimeMillis() + 700L)

        val now = System.currentTimeMillis()

        // ── DOUBLE-TAP DETECTION ──────────────────────────────────────────────
        if (now - lastTapTs < DOUBLE_TAP_WINDOW_MS && isUp == lastTapIsUp) {
            // Cancel the pending single-tap action
            pendingTapRunnable?.let { keyHandler.removeCallbacks(it) }
            pendingTapRunnable = null

            // Toggle laser
            if (service.isLaserRunning()) {
                service.stopBackgroundLaser()
            } else {
                service.startBackgroundLaser()
            }

            lastTapTs = 0L
            return true
        }

        // ── SINGLE TAP ───────────────────────────────────────────────────────
        lastTapTs = now
        lastTapIsUp = isUp
        val slideAction = if (isUp) "NEXT" else "PREV"

        pendingTapRunnable?.let { keyHandler.removeCallbacks(it) }

        val tapRunnable = Runnable {
            pendingTapRunnable = null
            lastTapTs = 0L

            if (service.isLaserRunning()) {
                service.stopBackgroundLaser()
            } else {
                service.sendSlideAction(slideAction)
                service.vibrateFeedback(35)
            }
        }
        pendingTapRunnable = tapRunnable
        keyHandler.postDelayed(tapRunnable, DOUBLE_TAP_WINDOW_MS)

        return true // consume key event
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
}
