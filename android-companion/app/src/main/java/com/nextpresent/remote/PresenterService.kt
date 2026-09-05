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
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/**
 * PresenterService — Foreground service that keeps the app alive when the
 * screen is locked and intercepts physical volume key presses via
 * VOLUME_CHANGED_ACTION broadcast, routing them as NEXT / PREV slide commands.
 *
 * How it works:
 *  1. Holds a PARTIAL_WAKE_LOCK so the CPU (and Wi-Fi) stays alive.
 *  2. Plays a truly-silent AudioTrack loop → Android treats the app as an
 *     active media player, so volume-button presses route to STREAM_MUSIC
 *     even on the lock screen.
 *  3. BroadcastReceiver on "android.media.VOLUME_CHANGED_ACTION" detects
 *     every rocker press, compares new vs old stream volume, decides NEXT/PREV,
 *     then immediately resets the volume back to the midpoint so the device
 *     audio level is never actually changed.
 *  4. Sends NEXT / PREV over an OkHttp WebSocket (or HTTP POST fallback).
 *  5. Shows a persistent lock-screen notification with ◀ Prev / Next ▶ buttons.
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
    private var audioTrack: AudioTrack? = null
    private var audioManager: AudioManager? = null

    /** Volume midpoint we restore after every key press */
    private var midVolume: Int = 7

    /** Whether the broadcast receiver is registered */
    private var receiverRegistered = false

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

    // ─── Volume BroadcastReceiver ─────────────────────────────────────────────
    private val volumeReceiver = object : BroadcastReceiver() {
        private var lastReset = 0L   // debounce timestamp

        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != "android.media.VOLUME_CHANGED_ACTION") return

            val streamType = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (streamType != AudioManager.STREAM_MUSIC) return

            val now       = intent.getIntExtra("android.media.EXTRA_VOLUME_STREAM_VALUE", -1)
            val prev      = intent.getIntExtra("android.media.EXTRA_PREV_VOLUME_STREAM_VALUE", -1)
            if (now < 0 || prev < 0 || now == prev) return

            // Debounce: ignore our own setStreamVolume echo (~150 ms window)
            val ts = System.currentTimeMillis()
            if (ts - lastReset < 150) return

            val action = if (now > prev) "NEXT" else "PREV"

            // 1. DISPATCH SLIDE ACTION FIRST (0 ms delay — on wire before IPC)
            sendSlideAction(action)

            // 2. Immediate haptic feedback
            vibrateFeedback(38)

            // 3. Reset midpoint volume (so system audio level stays unchanged)
            lastReset = ts
            audioManager?.setStreamVolume(
                AudioManager.STREAM_MUSIC,
                midVolume,
                AudioManager.FLAG_REMOVE_SOUND_AND_VIBRATE  // no popup, no beep
            )
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
        // Update connection config from caller intent
        intent?.let {
            serverIp      = it.getStringExtra(EXTRA_SERVER_IP)   ?: serverIp
            serverPort    = it.getIntExtra(EXTRA_SERVER_PORT, serverPort)
            val code      = it.getStringExtra(EXTRA_RELAY_CODE)
            relayRoomCode = if (code.isNullOrBlank()) null else code
            relayBaseUrl  = it.getStringExtra(EXTRA_RELAY_BASE) ?: relayBaseUrl
        }

        // Start foreground immediately (Android 14 requires this before any heavy work)
        startForeground(NOTIF_ID, buildNotification(), foregroundServiceTypeMediaPlayback())

        acquireWakeLock()
        startSilentAudio()
        registerVolumeReceiver()
        registerActionReceiver()
        connectWebSocket()

        // Calculate mid-volume for current device
        val maxVol = audioManager?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 15
        midVolume  = maxVol / 2

        return START_STICKY  // restart if killed
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        super.onDestroy()
        try { if (receiverRegistered) unregisterReceiver(volumeReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(actionReceiver) } catch (_: Exception) {}
        audioTrack?.stop()
        audioTrack?.release()
        wakeLock?.release()
        webSocket?.close(1000, "Service destroyed")
        client.dispatcher.cancelAll()
    }

    // ─── WakeLock ─────────────────────────────────────────────────────────────
    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "nextPresent::PresenterWakeLock"
        ).also { it.acquire(8 * 60 * 60 * 1000L /* 8 h */) }
    }

    // ─── Silent AudioTrack ────────────────────────────────────────────────────
    /**
     * Plays a 1-frame silent PCM loop.  This tells Android's audio subsystem
     * the app has an active STREAM_MUSIC session → volume keys always target
     * STREAM_MUSIC even on the lock screen, enabling our BroadcastReceiver.
     */
    private fun startSilentAudio() {
        try {
            val sampleRate  = 8000
            val minBufSize  = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_8BIT
            ).coerceAtLeast(256)

            // All zeros → completely silent
            val silence = ByteArray(minBufSize)

            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()

            val format = AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setEncoding(AudioFormat.ENCODING_PCM_8BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build()

            audioTrack = AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(minBufSize)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build().also { track ->
                    track.write(silence, 0, silence.size)
                    track.setLoopPoints(0, minBufSize / 2, -1)   // loop forever
                    track.play()
                }
        } catch (e: Exception) {
            // Silent audio failed (some emulators) — volume receiver still works
            // when screen is on; background behavior may be limited
        }
    }

    // ─── Receivers ────────────────────────────────────────────────────────────
    private fun registerVolumeReceiver() {
        val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(volumeReceiver, filter, RECEIVER_NOT_EXPORTED)
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
            registerReceiver(actionReceiver, filter, RECEIVER_NOT_EXPORTED)
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
                // Auto-retry after 8s
                android.os.Handler(mainLooper).postDelayed({ connectWebSocket() }, 8000L)
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
        relayRoomCode = null   // switch to LAN mode
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
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)   // show on lock screen
            .setOngoing(true)
            .setSilent(true)
            // Lock-screen action buttons
            .addAction(android.R.drawable.ic_media_previous, "◀ Prev",
                pendingBroadcast(ACTION_PREV))
            .addAction(android.R.drawable.ic_media_next,     "Next ▶",
                pendingBroadcast(ACTION_NEXT))
            .addAction(android.R.drawable.ic_delete,         "Stop",
                pendingBroadcast(ACTION_STOP))
            .build()
    }

    /** Returns the correct foreground service type constant for API level */
    private fun foregroundServiceTypeMediaPlayback(): Int {
        // android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK = 2
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) 2 else 0
    }
}
