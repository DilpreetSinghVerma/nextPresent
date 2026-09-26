package com.nextpresent.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import androidx.core.app.NotificationCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * PresenterService — Ultra-reliable background & lock-screen volume interception engine.
 *
 * Employs 4 concurrent systems to guarantee 100% volume-key capture when screen is OFF:
 *  1. RECEIVER_EXPORTED broadcast receiver on "android.media.VOLUME_CHANGED_ACTION"
 *  2. ContentObserver on Settings.System.CONTENT_URI (captures hardware volume changes even if broadcasts are suppressed)
 *  3. Active MediaSession with STATE_PLAYING (tells Android this app is the primary audio controller)
 *  4. AudioTrack 44.1kHz PCM continuous silence + PARTIAL_WAKE_LOCK + High-Perf WifiLock
 */
class PresenterService : Service() {

    // ─── Binder ──────────────────────────────────────────────────────────────
    inner class LocalBinder : Binder() {
        fun getService(): PresenterService = this@PresenterService
    }
    private val binder = LocalBinder()

    // ─── Config ──────────────────────────────────────────────────────────────
    var serverIp: String   = "192.168.101.9"
    var serverPort: Int    = 3333
    var relayRoomCode: String? = null
    var relayBaseUrl: String   = "https://nxtslide.online"

