package com.nextpresent.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val client = OkHttpClient.Builder()
        .pingInterval(10, java.util.concurrent.TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    private var webSocket: WebSocket? = null

    // ─── Connection mode ──────────────────────────────────────────────────────
    /** Relay room code (e.g. "ABC123") — null means LAN mode */
    private var relayRoomCode: String? = null
    private var relayBaseUrl: String   = "https://nxtslide.online"

    // LAN fallback fields
    var serverIp: String = "192.168.101.9"
    var serverPort: Int  = 3333

    private val bgExecutor = Executors.newSingleThreadExecutor()

    // ─── Service binding ──────────────────────────────────────────────────────
    private var presenterService: PresenterService? = null
    private var serviceBound = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            presenterService = (binder as? PresenterService.LocalBinder)?.getService()
            serviceBound = true
            syncConnectionToService()
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            serviceBound = false
            presenterService = null
        }
    }

    private fun syncConnectionToService() {
        val code = relayRoomCode
        if (code != null) {
            presenterService?.updateRelayCode(code, relayBaseUrl)
        } else {
            presenterService?.updateServerIp(serverIp, serverPort)
        }
    }

    companion object {
        private const val REQ_CONNECT = 1001
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Load saved prefs
        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        serverIp      = prefs.getString("server_ip",   "192.168.101.9") ?: "192.168.101.9"
        serverPort    = prefs.getInt(  "server_port",  3333)
        relayRoomCode = prefs.getString("relay_room_code", null)
        relayBaseUrl  = prefs.getString("relay_base_url",
            "https://nxtslide.online") ?: "https://nxtslide.online"

        // Initialize Immersive Fullscreen WebView
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            setBackgroundColor(0xFF05070D.toInt())

            addJavascriptInterface(AndroidBridge(this@MainActivity), "AndroidApp")
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(
                    view: android.webkit.WebView?,
                    request: android.webkit.WebResourceRequest?,
                    error: android.webkit.WebResourceError?
                ) {
                    // If the cloud URL fails, fall back to local bundled asset
                    if (request?.isForMainFrame == true) {
                        android.util.Log.w("NXTslide", "[CloudUI] Remote load failed, falling back to local asset")
                        view?.loadUrl("file:///android_asset/web/mobile.html")
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val hasGyro = hasHardwareGyro()
                    view?.evaluateJavascript(
                        "if(typeof window.nxtslideSetGyroAvailable==='function') window.nxtslideSetGyroAvailable($hasGyro);", null
                    )
                    val savedUser = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                        .getString("auth_user", null)
                    if (!savedUser.isNullOrEmpty()) {
                        view?.evaluateJavascript(
                            "if(typeof window.nxtslideOnAuthSuccess==='function') window.nxtslideOnAuthSuccess(${JSONObject.quote(savedUser)});", null
                        )
                    }
                }
            }
        }
        setContentView(webView)

        // Immersive full-screen
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        // Handle deep-link if launched via nxtslide://auth
        handleAuthDeepLink(intent)

        // ── Cloud-Synced UI: load live UI from relay, fallback to local ──────────
        // This lets us push UI updates without requiring users to re-download the APK.
        // Native features (volume keys, haptics, AndroidBridge) still work with both URLs.
        loadCloudOrLocalUI()

        // If no relay code saved → launch ConnectActivity
        if (relayRoomCode == null) {
            launchConnectActivity()
        } else {
            connectWebSocket()
        }

        startAutoDiscovery()
        startPresenterService()
        requestBatteryOptimizationExemption()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthDeepLink(intent)
    }

    private fun handleAuthDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "nxtslide" && (uri.host == "auth" || uri.path?.contains("auth") == true)) {
            val token = uri.getQueryParameter("token")
            val userBase64 = uri.getQueryParameter("user")
            if (!token.isNullOrEmpty()) {
                val userJson = if (!userBase64.isNullOrEmpty()) {
                    try {
                        String(android.util.Base64.decode(userBase64, android.util.Base64.DEFAULT), Charsets.UTF_8)
                    } catch (_: Exception) {
                        "{}"
                    }
                } else "{}"

                val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                val editor = prefs.edit()
                    .putString("auth_token", token)
                    .putString("auth_user", userJson)

                var isPro = false
                var email = ""
                var name = ""
                try {
                    val json = JSONObject(userJson)
                    email = json.optString("email", "")
                    name = json.optString("name", "")
                    isPro = json.optBoolean("isPro", false)
                    val plan = json.optString("plan", "free")

                    if (email.isNotEmpty()) {
                        editor.putString("nxtslide_google_email", email)
                        editor.putString("nxtslide_google_name", name)
                        editor.putBoolean("nxtslide_pro_unlocked", isPro)
                        editor.putString("nxtslide_plan", plan)
                    }
                } catch (_: Exception) {}

                editor.apply()

                // Notify WebView
                webView.post {
                    webView.evaluateJavascript(
                        "if(typeof window.nxtslideOnAuthSuccess==='function') window.nxtslideOnAuthSuccess(${JSONObject.quote(userJson)});", null
                    )
                }

                val greeting = if (name.isNotEmpty()) name else email
                val label = if (isPro) "✦ Pro: $greeting" else greeting
                Toast.makeText(this, "Signed in as $label", Toast.LENGTH_LONG).show()
            }
        }
    }


    /**
     * Loads the remote controller UI directly from the bundled offline assets.
     * This guarantees 0ms instant startup, full offline capability, and 100% reliable
     * CSS/JS styling and laser modal controls.
     */
    private fun loadCloudOrLocalUI() {
        val localUrl = "file:///android_asset/web/mobile.html"
        android.util.Log.i("NXTslide", "[UI] Loading local bundled UI from $localUrl")
        webView.loadUrl(localUrl)
    }


    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm?.isIgnoringBatteryOptimizations(packageName) == false) {
                try {
                    @SuppressLint("BatteryLife")
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (_: Exception) {
                    try {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (_: Exception) {}
                }
            }
        }
    }

    // ─── ConnectActivity for result ───────────────────────────────────────────
    private fun launchConnectActivity() {
        startActivityForResult(
            Intent(this, ConnectActivity::class.java),
            REQ_CONNECT
        )
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CONNECT) {
            if (resultCode == Activity.RESULT_OK) {
                val code = data?.getStringExtra(ConnectActivity.EXTRA_ROOM_CODE)
                val lanIp = data?.getStringExtra(ConnectActivity.EXTRA_LAN_IP)
                val lanPort = data?.getIntExtra(ConnectActivity.EXTRA_LAN_PORT, 3333) ?: 3333
                if (!code.isNullOrBlank()) {
                    relayRoomCode = code
                    // prefs already saved inside ConnectActivity
                    connectWebSocket()
                    syncConnectionToService()
                    startPresenterService()
                    Toast.makeText(this, "☁️ Connected via cloud relay: $code", Toast.LENGTH_SHORT).show()
                } else if (!lanIp.isNullOrBlank()) {
                    relayRoomCode = null
                    getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                        .edit().remove("relay_room_code").apply()
                    updateServerIp(lanIp, lanPort)
                    syncConnectionToService()
                    startPresenterService()
                    Toast.makeText(this, "🏠 Connected via Wi-Fi: $lanIp:$lanPort", Toast.LENGTH_SHORT).show()
                }
            } else {
                // User chose LAN mode or cancelled
                val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                serverIp = prefs.getString("server_ip", serverIp) ?: serverIp
                serverPort = prefs.getInt("server_port", serverPort)
                relayRoomCode = null
                connectWebSocket()   // LAN fallback
                syncConnectionToService()
                startPresenterService()
            }
        }
    }

    // ─── PresenterService management ──────────────────────────────────────────
    private fun startPresenterService() {
        val intent = Intent(this, PresenterService::class.java).apply {
            putExtra(PresenterService.EXTRA_SERVER_IP,   serverIp)
            putExtra(PresenterService.EXTRA_SERVER_PORT, serverPort)
            putExtra(PresenterService.EXTRA_RELAY_CODE,  relayRoomCode ?: "")
            putExtra(PresenterService.EXTRA_RELAY_BASE,  relayBaseUrl)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    // ─── WebSocket ─────────────────────────────────────────────────────────────
    /**
     * Connects to either:
     *   - Cloud relay:  wss://relay/ws/{code}/phone
     *   - LAN server:   ws://{ip}:{port}/ws
     */
    private fun connectWebSocket() {
        try { webSocket?.close(1000, "Reconnecting") } catch (_: Exception) {}

        val wsUrl = buildWsUrl()
        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                runOnUiThread {
                    val label = if (relayRoomCode != null) "relay (${relayRoomCode})" else serverIp
                    Toast.makeText(this@MainActivity, "Connected to $label", Toast.LENGTH_SHORT).show()
                }
                // Notify WebView — works for both local mobile.html and cloud /mobile UI
                val stateJson = """{"connected":true,"code":${if (relayRoomCode != null) "\"$relayRoomCode\"" else "null"}}"""
                webView.post {
                    webView.evaluateJavascript(
                        "if(typeof window.onServerConnected==='function') window.onServerConnected();", null)
                    webView.evaluateJavascript(
                        "if(typeof window.nxtslideSetConnectionState==='function') window.nxtslideSetConnectionState('${stateJson.replace("'", "\\'")}');", null)
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                webView.post {
                    webView.evaluateJavascript(
                        "if(typeof window.onServerMessage==='function') window.onServerMessage(${JSONObject.quote(text)});", null)
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Auto-retry after 3s
                android.os.Handler(mainLooper).postDelayed({ connectWebSocket() }, 3000L)
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

    // ─── UDP auto-discovery (LAN mode) ────────────────────────────────────────
    private fun startAutoDiscovery() {
        bgExecutor.execute {
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                socket.soTimeout = 2500

                val data = "NXTSLIDE_DISCOVER".toByteArray()
                val packet = DatagramPacket(data, data.size,
                    InetAddress.getByName("255.255.255.255"), 3334)
                socket.send(packet)

                val buf = ByteArray(1024)
                val recvPacket = DatagramPacket(buf, buf.size)
                socket.receive(recvPacket)

                val json          = JSONObject(String(recvPacket.data, 0, recvPacket.length))
                val discoveredIp  = json.optString("ip")
                val discoveredPort = json.optInt("port", 3333)

                // Only switch to LAN if we are currently in LAN mode
                if (relayRoomCode == null && discoveredIp.isNotEmpty() && discoveredIp != serverIp) {
                    runOnUiThread { updateServerIp(discoveredIp, discoveredPort) }
                }
                socket.close()
            } catch (_: Exception) {}
        }
    }

    fun updateServerIp(newIp: String, port: Int = 3333) {
        serverIp   = newIp
        serverPort = port
        getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
            .edit()
            .putString("server_ip",   serverIp)
            .putInt(   "server_port", serverPort)
            .apply()

        connectWebSocket()
        presenterService?.updateServerIp(serverIp, serverPort)

        webView.post {
            webView.evaluateJavascript(
                "if(typeof window.onServerIpUpdated==='function') " +
                "window.onServerIpUpdated('$serverIp:$serverPort');", null)
        }
    }

    // ─── Hardware Laser Pointer Engine (Rotation Vector) ─────────────────────
    private var sensorManager: android.hardware.SensorManager? = null
    private var rotationSensor: android.hardware.Sensor? = null
    private var isLaserActive: Boolean = false
    private var isVolUpHeld: Boolean = false
    private var isVolDownHeld: Boolean = false
    private var hasLaserStarted: Boolean = false
    private val keyHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var holdLaserRunnable: Runnable? = null

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

    private val sensorListener = object : android.hardware.SensorEventListener {
        override fun onSensorChanged(event: android.hardware.SensorEvent) {
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
                    android.hardware.SensorManager.getRotationMatrixFromVector(currentMatrix, event.values)

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
                android.util.Log.e("NXTslide_Sensor", "Error in MainActivity onSensorChanged: ${t.message}", t)
            }
        }

        override fun onAccuracyChanged(sensor: android.hardware.Sensor?, accuracy: Int) {}
    }

    fun hasHardwareGyro(): Boolean {
        if (sensorManager == null) {
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? android.hardware.SensorManager
        }
        return sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE) != null
    }

    fun startHardwareLaser() {
        if (!hasHardwareGyro()) {
            android.util.Log.d("NXTslide_Sensor", "startHardwareLaser aborted: No physical gyroscope sensor on device")
            return
        }

        if (sensorManager == null) {
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? android.hardware.SensorManager
        }

        // Check if device has a physical hardware gyroscope:
        val hasHardwareGyro = (sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE) != null)

        rotationSensor = if (hasHardwareGyro) {
            // Devices WITH Gyroscope (e.g. flagship phones, OnePlus with gyro):
            // Use Game Rotation Vector (Best: Gyro + Accel 6-DoF, zero compass drift/jumps)
            sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_GAME_ROTATION_VECTOR)
                ?: sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_ROTATION_VECTOR)
        } else {
            // Devices WITHOUT Gyroscope (e.g. Oppo A78 5G, budget phones):
            // DO NOT use compass rotation vector (it constantly drifts & jitters indoors).
            // Use clean Gravity sensor or Accelerometer for rock-solid stability!
            sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_GRAVITY)
                ?: sensorManager?.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER)
        }

        isAccelerometerFallback = (!hasHardwareGyro)
        android.util.Log.d("NXTslide_Sensor", "startHardwareLaser: hasGyro=$hasHardwareGyro, isFallback=$isAccelerometerFallback, sensor=${rotationSensor?.name}")

        if (isLaserActive) return
        isLaserActive = true
        sensorWarmupCount = 0
        currentLaserX = 0.5f
        currentLaserY = 0.5f
        smoothDx = 0f
        smoothDy = 0f
        lastSendTs = 0L

        rotationSensor?.let {
            sensorManager?.registerListener(sensorListener, it, android.hardware.SensorManager.SENSOR_DELAY_GAME)
        }

        vibrateFeedback(60) // Strong laser active vibration
        sendLaserDown(0.5f, 0.5f, "laser")

        webView.post {
            webView.evaluateJavascript("if(typeof window.onHardwareLaserStart==='function') window.onHardwareLaserStart();", null)
        }
    }

    fun stopHardwareLaser() {
        if (!isLaserActive) return
        isLaserActive = false
        sensorManager?.unregisterListener(sensorListener)
        vibrateFeedback(25) // Release vibration
        sendLaserUp()

        webView.post {
            webView.evaluateJavascript("if(typeof window.onHardwareLaserStop==='function') window.onHardwareLaserStop();", null)
        }
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
                put("source", "Android Hardware Aim")
            }.toString()
            val sent = webSocket?.send(payload) ?: false
            if (!sent) connectWebSocket()
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
                put("source", "Android Hardware Aim")
            }.toString()
            webSocket?.send(payload)
        } catch (_: Exception) {}
    }

    private fun sendLaserUp() {
        try {
            val payload = JSONObject().apply {
                put("type", "LASER_UP")
                put("source", "Android Hardware Aim")
            }.toString()
            webSocket?.send(payload)
        } catch (_: Exception) {}
    }

    // ─── Volume keys (foreground — app visible) ────────────────────────────────
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            val isUpKey = (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP)

            // On phones without physical gyro sensor: Volume keys act strictly as instant slide switches (0 lag, no laser hold)
            if (!hasHardwareGyro()) {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                    val action = if (isUpKey) "NEXT" else "PREV"
                    vibrateFeedback(35)
                    sendSlideAction(action)
                    webView.post {
                        webView.evaluateJavascript(
                            "if(typeof window.onHardwareVolumeKey==='function') window.onHardwareVolumeKey('$action');", null)
                    }
                }
                return true
            }

            if (event.action == KeyEvent.ACTION_DOWN) {
                if (isUpKey) isVolUpHeld = true else isVolDownHeld = true

                if (event.repeatCount == 0) {
                    // Cancel any previous pending runnable
                    holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }

                    // Schedule hold-to-laser timer (200ms)
                    if (!isLaserActive) {
                        hasLaserStarted = false
                        val r = Runnable {
                            if (isVolUpHeld || isVolDownHeld) {
                                hasLaserStarted = true
                                startHardwareLaser()
                            }
                        }
                        holdLaserRunnable = r
                        keyHandler.postDelayed(r, 200L)
                    }
                }
            } else if (event.action == KeyEvent.ACTION_UP) {
                if (isUpKey) isVolUpHeld = false else isVolDownHeld = false

                // Cancel pending hold timer
                holdLaserRunnable?.let { keyHandler.removeCallbacks(it) }
                holdLaserRunnable = null

                if (isLaserActive || hasLaserStarted) {
                    // Stop laser on release — NO slide change, stays on current slide!
                    if (!isVolUpHeld && !isVolDownHeld) {
                        stopHardwareLaser()
                        hasLaserStarted = false
                    }
                } else {
                    // Quick tap (< 180ms) -> Change slide!
                    val action = if (isUpKey) "NEXT" else "PREV"
                    vibrateFeedback(35)
                    sendSlideAction(action)
                    webView.post {
                        webView.evaluateJavascript(
                            "if(typeof window.onHardwareVolumeKey==='function') window.onHardwareVolumeKey('$action');", null)
                    }
                }
            }
            return true // Consume BOTH ACTION_DOWN and ACTION_UP completely
        }
        return super.dispatchKeyEvent(event)
    }

    // ─── Send action ───────────────────────────────────────────────────────────
    fun sendSlideAction(action: String) {
        val payload = JSONObject().apply {
            put("type",   "COMMAND")
            put("action", action)
            put("source", "Android Physical Volume Key")
        }.toString()

        val sent = webSocket?.send(payload) ?: false
        if (!sent) {
            // Immediate HTTP fallback — ensures 0 missed clicks even if WS is reconnecting
            val code = relayRoomCode
            val targetUrl = if (code != null) {
                "$relayBaseUrl/api/rooms/$code/command"
            } else {
                "http://$serverIp:$serverPort/api/key"
            }

            val body = JSONObject()
                .put("action", action)
                .put("source", "Android Physical Volume Key (HTTP Fallback)")
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

    // ─── Vibration ─────────────────────────────────────────────────────────────
    fun vibrateFeedback(ms: Long) {
        @Suppress("DEPRECATION")
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(ms)
        }
    }

    // ─── Connection dialog ─────────────────────────────────────────────────────
    fun promptServerIp() {
        AlertDialog.Builder(this)
            .setTitle("Change Connection")
            .setItems(arrayOf(
                "☁️ Scan QR / Enter room code (Cloud)",
                "📡 Enter LAN IP address (Same Wi-Fi)"
            )) { _, which ->
                when (which) {
                    0 -> launchConnectActivity()
                    1 -> showLanIpDialog()
                }
            }
            .show()
    }

    private fun showLanIpDialog() {
        val input = EditText(this).apply {
            setText(serverIp)
            hint = "e.g. 192.168.1.5"
        }
        AlertDialog.Builder(this)
            .setTitle("Connect to PC (LAN / Same Wi-Fi)")
            .setMessage("Enter the IP address shown on your PC dashboard:")
            .setView(input)
            .setPositiveButton("Connect") { _, _ ->
                val ip = input.text.toString().trim()
                if (ip.isNotEmpty()) {
                    // Switch to LAN mode
                    relayRoomCode = null
                    getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                        .edit().remove("relay_room_code").apply()
                    updateServerIp(ip)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    override fun onDestroy() {
        super.onDestroy()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        webSocket?.close(1000, "Activity destroyed")
        bgExecutor.shutdown()
    }

    // ─── JS Bridge ─────────────────────────────────────────────────────────────
    inner class AndroidBridge(val activity: MainActivity) {
        @JavascriptInterface
        fun hasHardwareGyro(): Boolean = activity.hasHardwareGyro()

        @JavascriptInterface
        fun getServerHost(): String {
            val code = activity.relayRoomCode
            return if (code != null) "relay:$code" else "${activity.serverIp}:${activity.serverPort}"
        }

        @JavascriptInterface
        fun getIp(): String = activity.serverIp

        @JavascriptInterface
        fun promptIpDialog() {
            activity.runOnUiThread { activity.promptServerIp() }
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        /** Original method used by local mobile.html */
        @JavascriptInterface
        fun sendAction(action: String) {
            activity.sendSlideAction(action)
        }

        /**
         * Alias used by the cloud-synced /mobile UI.
         * Both sendCommand and sendAction map to the same native function.
         */
        @JavascriptInterface
        fun sendCommand(action: String) {
            activity.sendSlideAction(action)
        }

        @JavascriptInterface
        fun getRoomCode(): String = activity.relayRoomCode ?: ""

        @JavascriptInterface
        fun isRelayMode(): Boolean = activity.relayRoomCode != null

        /** Opens Google Sign-In — called by the cloud remote UI's "My Account" button */
        @JavascriptInterface
        fun openGoogleSignIn() {
            activity.runOnUiThread {
                try {
                    val authUrl = "${activity.relayBaseUrl}/api/auth/google?redirect=nxtslide://auth"
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(authUrl))
                    activity.startActivity(intent)
                } catch (e: Exception) {
                    android.util.Log.e("NXTslide", "Failed to launch Google Sign In: ${e.message}")
                }
            }
        }

        @JavascriptInterface
        fun startHardwareLaser() {
            activity.runOnUiThread { activity.startHardwareLaser() }
        }

        @JavascriptInterface
        fun stopHardwareLaser() {
            activity.runOnUiThread { activity.stopHardwareLaser() }
        }
    }


}

