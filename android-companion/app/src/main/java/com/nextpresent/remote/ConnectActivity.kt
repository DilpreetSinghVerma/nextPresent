package com.nextpresent.remote

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import okhttp3.*
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * ConnectActivity — Shown on first launch (or when no saved relay code exists).
 *
 * Workflow:
 *  1. Camera viewfinder scans QR codes from the PC dashboard in real time.
 *  2. User can also type a 6-char code (e.g. ABC123) manually.
 *  3. On Connect the relay server is validated, code saved to prefs, then
 *     the activity finishes so MainActivity resumes (or starts) in relay mode.
 *
 * Deep-link: When the QR URL (https://relay/r/ABC123) is opened, Android
 * Intent filters in the manifest can also launch this activity pre-filled.
 */
class ConnectActivity : AppCompatActivity() {

    companion object {
        const val CAMERA_PERMISSION_CODE = 1001
        const val RELAY_BASE = "https://nxtslide.online"

        /** Key used to pass validated room code back to caller */
        const val EXTRA_ROOM_CODE = "room_code"
        /** Key used to pass validated local IP back to caller */
        const val EXTRA_LAN_IP    = "lan_ip"
        /** Key used to pass validated local port back to caller */
        const val EXTRA_LAN_PORT  = "lan_port"
    }

    private lateinit var cameraPreview: PreviewView
    private lateinit var etRoomCode: EditText
    private lateinit var btnConnect: Button
    private lateinit var btnLanMode: Button
    private lateinit var tvStatus: TextView
    private lateinit var btnTabLocal: Button
    private lateinit var btnTabCloud: Button
    private var currentMode = "local"

    private lateinit var cameraExecutor: ExecutorService
    private val httpClient = OkHttpClient()

    private var scannedCode: String? = null   // code extracted from QR
    private var connecting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Handle deep link if launched via nxtslide://auth?token=...
        handleAuthDeepLink(intent)

        // 2. If launched from room deep link (nextpresent://connect?code=ABC123)
        val deepCode = intent?.data?.getQueryParameter("code")
            ?: intent?.getStringExtra(EXTRA_ROOM_CODE)

        // If activity was started with a pre-filled code, handle it directly
        if (!deepCode.isNullOrBlank()) {
            connectWithCode(deepCode.uppercase().replace("-", ""))
            return
        }

        setContentView(R.layout.activity_connect)

        cameraPreview = findViewById(R.id.cameraPreview)
        etRoomCode    = findViewById(R.id.etRoomCode)
        btnConnect    = findViewById(R.id.btnConnect)
        btnLanMode    = findViewById(R.id.btnLanMode)
        tvStatus      = findViewById(R.id.tvStatus)
        btnTabLocal   = findViewById(R.id.btnTabLocal)
        btnTabCloud   = findViewById(R.id.btnTabCloud)

        cameraExecutor = Executors.newSingleThreadExecutor()

        updateProBadgeUI()

        btnTabLocal.setOnClickListener { switchMode("local") }
        btnTabCloud.setOnClickListener {
            val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
            val isPro = prefs.getBoolean("nxtslide_pro_unlocked", false)
            if (isPro) {
                switchMode("cloud")
            } else {
                showProPaywallDialog()
            }
        }

        requestCameraOrStart()
        checkForAppUpdate()

        // Auto-format as user types in cloud mode (insert dash after 3 chars)
        etRoomCode.addTextChangedListener(object : TextWatcher {
            private var editing = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(e: Editable?) {
                if (editing || currentMode != "cloud") return
                editing = true
                val raw = e.toString().uppercase().replace("-", "").take(6)
                val formatted = if (raw.length > 3) "${raw.take(3)}-${raw.drop(3)}" else raw
                e?.replace(0, e.length, formatted)
                editing = false
            }
        })

        etRoomCode.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                attemptConnect(); true
            } else false
        }

        btnConnect.setOnClickListener { attemptConnect() }

        btnLanMode.setOnClickListener {
            switchMode("local")
        }

        // Initialize default mode to Local (Free)
        switchMode("local")
    }

    // ─── Camera permission ────────────────────────────────────────────────────
    private fun requestCameraOrStart() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CAMERA),
                CAMERA_PERMISSION_CODE
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERMISSION_CODE &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            tvStatus.text = "Camera permission denied — type the code manually"
        }
    }

    // ─── CameraX + ML Kit QR scanning ────────────────────────────────────────
    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(cameraPreview.surfaceProvider)
            }

            val imageAnalyzer = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { analysis ->
                    analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                        processQrFrame(imageProxy)
                    }
                }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageAnalyzer
                )
            } catch (e: Exception) {
                tvStatus.text = "Camera init failed: ${e.message}"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun processQrFrame(imageProxy: androidx.camera.core.ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }

        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        val scanner = BarcodeScanning.getClient()

        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                for (barcode in barcodes) {
                    if (barcode.format == Barcode.FORMAT_QR_CODE) {
                        val raw = barcode.rawValue?.trim() ?: continue

                        // 1. Check if it's a Local LAN URL (e.g. http://172.16.54.48:3333/remote)
                        val lanPattern = Regex("""https?://([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(?::([0-9]+))?(?:/.*)?""", RegexOption.IGNORE_CASE)
                        val lanMatch = lanPattern.find(raw)
                        if (lanMatch != null) {
                            val ip = lanMatch.groupValues[1]
                            val port = lanMatch.groupValues[2].toIntOrNull() ?: 3333
                            if (ip != scannedCode) {
                                scannedCode = ip
                                runOnUiThread {
                                    switchMode("local")
                                    etRoomCode.setText(ip)
                                    tvStatus.text = "📸 Local Wi-Fi QR scanned! Connecting…"
                                    connectWithLanIp(ip, port)
                                }
                            }
                            return@addOnSuccessListener
                        }

                        // 2. Check if it's a Cloud Relay room URL or 6-letter room code
                        val code = extractCode(raw)
                        if (!code.isNullOrBlank() && code != scannedCode) {
                            scannedCode = code
                            runOnUiThread {
                                switchMode("cloud")
                                val formatted = if (code.length == 6)
                                    "${code.take(3)}-${code.drop(3)}" else code
                                etRoomCode.setText(formatted)
                                tvStatus.text = "📸 Cloud QR scanned! Connecting…"
                                connectWithCode(code)
                            }
                            return@addOnSuccessListener
                        }
                    }
                }
            }
            .addOnCompleteListener { imageProxy.close() }
    }

    private fun extractCode(url: String): String? {
        // Pattern: /r/{CODE} or ?code={CODE}
        val codePattern = Regex("""[/?](?:r/|code=)([A-Z0-9]{6})""", RegexOption.IGNORE_CASE)
        val match = codePattern.find(url)
        if (match != null) return match.groupValues[1].uppercase()

        // Direct 6-char code input
        val clean = url.trim().uppercase().replace("-", "").replace(" ", "")
        if (clean.length == 6 && clean.all { it.isLetterOrDigit() }) return clean

        return null
    }

    // ─── Connect logic ────────────────────────────────────────────────────────
    private fun attemptConnect() {
        val input = etRoomCode.text.toString().trim()
        if (currentMode == "local") {
            val clean = input.replace("http://", "").replace("https://", "").split("/")[0]
            val parts = clean.split(":")
            val ip = parts[0].trim()
            val port = if (parts.size > 1) parts[1].toIntOrNull() ?: 3333 else 3333

            val ipRegex = Regex("""^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$""")
            if (!ipRegex.matches(ip)) {
                tvStatus.text = "⚠ Enter a valid PC IP address (e.g. 172.16.54.48)"
                return
            }
            connectWithLanIp(ip, port)
        } else {
            val raw = input.uppercase().replace("-", "").trim()
            if (raw.length != 6) {
                tvStatus.text = "⚠ Enter a 6-character code (e.g. ABC-123)"
                return
            }
            connectWithCode(raw)
        }
    }

    private fun connectWithLanIp(ip: String, port: Int) {
        if (connecting) return
        connecting = true

        runOnUiThread {
            btnConnect.isEnabled = false
            tvStatus.text = "⏳ Connecting to PC at $ip:$port…"
        }

        val request = Request.Builder()
            .url("http://$ip:$port/health")
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                connecting = false
                runOnUiThread {
                    btnConnect.isEnabled = true
                    val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                    prefs.edit()
                        .putString("server_ip", ip)
                        .putInt("server_port", port)
                        .remove("relay_room_code")
                        .apply()

                    Toast.makeText(this@ConnectActivity, "Connecting to $ip:$port…", Toast.LENGTH_SHORT).show()
                    val result = Intent().apply {
                        putExtra(EXTRA_LAN_IP, ip)
                        putExtra(EXTRA_LAN_PORT, port)
                    }
                    setResult(RESULT_OK, result)
                    finish()
                }
            }

            override fun onResponse(call: Call, response: Response) {
                connecting = false
                response.close()

                val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                prefs.edit()
                    .putString("server_ip", ip)
                    .putInt("server_port", port)
                    .remove("relay_room_code")
                    .apply()

                runOnUiThread {
                    Toast.makeText(this@ConnectActivity, "✅ Connected to PC at $ip!", Toast.LENGTH_SHORT).show()
                }

                val result = Intent().apply {
                    putExtra(EXTRA_LAN_IP, ip)
                    putExtra(EXTRA_LAN_PORT, port)
                }
                setResult(RESULT_OK, result)
                finish()
            }
        })
    }

    private fun connectWithCode(code: String) {
        if (connecting) return
        connecting = true

        runOnUiThread {
            btnConnect.isEnabled = false
            tvStatus.text = "⏳ Validating room code…"
        }

        // Verify code exists on relay
        val request = Request.Builder()
            .url("$RELAY_BASE/api/rooms/${code.uppercase()}")
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                connecting = false
                runOnUiThread {
                    btnConnect.isEnabled = true
                    tvStatus.text = "❌ Cannot reach relay server. Check internet."
                }
            }

            override fun onResponse(call: Call, response: Response) {
                connecting = false
                val body = response.body?.string() ?: ""
                response.close()

                if (!response.isSuccessful) {
                    runOnUiThread {
                        btnConnect.isEnabled = true
                        tvStatus.text = "❌ Room not found. Check the code and try again."
                    }
                    return
                }

                val json = runCatching { JSONObject(body) }.getOrNull()
                val exists = json?.optBoolean("exists", false) ?: false

                if (!exists) {
                    runOnUiThread {
                        btnConnect.isEnabled = true
                        tvStatus.text = "❌ Room expired or not found."
                    }
                    return
                }

                // ✅ Valid code — save to prefs and return to MainActivity
                val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                prefs.edit()
                    .putString("relay_room_code", code.uppercase())
                    .putString("relay_base_url", RELAY_BASE)
                    .apply()

                runOnUiThread {
                    Toast.makeText(this@ConnectActivity, "✅ Connected! Starting remote…", Toast.LENGTH_SHORT).show()
                }

                val result = Intent().putExtra(EXTRA_ROOM_CODE, code.uppercase())
                setResult(RESULT_OK, result)
                finish()
            }
        })
    }

    // ─── App Update Check ──────────────────────────────────────────────────
    private fun checkForAppUpdate() {
        val request = Request.Builder()
            .url("$RELAY_BASE/api/version")
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // Silently ignore network failures on startup
            }

            override fun onResponse(call: Call, response: Response) {
                if (!response.isSuccessful) {
                    response.close()
                    return
                }
                val body = response.body?.string() ?: return
                response.close()

                try {
                    val json = JSONObject(body)
                    val androidObj = json.optJSONObject("android") ?: return
                    val latestVersionName = androidObj.optString("versionName", "")
                    val apkUrl = androidObj.optString("apkUrl", "")

                    val currentVersion = try {
                        packageManager.getPackageInfo(packageName, 0).versionName
                    } catch (e: Exception) {
                        "1.0.0"
                    }

                    if (latestVersionName.isNotBlank() && isVersionNewer(latestVersionName, currentVersion)) {
                        runOnUiThread {
                            showUpdateDialog(latestVersionName, apkUrl)
                        }
                    }
                } catch (e: Exception) {
                    // Ignore JSON parse errors
                }
            }
        })
    }

    private fun isVersionNewer(latest: String, current: String): Boolean {
        val lParts = latest.trimStart('v').split(".").mapNotNull { it.toIntOrNull() }
        val cParts = current.trimStart('v').split(".").mapNotNull { it.toIntOrNull() }
        for (i in 0 until maxOf(lParts.size, cParts.size)) {
            val l = lParts.getOrElse(i) { 0 }
            val c = cParts.getOrElse(i) { 0 }
            if (l > c) return true
            if (l < c) return false
        }
        return false
    }

    private fun showUpdateDialog(latestVersion: String, downloadUrl: String) {
        if (isFinishing || isDestroyed) return
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("✨ Update Available")
            .setMessage("NXTslide v$latestVersion is available. Would you like to update now?")
            .setPositiveButton("Update Now") { _, _ ->
                val targetUrl = if (downloadUrl.isNotBlank()) downloadUrl else "$RELAY_BASE/downloads/NXTslide.apk"
                val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(targetUrl))
                startActivity(intent)
            }
            .setNegativeButton("Later", null)
            .show()
    }

    // ─── Pro Mode & Account ────────────────────────────────────────────
    private fun updateProBadgeUI() {
        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        val isPro = prefs.getBoolean("nxtslide_pro_unlocked", false)
        val email = prefs.getString("nxtslide_google_email", "") ?: ""
        if (isPro) {
            btnTabCloud.text = "☁️ Cloud (PRO ✓)"
        } else if (email.isNotEmpty()) {
            btnTabCloud.text = "☁️ Cloud (Sign In 🔒)"
        } else {
            btnTabCloud.text = "☁️ Cloud (PRO 🔒)"
        }
    }

    private fun switchMode(mode: String) {
        currentMode = mode
        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        if (mode == "local") {
            btnTabLocal.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
            btnTabLocal.setTextColor(android.graphics.Color.WHITE)
            btnTabCloud.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            btnTabCloud.setTextColor(android.graphics.Color.parseColor("#94A3B8"))

            findViewById<TextView>(R.id.tvScanHint).text = "Point camera at Local Wi-Fi QR on PC"
            findViewById<TextView>(R.id.tvOr).text = "— or enter PC IP address manually —"

            etRoomCode.hint = "e.g. 172.16.54.48"
            etRoomCode.letterSpacing = 0.04f
            etRoomCode.inputType = InputType.TYPE_CLASS_PHONE
            etRoomCode.filters = arrayOf(InputFilter.LengthFilter(30))

            val savedIp = prefs.getString("server_ip", "") ?: ""
            if (savedIp.isNotEmpty()) {
                etRoomCode.setText(savedIp)
                etRoomCode.setSelection(savedIp.length)
            } else {
                etRoomCode.setText("")
            }

            btnConnect.text = "Connect via Wi-Fi"
            tvStatus.text = ""
        } else {
            btnTabCloud.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
            btnTabCloud.setTextColor(android.graphics.Color.WHITE)
            btnTabLocal.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            btnTabLocal.setTextColor(android.graphics.Color.parseColor("#94A3B8"))

            findViewById<TextView>(R.id.tvScanHint).text = "Point camera at Cloud QR on PC"
            findViewById<TextView>(R.id.tvOr).text = "— or enter 6-letter room code —"

            etRoomCode.hint = "e.g. ABC-123"
            etRoomCode.letterSpacing = 0.15f
            etRoomCode.inputType = InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            etRoomCode.filters = arrayOf(InputFilter.LengthFilter(7))

            val savedCode = prefs.getString("relay_room_code", "") ?: ""
            if (savedCode.isNotEmpty()) {
                val formatted = if (savedCode.length == 6) "${savedCode.take(3)}-${savedCode.drop(3)}" else savedCode
                etRoomCode.setText(formatted)
                etRoomCode.setSelection(formatted.length)
            } else {
                etRoomCode.setText("")
            }

            btnConnect.text = "Connect via Cloud"
            tvStatus.text = ""
        }
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

                runOnUiThread {
                    updateProBadgeUI()
                    if (isPro) {
                        switchMode("cloud")
                        val greeting = if (name.isNotEmpty()) name else email
                        Toast.makeText(this, "✅ Pro Activated! Welcome, $greeting.", Toast.LENGTH_LONG).show()
                    } else if (email.isNotEmpty()) {
                        Toast.makeText(this, "Signed in as $email (Free plan — upgrade to Pro for Cloud Relay)", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this, "Signed in successfully!", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    /**
     * Launches external system browser (Chrome/etc.) for Google Sign-In.
     * This ensures the user's saved Google credentials, autofill, and passwords
     * work seamlessly and securely without WebView restrictions.
     */
    private fun showGoogleSignInDialog() {
        if (isFinishing || isDestroyed) return

        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        val currentEmail = prefs.getString("nxtslide_google_email", "") ?: ""

        // Already signed in — show account status options
        if (currentEmail.isNotEmpty()) {
            val isPro = prefs.getBoolean("nxtslide_pro_unlocked", false)
            val statusMsg = if (isPro)
                "Signed in as $currentEmail\nPlan: ✅ Pro (Cloud Relay Unlocked)"
            else
                "Signed in as $currentEmail\nPlan: Free \u2014 upgrade to Pro to use Cloud Relay."

            AlertDialog.Builder(this)
                .setTitle("👤 Your NXTslide Account")
                .setMessage(statusMsg)
                .setPositiveButton(if (isPro) "Continue" else "Upgrade to Pro ✦") { _, _ ->
                    if (!isPro) {
                        openExternalGoogleSignIn()
                    } else {
                        switchMode("cloud")
                    }
                }
                .setNegativeButton("Sign Out") { _, _ ->
                    prefs.edit()
                        .remove("nxtslide_google_email")
                        .remove("nxtslide_google_name")
                        .remove("nxtslide_pro_unlocked")
                        .remove("nxtslide_plan")
                        .remove("auth_token")
                        .remove("auth_user")
                        .apply()
                    updateProBadgeUI()
                    Toast.makeText(this, "Signed out.", Toast.LENGTH_SHORT).show()
                }
                .show()
            return
        }

        // Not signed in — launch external browser directly
        openExternalGoogleSignIn()
    }

    private fun openExternalGoogleSignIn() {
        try {
            val authUrl = "$RELAY_BASE/api/auth/google?redirect=nxtslide://auth"
            val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(authUrl))
            startActivity(intent)
            Toast.makeText(this, "🌐 Opening Google Sign-In in your browser...", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not open browser: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Legacy: now redirects to Google Sign-In */
    private fun showProPaywallDialog() = showGoogleSignInDialog()
    private fun showEnterKeyDialog()   = showGoogleSignInDialog()


    // ─── Lifecycle ────────────────────────────────────────────────────────────
    override fun onDestroy() {
        super.onDestroy()
        if (::cameraExecutor.isInitialized) cameraExecutor.shutdown()
    }
}