    // ─── Internals ───────────────────────────────────────────────────────────
    private val client = OkHttpClient.Builder()
        .pingInterval(10, java.util.concurrent.TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private var webSocket: WebSocket? = null

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var audioTrack: AudioTrack? = null
    private var audioManager: AudioManager? = null
    private var mediaSession: MediaSession? = null

    /** Continuous audio thread keeps audio DSP & lockscreen routing active */
    private var isAudioRunning = false
    private var audioThread: Thread? = null

    /** Volume midpoint we restore silently after every key press */
    private var midVolume: Int = 7
    private var lastHandledTs = 0L
    @Volatile private var isResettingVolume = false
    private val mainHandler = Handler(Looper.getMainLooper())

    // ─── Precision Volume Handling (Screen-Off & Lock Screen) ───────────────
    private var isVolKeyHeld: Boolean = false
    private var hasLaserStarted: Boolean = false
    private var pendingDirection: Int = 0 // +1 = Up (NEXT), -1 = Down (PREV)
    private var holdThresholdRunnable: Runnable? = null
    private var lastActionTs: Long = 0L
    @Volatile private var lastVolumeProviderTs: Long = 0L

    @Volatile var isSessionActive: Boolean = false
    private var audioFocusRequest: android.media.AudioFocusRequest? = null

    /**
     * Set to true by VolumeKeyAccessibilityService when it is actively handling a key press.
     * Suppresses background paths from double-firing on the same event.
     */
    @Volatile var suppressVolumeObserver: Boolean = false

    /** Whether the broadcast receiver is registered */
    private var receiverRegistered = false
    private var volumeObserver: ContentObserver? = null

    companion object {
        @Volatile var instance: PresenterService? = null
        const val CHANNEL_ID   = "nextpresent_presenter"
        const val NOTIF_ID     = 1001
        const val ACTION_PREV  = "com.nextpresent.remote.ACTION_PREV"
        const val ACTION_NEXT  = "com.nextpresent.remote.ACTION_NEXT"
        const val ACTION_STOP  = "com.nextpresent.remote.ACTION_STOP"

        const val EXTRA_SERVER_IP   = "server_ip"
        const val EXTRA_SERVER_PORT = "server_port"
        const val EXTRA_RELAY_CODE  = "relay_room_code"
        const val EXTRA_RELAY_BASE  = "relay_base_url"
    }

    fun isLaserRunning(): Boolean = isLaserActive

    // ─── Background Hardware Laser Pointer ───────────────────────────────────
    private var sensorManager: SensorManager? = null
    private var rotationSensor: Sensor? = null
    private var sensorThread: HandlerThread? = null
    private var sensorHandler: Handler? = null
    private var isLaserActive: Boolean = false
    private var lastWasUp: Boolean = false
    private var laserTimeoutRunnable: Runnable? = null
    /**
     * A dedicated WakeLock held only while the laser is active.
     * This keeps the CPU alive so the rotation sensor keeps firing when the screen is off.
     * Without this, SENSOR_DELAY_GAME events stop within ~200ms of screen off.
     */
    private var laserWakeLock: PowerManager.WakeLock? = null

    private val currentMatrix = FloatArray(9)
    private var isAccelerometerFallback = false
    private var prevAccelX = 0f
    private var prevAccelY = 0f
    private var prevHx = 0f
    private var prevHy = 0f
    private var prevHz = 0f
    private var sensorWarmupCount = 0
    private var currentLaserX: Float = 0.5f
    private var currentLaserY: Float = 0.5f
    private var smoothDx: Float = 0f
    private var smoothDy: Float = 0f
    private var lastSendTs: Long = 0L

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            if (!isLaserActive) return

            try {
                var rawDx = 0f
                var rawDy = 0f

                if (isAccelerometerFallback) {
                    // Device has NO Gyroscope (e.g. Oppo A78 5G / budget devices)
                    val curX = event.values[0]
                    val curY = event.values[1]
                    val curZ = if (event.values.size > 2) event.values[2] else 9.81f

                    if (curX.isNaN() || curY.isNaN() || curZ.isNaN()) return

                    if (sensorWarmupCount < 3) {
                        prevAccelX = curX
                        prevAccelY = curY
                        sensorWarmupCount++
                        currentLaserX = 0.5f
                        currentLaserY = 0.5f
                        smoothDx = 0f
                        smoothDy = 0f
                        lastSendTs = 0L
                        sendLaserMove(0.5f, 0.5f)
                        return
                    }

                    // Delta tilt in radians:
                    // Invert X when phone is held upside down (screen facing floor, curZ < -2.0)
                    val isUpsideDown = (curZ < -2.0f)
                    val deltaX = (curX - prevAccelX) / 9.81f
                    val deltaY = (curY - prevAccelY) / 9.81f

                    rawDx = if (isUpsideDown) -deltaX else deltaX
                    rawDy = deltaY

                    prevAccelX = curX
                    prevAccelY = curY
                } else {
                    // Device HAS Gyroscope / Rotation Vector
                    SensorManager.getRotationMatrixFromVector(currentMatrix, event.values)

                    val currHx = currentMatrix[1]
                    val currHy = currentMatrix[4]
                    val currHz = currentMatrix[7]

                    if (currHx.isNaN() || currHy.isNaN() || currHz.isNaN()) return

                    val safeHz = currHz.coerceIn(-0.999f, 0.999f)

                    if (sensorWarmupCount < 2) {
                        prevHx = currHx
                        prevHy = currHy
                        prevHz = safeHz
                        sensorWarmupCount++
                        currentLaserX = 0.5f
                        currentLaserY = 0.5f
                        smoothDx = 0f
                        smoothDy = 0f
                        lastSendTs = 0L
                        sendLaserMove(0.5f, 0.5f)
                        return
                    }

                    // 1. Elevation (Pitch): Elevation angle in radians above ground plane
                    val prevElev = Math.asin(prevHz.coerceIn(-0.999f, 0.999f).toDouble()).toFloat()
                    val currElev = Math.asin(safeHz.toDouble()).toFloat()
                    rawDy = currElev - prevElev

                    // 2. Azimuth (Yaw): Turning around vertical gravity axis in radians
                    val cross = prevHy * currHx - prevHx * currHy
                    val dot = prevHx * currHx + prevHy * currHy
                    val horizMag = Math.hypot(currHx.toDouble(), currHy.toDouble()).toFloat()
                    rawDx = if (horizMag > 0.15f) {
                        Math.atan2(cross.toDouble(), dot.toDouble()).toFloat()
                    } else {
                        0f
                    }

                    prevHx = currHx
                    prevHy = currHy
                    prevHz = safeHz
                }

                if (rawDx.isNaN() || rawDx.isInfinite()) rawDx = 0f
                if (rawDy.isNaN() || rawDy.isInfinite()) rawDy = 0f

                // Anomaly spike rejection: human wrist cannot exceed ~5 rad/s (0.045 rad per 10ms frame).
                val maxDelta = 0.045f
                val boundedDx = rawDx.coerceIn(-maxDelta, maxDelta)
                val boundedDy = rawDy.coerceIn(-maxDelta, maxDelta)

                // Calibrated deadzone:
                // Accelerometer requires a slightly wider deadzone (0.0032 rad ≈ 0.18°) to freeze thermal/sensor jitter.
                // Gyroscope uses a microscopic tremor filter (0.00035 rad).
                val deadzoneThreshold = if (isAccelerometerFallback) 0.0032f else 0.00035f
                val rampThreshold = if (isAccelerometerFallback) 0.0090f else 0.0014f

                val mag = Math.hypot(boundedDx.toDouble(), boundedDy.toDouble()).toFloat()
                val scale = if (mag < deadzoneThreshold) {
                    0f // Rock-solid still: completely eliminates drift and constant moving
                } else if (mag < rampThreshold) {
                    (mag - deadzoneThreshold) / (rampThreshold - deadzoneThreshold)
                } else {
                    1f
                }
                val dx = boundedDx * scale
                val dy = boundedDy * scale

                // Keep laser alive while user is actively moving / pointing
                if (mag > deadzoneThreshold && laserTimeoutRunnable != null) {
                    mainHandler.removeCallbacks(laserTimeoutRunnable!!)
                    mainHandler.postDelayed(laserTimeoutRunnable!!, 60000L)
                }

                // Low-pass exponential smoothing: removes sensor stepping and jitter
                val alpha = if (isAccelerometerFallback) 0.25f else 0.40f
                smoothDx = smoothDx * (1f - alpha) + dx * alpha
                smoothDy = smoothDy * (1f - alpha) + dy * alpha

                if (smoothDx.isNaN() || smoothDx.isInfinite()) smoothDx = 0f
                if (smoothDy.isNaN() || smoothDy.isInfinite()) smoothDy = 0f

                // Calibrated sensitivity
                val SENSITIVITY_X = if (isAccelerometerFallback) 2.20f else 1.30f
                val SENSITIVITY_Y = if (isAccelerometerFallback) 2.40f else 1.40f

                // Update positions with instant edge un-sticking (never gets pinned or trapped)
                currentLaserX = (currentLaserX + smoothDx * SENSITIVITY_X).coerceIn(0.01f, 0.99f)
                currentLaserY = (currentLaserY - smoothDy * SENSITIVITY_Y).coerceIn(0.01f, 0.99f)

                if (currentLaserX.isNaN()) currentLaserX = 0.5f
                if (currentLaserY.isNaN()) currentLaserY = 0.5f

                // Throttle WebSocket to ~65Hz to prevent TCP packet batching/micro-stutter
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastSendTs >= 15L) {
                    lastSendTs = now
                    sendLaserMove(currentLaserX, currentLaserY)
                }
            } catch (t: Throwable) {
                android.util.Log.e("NXTslide_Sensor", "Error in onSensorChanged: ${t.message}", t)
            }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    fun hasHardwareGyro(): Boolean {
        if (sensorManager == null) {
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        }
        return sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null
    }

