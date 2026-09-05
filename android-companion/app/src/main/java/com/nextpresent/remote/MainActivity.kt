package com.nextpresent.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
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
    private var relayBaseUrl: String   = "https://nextpresent-relay.up.railway.app"

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
        val prefs = getSharedPreferences("nextPresentPrefs", Context.MODE_PRIVATE)
        serverIp      = prefs.getString("server_ip",   "192.168.101.9") ?: "192.168.101.9"
        serverPort    = prefs.getInt(  "server_port",  3333)
        relayRoomCode = prefs.getString("relay_room_code", null)
        relayBaseUrl  = prefs.getString("relay_base_url",
            "https://nextpresent-relay.up.railway.app") ?: "https://nextpresent-relay.up.railway.app"

        // Initialize Immersive Fullscreen WebView
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            setBackgroundColor(0xFF05070D.toInt())

            addJavascriptInterface(AndroidBridge(this@MainActivity), "AndroidApp")
            webViewClient = object : WebViewClient() {}
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

        // Load bundled asset (0 ms startup, no blank screen)
        webView.loadUrl("file:///android_asset/web/mobile.html")

        // If no relay code saved → launch ConnectActivity
        if (relayRoomCode == null) {
            launchConnectActivity()
        } else {
            connectWebSocket()
        }

        startAutoDiscovery()
        startPresenterService()
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
                if (!code.isNullOrBlank()) {
                    relayRoomCode = code
                    // prefs already saved inside ConnectActivity
                    connectWebSocket()
                    syncConnectionToService()
                    Toast.makeText(this, "☁️ Connected via cloud relay: $code", Toast.LENGTH_SHORT).show()
                }
            } else {
                // User chose LAN mode or cancelled
                relayRoomCode = null
                connectWebSocket()   // LAN fallback
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
                // Notify WebView
                webView.post {
                    webView.evaluateJavascript(
                        "if(typeof window.onServerConnected==='function') window.onServerConnected();", null)
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

                val data = "NEXTPRESENT_DISCOVER".toByteArray()
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
        getSharedPreferences("nextPresentPrefs", Context.MODE_PRIVATE)
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

    // ─── Volume keys (foreground — app visible) ────────────────────────────────
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_VOLUME_UP -> {
                    vibrateFeedback(35)
                    sendSlideAction("NEXT")
                    webView.post {
                        webView.evaluateJavascript(
                            "if(typeof window.onHardwareVolumeKey==='function') " +
                            "window.onHardwareVolumeKey('NEXT');", null)
                    }
                    return true
                }
                KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    vibrateFeedback(35)
                    sendSlideAction("PREV")
                    webView.post {
                        webView.evaluateJavascript(
                            "if(typeof window.onHardwareVolumeKey==='function') " +
                            "window.onHardwareVolumeKey('PREV');", null)
                    }
                    return true
                }
            }
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
    private fun vibrateFeedback(ms: Long) {
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
                    getSharedPreferences("nextPresentPrefs", Context.MODE_PRIVATE)
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

        @JavascriptInterface
        fun sendAction(action: String) {
            activity.sendSlideAction(action)
        }

        @JavascriptInterface
        fun getRoomCode(): String = activity.relayRoomCode ?: ""

        @JavascriptInterface
        fun isRelayMode(): Boolean = activity.relayRoomCode != null
    }
}

