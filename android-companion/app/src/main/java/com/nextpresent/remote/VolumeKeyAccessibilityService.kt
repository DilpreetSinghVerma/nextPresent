package com.nextpresent.remote

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * VolumeKeyAccessibilityService — intercepts hardware volume keys when active.
 *
 * GESTURE MODEL:
 *   Quick tap Vol Up/Down (< 200ms) → Immediate slide change on ACTION_UP (0 lag!)
 *   Hold Vol Up/Down      (>= 200ms) → Laser turns ON
 *   Release button                   → Laser turns OFF, 0 slide change!
 */
class VolumeKeyAccessibilityService : AccessibilityService() {

    private val keyHandler = Handler(Looper.getMainLooper())
    private var holdLaserRunnable: Runnable? = null
    private var isVolUpHeld = false
    private var isVolDownHeld = false
    private var hasLaserStarted = false

    override fun onKeyEvent(event: KeyEvent): Boolean {
        android.util.Log.d("NXTslide_A11y", "onKeyEvent: action=${event.action}, keyCode=${event.keyCode}, repeatCount=${event.repeatCount}")
        val keyCode = event.keyCode
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.onKeyEvent(event)
        }

        val isUpKey = (keyCode == KeyEvent.KEYCODE_VOLUME_UP)
        val service = PresenterService.instance

        val sensorManager = getSystemService(android.content.Context.SENSOR_SERVICE) as? android.hardware.SensorManager
        val hasGyro = (sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE) != null)

        if (!hasGyro) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                val action = if (isUpKey) "NEXT" else "PREV"
                service?.sendSlideAction(action)
                service?.vibrateFeedback(35)
            }
            return true
        }

        if (event.action == KeyEvent.ACTION_DOWN) {
            if (isUpKey) isVolUpHeld = true else isVolDownHeld = true

            if (event.repeatCount == 0) {
                // Cancel any pending hold runnable
                holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }

                // Suppress background volume observer while handling
                service?.suppressVolumeObserver = true

                // Schedule hold-to-laser timer (200ms)
                if (service?.isLaserRunning() != true) {
                    hasLaserStarted = false
                    val r = Runnable {
                        if (isVolUpHeld || isVolDownHeld) {
                            hasLaserStarted = true
                            service?.startBackgroundLaser()
                        }
                    }
                    holdLaserRunnable = r
                    keyHandler.postDelayed(r, 200L)
                }
            }
            return true // consume key

        } else if (event.action == KeyEvent.ACTION_UP) {
            if (isUpKey) isVolUpHeld = false else isVolDownHeld = false

            // Cancel pending hold timer
            holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }
            holdLaserRunnable = null

            if (hasLaserStarted || service?.isLaserRunning() == true) {
                // Held → stop laser, NO slide change!
                service?.stopBackgroundLaser()
                hasLaserStarted = false
            } else {
                // Quick tap → change slide IMMEDIATELY (zero extra delay)
                val action = if (isUpKey) "NEXT" else "PREV"
                service?.sendSlideAction(action)
                service?.vibrateFeedback(35)
            }

            keyHandler.postDelayed({
                service?.suppressVolumeObserver = false
            }, 300L)

            return true // consume key
        }

        return super.onKeyEvent(event)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
}