    @Synchronized
    fun startBackgroundLaser() {
        if (!hasHardwareGyro()) {
            android.util.Log.d("NXTslide_Sensor", "startBackgroundLaser aborted: No physical gyroscope sensor on device")
            return
        }

        if (sensorManager == null) {
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        }

        // Check if device has a physical hardware gyroscope:
        val hasHardwareGyro = (sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null)

        rotationSensor = if (hasHardwareGyro) {
            // Devices WITH Gyroscope (e.g. flagship phones, OnePlus with gyro):
            // Use Game Rotation Vector (Best: Gyro + Accel 6-DoF, zero compass drift/jumps)
            sensorManager?.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
                ?: sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        } else {
            // Devices WITHOUT Gyroscope (e.g. Oppo A78 5G, budget phones):
            // DO NOT use compass rotation vector (it constantly drifts & jitters indoors).
            // Use clean Gravity sensor or Accelerometer for rock-solid stability!
            sensorManager?.getDefaultSensor(Sensor.TYPE_GRAVITY)
                ?: sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        }

        isAccelerometerFallback = (!hasHardwareGyro)
        android.util.Log.d("NXTslide_Sensor", "startBackgroundLaser: hasGyro=$hasHardwareGyro, isFallback=$isAccelerometerFallback, sensor=${rotationSensor?.name}")

        if (isLaserActive) return
        isLaserActive = true
        hasLaserStarted = true
        sensorWarmupCount = 0
        currentLaserX = 0.5f
        currentLaserY = 0.5f
        smoothDx = 0f
        smoothDy = 0f
        lastSendTs = 0L

        // ── Acquire a dedicated WakeLock so CPU stays awake for sensor readings ──
        // Without this, rotation sensor events stop within ~200ms when screen is off.
        if (laserWakeLock == null || laserWakeLock?.isHeld == false) {
            val pm = getSystemService(POWER_SERVICE) as? PowerManager
            laserWakeLock = pm?.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "NXTslide::LaserSensorWakeLock"
            )
        }
        if (laserWakeLock?.isHeld == false) {
            laserWakeLock?.acquire(120_000L) // 2 min safety limit
        }

