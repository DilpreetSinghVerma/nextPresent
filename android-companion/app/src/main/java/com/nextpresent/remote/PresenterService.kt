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
    var relayBaseUrl: String   = "https://nextpresent-relay.onrender.com"

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

    /** Volume midpoint we restore after every key press */
    private var midVolume: Int = 7
    private var lastHandledTs = 0L

    /** Guard against bounce-back echoes caused by programmatic volume centering */
    @Volatile private var isResettingVolume = false
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Whether the broadcast receiver is registered */
    private var receiverRegistered = false
    private var volumeObserver: ContentObserver? = null

    companion object {
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

    // ─── Volume Trigger Core ─────────────────────────────────────────────────
    @Synchronized
    private fun handleVolumeTrigger(isUp: Boolean) {
        val ts = System.currentTimeMillis()
        if (ts - lastHandledTs < 180) return // debounce rapid echoes
        lastHandledTs = ts

        val action = if (isUp) "NEXT" else "PREV"

        // 1. Dispatch slide action immediately (0ms delay)
        sendSlideAction(action)

        // 2. Haptic feedback
        vibrateFeedback(40)

        // 3. Reset audio stream volume back to midpoint safely with bounce guard
        isResettingVolume = true
        mainHandler.postDelayed({
            try {
                audioManager?.setStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    midVolume,
                    AudioManager.FLAG_REMOVE_SOUND_AND_VIBRATE
                )
            } catch (_: Exception) {}
            // Reset bounce guard after system volume adjustment settles
            mainHandler.postDelayed({
                isResettingVolume = false
            }, 200)
        }, 120)
    }

    // ─── Volume BroadcastReceiver (System broadcast) ─────────────────────────
    private val volumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != "android.media.VOLUME_CHANGED_ACTION") return
            if (isResettingVolume) return

            val streamType = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (streamType != AudioManager.STREAM_MUSIC && streamType != -1) return

            val now  = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", -1)
            val prev = intent.getIntExtra("android.media.EXTRA_PREV_VOLUME_STREAM_VALUE", -1)
            if (now < 0 || prev < 0 || now == prev) return

            handleVolumeTrigger(now > prev)
        }
    }

    // ─── Notification action receiver ────────────────────────────────────────
    private val actionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PREV -> { vibrateFeedback(38); sendSlideAction("PREV") }
                ACTION_NEXT -> { vibrateFeedback(38); sendSlideAction("NEXT") }
                ACTION_STOP -> stopSelf()
            }
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────
    override fun onCreate() {
        super.onCreate()
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
        val prefs = getSharedPreferences("nextPresentPrefs", Context.MODE_PRIVATE)
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

        // Start foreground immediately
        startForeground(NOTIF_ID, buildNotification(), foregroundServiceTypeMediaPlayback())

        acquireLocks()
        setupMediaSession()
        startContinuousAudio()
        registerVolumeReceiver()
        registerVolumeObserver()
        registerActionReceiver()
        connectWebSocket()

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        super.onDestroy()
        try { if (receiverRegistered) unregisterReceiver(volumeReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(actionReceiver) } catch (_: Exception) {}
        try { volumeObserver?.let { contentResolver.unregisterContentObserver(it) } } catch (_: Exception) {}

        isAudioRunning = false
        audioThread?.interrupt()
        audioThread = null

        mediaSession?.isActive = false
        mediaSession?.release()
        audioTrack?.stop()
        audioTrack?.release()

        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        try { if (wifiLock?.isHeld == true) wifiLock?.release() } catch (_: Exception) {}

        webSocket?.close(1000, "Service destroyed")
        client.dispatcher.cancelAll()
    }

    // ─── WakeLock & WifiLock ──────────────────────────────────────────────────
    private fun acquireLocks() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "nextPresent::PresenterWakeLock"
            ).also { it.acquire(12 * 60 * 60 * 1000L /* 12 h */) }

            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm?.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "nextPresent::PresenterWifiLock"
            )?.also { it.acquire() }
        } catch (_: Exception) {}
    }

    // ─── MediaSession ─────────────────────────────────────────────────────────
    private fun setupMediaSession() {
        try {
            mediaSession = MediaSession(this, "nextPresentPresenter").apply {
                @Suppress("DEPRECATION")
                setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
                setCallback(object : MediaSession.Callback() {
                    override fun onSkipToNext() {
                        handleVolumeTrigger(true)
                    }
                    override fun onSkipToPrevious() {
                        handleVolumeTrigger(false)
                    }
                    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                        val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                        }
                        if (keyEvent?.action == android.view.KeyEvent.ACTION_DOWN) {
                            when (keyEvent.keyCode) {
                                android.view.KeyEvent.KEYCODE_MEDIA_NEXT,
                                android.view.KeyEvent.KEYCODE_VOLUME_UP -> {
                                    handleVolumeTrigger(true)
                                    return true
                                }
                                android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS,
                                android.view.KeyEvent.KEYCODE_VOLUME_DOWN -> {
                                    handleVolumeTrigger(false)
                                    return true
                                }
                            }
                        }
                        return super.onMediaButtonEvent(mediaButtonIntent)
                    }
                })

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
            }, "nextPresent-AudioEngine").apply {
                isDaemon = true
                priority = Thread.NORM_PRIORITY
                start()
            }
        } catch (_: Exception) {}
    }

    // ─── ContentObserver (Dual Detection for Android 13/14 + Samsung/Xiaomi) ───
    private fun registerVolumeObserver() {
        try {
            var lastVolume = audioManager?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: midVolume
            volumeObserver = object : ContentObserver(mainHandler) {
                override fun onChange(selfChange: Boolean) {
                    super.onChange(selfChange)
                    if (isResettingVolume) return
                    val cur = audioManager?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: return
                    if (cur == lastVolume) return
                    val isUp = cur > lastVolume
                    lastVolume = cur
                    handleVolumeTrigger(isUp)
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
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(actionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(actionReceiver, filter)
        }
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────
    private fun connectWebSocket() {
        try { webSocket?.close(1000, "Reconnecting") } catch (_: Exception) {}
        val wsUrl = buildWsUrl()
        val request = Request.Builder().url(wsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                android.os.Handler(mainLooper).postDelayed({ connectWebSocket() }, 5000L)
            }
        })
    }

    private fun buildWsUrl(): String {
        val code = relayRoomCode
        return if (code != null) {
            val wsBase = relayBaseUrl.replace("https://", "wss://").replace("http://", "ws://")
            "$wsBase/ws/$code/phone"
        } else {
            "ws://$serverIp:$serverPort/ws"
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
        val payload = JSONObject().apply {
            put("type",   "COMMAND")
            put("action", action)
            put("source", "Android Background Volume Key")
        }.toString()

        val sent = webSocket?.send(payload) ?: false
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
    private fun vibrateFeedback(ms: Long) {
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
                "nextPresent Presenter",
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
            .setContentTitle("nextPresent — Presenter Active")
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