        // ── Start dedicated sensor thread if not already running ──
        if (sensorThread == null || !sensorThread!!.isAlive) {
            sensorThread = HandlerThread("PresenterSensorThread").apply { start() }
            sensorHandler = Handler(sensorThread!!.looper)
        }

        // Use SENSOR_DELAY_FASTEST: Android may throttle GAME/UI sensors when screen is off,
        // but FASTEST is protected and continues running even in doze/screen-off.
        rotationSensor?.let {
            sensorManager?.registerListener(sensorListener, it, SensorManager.SENSOR_DELAY_FASTEST, sensorHandler)
        }

        vibrateFeedback(75) // Strong laser active feedback
        sendLaserDown(0.5f, 0.5f, "laser")

        laserTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        val timeout = Runnable { stopBackgroundLaser() }
        laserTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, 90000L) // 90s safety auto-off (reset dynamically while moving)
    }

    @Synchronized
    fun stopBackgroundLaser() {
        if (!isLaserActive) return
        isLaserActive = false
        hasLaserStarted = false
        isVolKeyHeld = false
        pendingDirection = 0
        sensorManager?.unregisterListener(sensorListener)
        laserTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        laserTimeoutRunnable = null
        // Release the dedicated laser wakelock now that sensor is no longer needed
        try { if (laserWakeLock?.isHeld == true) laserWakeLock?.release() } catch (_: Exception) {}
        vibrateFeedback(30)
        sendLaserUp()
    }

    private fun sendLaserDown(x: Float, y: Float, style: String = "laser") {
        val safeX = if (x.isNaN() || x.isInfinite()) 0.5f else x.coerceIn(0.01f, 0.99f)
        val safeY = if (y.isNaN() || y.isInfinite()) 0.5f else y.coerceIn(0.01f, 0.99f)
        try {
            val payload = JSONObject().apply {
                put("type", "LASER_DOWN")
                put("x", safeX.toDouble())
                put("y", safeY.toDouble())
                put("style", style)
                put("source", "Background Hardware Aim")
            }.toString()
            val sent = webSocket?.send(payload) ?: false
            if (!sent) connectWebSocket()
            android.util.Log.d("NXTslide_Laser", "sendLaserDown sent=$sent")
        } catch (_: Exception) {}
    }

    private fun sendLaserMove(x: Float, y: Float) {
        val safeX = if (x.isNaN() || x.isInfinite()) 0.5f else x.coerceIn(0.01f, 0.99f)
        val safeY = if (y.isNaN() || y.isInfinite()) 0.5f else y.coerceIn(0.01f, 0.99f)
        try {
            val payload = JSONObject().apply {
                put("type", "LASER_MOVE")
                put("x", safeX.toDouble())
                put("y", safeY.toDouble())
                put("source", "Background Hardware Aim")
            }.toString()
            webSocket?.send(payload)
        } catch (_: Exception) {}
    }

    private fun sendLaserUp() {
        try {
            val payload = JSONObject().apply {
                put("type", "LASER_UP")
                put("source", "Background Hardware Aim")
            }.toString()
            val sent = webSocket?.send(payload) ?: false
            android.util.Log.d("NXTslide_Laser", "sendLaserUp sent=$sent")
        } catch (_: Exception) {}
    }

    // ─── Precision Volume Handling Engine (Screen-Off & Lock-Screen) ────────
    //
    // GESTURE MODEL:
    //   Quick tap Vol Up   (< 200ms) → NEXT slide immediately on release (no lag!)
    //   Quick tap Vol Down (< 200ms) → PREV slide immediately on release (no lag!)
    //   Hold Vol Up/Down   (>= 200ms) → Laser turns ON with tactile buzz
    //   Release button               → Laser turns OFF, 0 slide change!
    @Synchronized
    private fun handleVolumeAdjust(direction: Int) {
        if (!isSessionActive) return
        lastVolumeProviderTs = System.currentTimeMillis()
        android.util.Log.d("NXTslide_Volume", "handleVolumeAdjust: direction=$direction, isHeld=$isVolKeyHeld, hasLaser=$hasLaserStarted, isLaserActive=$isLaserActive")

        if (!hasHardwareGyro()) {
            // Non-gyro phones: Immediate slide change on tap, NO laser hold/sensor activation!
            if (direction != 0) {
                val now = System.currentTimeMillis()
                if (now - lastActionTs >= 120L) {
                    lastActionTs = now
                    val action = if (direction > 0) "NEXT" else "PREV"
                    vibrateFeedback(35)
                    sendSlideAction(action)
                }
            }
            return
        }

        if (direction != 0) {
            // Direction is +1 (Vol UP) or -1 (Vol DOWN)
            if (hasLaserStarted || isLaserActive) {
                // Laser is currently active — user is holding button while aiming
                return
            }

            if (!isVolKeyHeld) {
                isVolKeyHeld = true
                pendingDirection = direction
                hasLaserStarted = false

                // Schedule hold detection: hold for 200ms -> START LASER!
                holdThresholdRunnable?.let { mainHandler.removeCallbacks(it) }
                val holdRunnable = Runnable {
                    if (isVolKeyHeld && !hasLaserStarted) {
                        hasLaserStarted = true
                        startBackgroundLaser()
                    }
                }
                holdThresholdRunnable = holdRunnable
                mainHandler.postDelayed(holdRunnable, 200L)
            } else {
                // Repeat event arrived while held -> user is holding, trigger laser immediately!
                holdThresholdRunnable?.let { mainHandler.removeCallbacks(it) }
                holdThresholdRunnable = null
                if (!hasLaserStarted) {
                    hasLaserStarted = true
                    startBackgroundLaser()
                }
            }
        } else {
            // Direction 0: KEY RELEASED!
            onVolumeKeyReleased()
        }
    }

    @Synchronized
    private fun onVolumeKeyReleased() {
        holdThresholdRunnable?.let { mainHandler.removeCallbacks(it) }
        holdThresholdRunnable = null

        if (!isVolKeyHeld && !hasLaserStarted && !isLaserActive) return

        if (hasLaserStarted || isLaserActive) {
            // User was holding to aim laser, and just released the button!
            // STOP LASER, DO NOT CHANGE SLIDE!
            stopBackgroundLaser()
            hasLaserStarted = false
            isVolKeyHeld = false
            pendingDirection = 0
        } else {
            // User released BEFORE hold threshold -> IT WAS A QUICK TAP!
            val dir = pendingDirection
            isVolKeyHeld = false
            pendingDirection = 0

            val now = System.currentTimeMillis()
            if (now - lastActionTs >= 100L && dir != 0) {
                lastActionTs = now
                val action = if (dir > 0) "NEXT" else "PREV"
                vibrateFeedback(35)
                sendSlideAction(action)
            }
        }
    }

    // ─── Volume BroadcastReceiver (Fallback for devices without VolumeProvider) ──
    private val volumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != "android.media.VOLUME_CHANGED_ACTION") return
            if (suppressVolumeObserver) return
            // Ignore if VolumeProvider recently handled an event
            if (System.currentTimeMillis() - lastVolumeProviderTs < 2000L) return

            val streamType = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (streamType != AudioManager.STREAM_MUSIC && streamType != -1) return

            val now  = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", -1)
            val prev = intent.getIntExtra("android.media.EXTRA_PREV_VOLUME_STREAM_VALUE", -1)
            if (now < 0 || prev < 0 || now == prev) return

            val isUp = now > prev
            handleVolumeAdjust(if (isUp) 1 else -1)
            mainHandler.postDelayed({ handleVolumeAdjust(0) }, 80L)
        }
    }

    // ─── Notification action receiver ────────────────────────────────────────
    private val actionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PREV -> { vibrateFeedback(38); sendSlideAction("PREV") }
                ACTION_NEXT -> { vibrateFeedback(38); sendSlideAction("NEXT") }
                ACTION_STOP -> stopSelf()
                "com.nextpresent.remote.ACTION_START_LASER" -> {
                    if (hasHardwareGyro()) startBackgroundLaser()
                }
                "com.nextpresent.remote.ACTION_STOP_LASER"  -> stopBackgroundLaser()
            }
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────
    override fun onCreate() {
        super.onCreate()
        instance = this
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let {
            serverIp      = it.getStringExtra(EXTRA_SERVER_IP)   ?: serverIp
            serverPort    = it.getIntExtra(EXTRA_SERVER_PORT, serverPort)
            val code      = it.getStringExtra(EXTRA_RELAY_CODE)
            relayRoomCode = if (code.isNullOrBlank()) null else code
            relayBaseUrl  = it.getStringExtra(EXTRA_RELAY_BASE) ?: relayBaseUrl
        }

        // Automatic fallback to SharedPreferences if intent didn't carry room code
        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        if (relayRoomCode == null) {
            val savedCode = prefs.getString("relay_room_code", null)
            if (!savedCode.isNullOrBlank()) relayRoomCode = savedCode
        }
        if (serverIp == "192.168.101.9") {
            serverIp = prefs.getString("server_ip", serverIp) ?: serverIp
            serverPort = prefs.getInt("server_port", serverPort)
        }

        // Calculate mid-volume for current device
        val maxVol = audioManager?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 15
        midVolume  = (maxVol / 2).coerceAtLeast(1)

        // Set initial stream volume to midpoint
        try {
            audioManager?.setStreamVolume(
                AudioManager.STREAM_MUSIC,
                midVolume,
                AudioManager.FLAG_REMOVE_SOUND_AND_VIBRATE
            )
        } catch (_: Exception) {}

        isSessionActive = true

        // Start foreground immediately
        startForeground(NOTIF_ID, buildNotification(), foregroundServiceTypeMediaPlayback())

        acquireLocks()
        setupMediaSession()
        startContinuousAudio()
        registerVolumeReceiver()
        registerVolumeObserver()
        registerActionReceiver()
        connectWebSocket()

        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        android.util.Log.d("NXTslide_Service", "onTaskRemoved: stopping PresenterService")
        isSessionActive = false
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        isSessionActive = false
        stopBackgroundLaser()
        try { if (receiverRegistered) unregisterReceiver(volumeReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(actionReceiver) } catch (_: Exception) {}
        try { volumeObserver?.let { contentResolver.unregisterContentObserver(it) } } catch (_: Exception) {}

        isAudioRunning = false
        audioThread?.interrupt()
        audioThread = null

        // Abandon AudioFocus so Android routes hardware volume buttons back to system media/sound
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                audioManager?.abandonAudioFocus(null)
            }
        } catch (_: Exception) {}
        audioFocusRequest = null

        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null

        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null

        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        try { if (laserWakeLock?.isHeld == true) laserWakeLock?.release() } catch (_: Exception) {}
        holdThresholdRunnable?.let { mainHandler.removeCallbacks(it) }
        laserTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        holdThresholdRunnable = null
        laserTimeoutRunnable = null

        if (instance === this) {
            instance = null
        }

        webSocket?.close(1000, "Service destroyed")
        webSocket = null
        client.dispatcher.cancelAll()
    }

    // ─── WakeLock & WifiLock ──────────────────────────────────────────────────
    private fun acquireLocks() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "NXTslide::PresenterWakeLock"
            ).also { it.acquire(12 * 60 * 60 * 1000L /* 12 h */) }

            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm?.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "NXTslide::PresenterWifiLock"
            )?.also { it.acquire() }
        } catch (_: Exception) {}
    }

    // ─── MediaSession ─────────────────────────────────────────────────────────
    private fun setupMediaSession() {
        try {
            mediaSession = MediaSession(this, "NXTslidePresenter").apply {
                @Suppress("DEPRECATION")
                setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
                setCallback(object : MediaSession.Callback() {
                    override fun onSkipToNext() {
                        handleVolumeAdjust(1)
                        mainHandler.postDelayed({ handleVolumeAdjust(0) }, 50L)
                    }
                    override fun onSkipToPrevious() {
                        handleVolumeAdjust(-1)
                        mainHandler.postDelayed({ handleVolumeAdjust(0) }, 50L)
                    }
                    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                        val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                        }
                        if (keyEvent != null) {
                            val isVolUp = (keyEvent.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP || keyEvent.keyCode == android.view.KeyEvent.KEYCODE_MEDIA_NEXT)
                            val isVolDown = (keyEvent.keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN || keyEvent.keyCode == android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS)

                            if (isVolUp || isVolDown) {
                                if (keyEvent.action == android.view.KeyEvent.ACTION_DOWN) {
                                    if (keyEvent.repeatCount == 0) {
                                        handleVolumeAdjust(if (isVolUp) 1 else -1)
                                    }
                                    return true
                                } else if (keyEvent.action == android.view.KeyEvent.ACTION_UP) {
                                    handleVolumeAdjust(0)
                                    return true
                                }
                            }
                        }
                        return super.onMediaButtonEvent(mediaButtonIntent)
                    }
                })

                val volumeProvider = object : android.media.VolumeProvider(VOLUME_CONTROL_RELATIVE, 100, 50) {
                    override fun onAdjustVolume(direction: Int) {
                        android.util.Log.d("NXTslide_VolProv", "VolumeProvider onAdjustVolume: direction=$direction")
                        handleVolumeAdjust(direction)
                    }
                }
                setPlaybackToRemote(volumeProvider)

                setPlaybackState(
                    PlaybackState.Builder()
                        .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                        .setActions(
                            PlaybackState.ACTION_PLAY or
                            PlaybackState.ACTION_PAUSE or
                            PlaybackState.ACTION_SKIP_TO_NEXT or
                            PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        )
                        .build()
                )
                isActive = true
            }
        } catch (_: Exception) {}
    }

    // ─── Continuous Inaudible Audio Engine with AudioFocus ───────────────────
    private fun startContinuousAudio() {
        try {
            val sampleRate = 44100
            val minBufSize = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(2048)

            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()

            val format = AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build()

            // Request AudioFocus so Android routes hardware volume buttons to this app
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val focusRequest = android.media.AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener { /* keep rendering */ }
                    .build()
                audioFocusRequest = focusRequest
                audioManager?.requestAudioFocus(focusRequest)
            } else {
                @Suppress("DEPRECATION")
                audioManager?.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
            }

            val track = AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(minBufSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            audioTrack = track
            track.play()

            // Inaudible dither (+1, -1) prevents Audio DSP silence detection from entering power sleep
            val buffer = ShortArray(minBufSize / 2)
            for (i in buffer.indices) {
                buffer[i] = if (i % 2 == 0) 1 else -1
            }

            isAudioRunning = true
            audioThread = Thread({
                while (isAudioRunning) {
                    try {
                        track.write(buffer, 0, buffer.size)
                        Thread.sleep(40)
                    } catch (_: InterruptedException) {
                        break
                    } catch (_: Exception) {}
                }
            }, "NXTslide-AudioEngine").apply {
                isDaemon = true
                priority = Thread.NORM_PRIORITY
                start()
            }
        } catch (_: Exception) {}
    }

    // ─── ContentObserver (Dual Detection for Android 13/14 + Samsung/Xiaomi) ───
    private fun registerVolumeObserver() {
        try {
            volumeObserver = object : ContentObserver(mainHandler) {
                override fun onChange(selfChange: Boolean) {
                    super.onChange(selfChange)
                    if (suppressVolumeObserver) return
                    // Ignore if VolumeProvider recently handled an event
                    if (System.currentTimeMillis() - lastVolumeProviderTs < 2000L) return

                    val cur = audioManager?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: return
                    if (cur == midVolume) return // Ignore reset echo returning to midpoint

                    val isUp = cur > midVolume
                    handleVolumeAdjust(if (isUp) 1 else -1)
                    mainHandler.postDelayed({ handleVolumeAdjust(0) }, 80L)
                }
            }
            contentResolver.registerContentObserver(
                Settings.System.CONTENT_URI,
                true,
                volumeObserver!!
            )
        } catch (_: Exception) {}
    }

    // ─── BroadcastReceivers ───────────────────────────────────────────────────
    private fun registerVolumeReceiver() {
        val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // MUST BE RECEIVER_EXPORTED because android.media.VOLUME_CHANGED_ACTION is broadcast by Android OS
            registerReceiver(volumeReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(volumeReceiver, filter)
        }
        receiverRegistered = true
    }

    private fun registerActionReceiver() {
        val filter = IntentFilter().apply {
            addAction(ACTION_PREV)
            addAction(ACTION_NEXT)
            addAction(ACTION_STOP)
            addAction("com.nextpresent.remote.ACTION_START_LASER")
            addAction("com.nextpresent.remote.ACTION_STOP_LASER")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(actionReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(actionReceiver, filter)
        }
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────
    private fun connectWebSocket() {
        if (!isSessionActive) return
        try { webSocket?.close(1000, "Reconnecting") } catch (_: Exception) {}
        val wsUrl = buildWsUrl()
        android.util.Log.d("NXTslide_WS", "PresenterService connecting to: $wsUrl")
        val request = Request.Builder().url(wsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                android.util.Log.d("NXTslide_WS", "PresenterService WebSocket OPEN to $wsUrl")
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                android.util.Log.w("NXTslide_WS", "PresenterService WebSocket FAIL ($wsUrl): ${t.message}")
                if (isSessionActive) {
                    android.os.Handler(mainLooper).postDelayed({
                        if (isSessionActive) connectWebSocket()
                    }, 5000L)
                }
            }
        })
    }

    private fun buildWsUrl(): String {
        val code = relayRoomCode
        val androidId = android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID) ?: "companion_android"
        return if (code != null) {
            val wsBase = relayBaseUrl.replace("https://", "wss://").replace("http://", "ws://")
            "$wsBase/ws/$code/phone?deviceId=$androidId"
        } else {
            "ws://$serverIp:$serverPort/ws?role=companion_service&deviceId=$androidId"
        }
    }

    fun updateServerIp(ip: String, port: Int = 3333) {
        serverIp      = ip
        serverPort    = port
        relayRoomCode = null
        connectWebSocket()
    }

    fun updateRelayCode(code: String, baseUrl: String) {
        relayRoomCode = code
        relayBaseUrl  = baseUrl
        connectWebSocket()
    }

    fun sendSlideAction(action: String) {
        if (!isSessionActive) return
        val payload = JSONObject().apply {
            put("type",   "COMMAND")
            put("action", action)
            put("source", "Android Background Volume Key")
        }.toString()

        val sent = webSocket?.send(payload) ?: false
        android.util.Log.d("NXTslide_Action", "sendSlideAction: action=$action, sentViaWs=$sent")
        if (!sent) {
            // Immediate HTTP fallback — ensures zero lost clicks when screen is locked
            val code = relayRoomCode
            val targetUrl = if (code != null) {
                "$relayBaseUrl/api/rooms/$code/command"
            } else {
                "http://$serverIp:$serverPort/api/key"
            }

            val body = JSONObject()
                .put("action", action)
                .put("source", "Android Background Volume Key (HTTP Fallback)")
                .toString()
                .toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())

            client.newCall(
                Request.Builder()
                    .url(targetUrl)
                    .post(body)
                    .build()
            ).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {}
                override fun onResponse(call: Call, response: Response) { response.close() }
            })
        }
    }

    // ─── Vibration ────────────────────────────────────────────────────────────
    fun vibrateFeedback(ms: Long) {
        @Suppress("DEPRECATION")
        val vibrator = getSystemService(VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(ms)
        }
    }

    // ─── Notification ─────────────────────────────────────────────────────────
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "NXTslide Presenter",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Controls slides via volume buttons on lock screen"
                setShowBadge(false)
                setSound(null, null)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    private fun pendingBroadcast(action: String): PendingIntent {
        val intent = Intent(action).setPackage(packageName)
        return PendingIntent.getBroadcast(
            this, action.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("NXTslide — Presenter Active")
            .setContentText("🔊 Volume keys control slides (screen can be locked)")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openApp)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setSilent(true)
            .addAction(android.R.drawable.ic_media_previous, "◀ Prev", pendingBroadcast(ACTION_PREV))
            .addAction(android.R.drawable.ic_media_next,     "Next ▶", pendingBroadcast(ACTION_NEXT))
            .addAction(android.R.drawable.ic_delete,         "Stop",   pendingBroadcast(ACTION_STOP))
            .build()
    }

    private fun foregroundServiceTypeMediaPlayback(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) 2 else 0
    }
}
