package com.nextpresent.remote

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
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
        const val RELAY_BASE = "https://nextpresent-relay.onrender.com"

        /** Key used to pass validated room code back to caller */
        const val EXTRA_ROOM_CODE = "room_code"
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

        // If launched from deep link (nextpresent://connect?code=ABC123)
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

        // Auto-format as user types (insert dash after 3 chars)
        etRoomCode.addTextChangedListener(object : TextWatcher {
            private var editing = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(e: Editable?) {
                if (editing) return
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
            // Return without a relay code — MainActivity will use LAN mode
            setResult(RESULT_CANCELED)
            finish()
        }
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
                        val raw = barcode.rawValue ?: continue
                        // Accept two formats:
                        // 1. https://.../r/ABCDEF  (relay phone URL)
                        // 2. nextpresent://connect?code=ABCDEF  (deep link)
                        val code = extractCode(raw)
                        if (!code.isNullOrBlank() && code != scannedCode) {
                            scannedCode = code
                            runOnUiThread {
                                val formatted = if (code.length == 6)
                                    "${code.take(3)}-${code.drop(3)}" else code
                                etRoomCode.setText(formatted)
                                tvStatus.text = "📸 QR scanned! Connecting…"
                                connectWithCode(code)
                            }
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
        val raw = etRoomCode.text.toString().uppercase().replace("-", "").trim()
        if (raw.length != 6) {
            tvStatus.text = "⚠ Enter a 6-character code (e.g. ABC-123)"
            return
        }
        connectWithCode(raw)
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

    // ─── Pro Mode & Paywall ───────────────────────────────────────────────
    private fun updateProBadgeUI() {
        val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
        val isPro = prefs.getBoolean("nxtslide_pro_unlocked", false)
        if (isPro) {
            btnTabCloud.text = "☁️ Cloud (PRO ✓)"
        } else {
            btnTabCloud.text = "☁️ Cloud (PRO 🔒)"
        }
    }

    private fun switchMode(mode: String) {
        currentMode = mode
        if (mode == "local") {
            btnTabLocal.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
            btnTabLocal.setTextColor(android.graphics.Color.WHITE)
            btnTabCloud.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            btnTabCloud.setTextColor(android.graphics.Color.parseColor("#94A3B8"))
            findViewById<TextView>(R.id.tvScanHint).text = "Point camera at Local QR on PC (Same Wi-Fi/Hotspot)"
        } else {
            btnTabCloud.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
            btnTabCloud.setTextColor(android.graphics.Color.WHITE)
            btnTabLocal.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            btnTabLocal.setTextColor(android.graphics.Color.parseColor("#94A3B8"))
            findViewById<TextView>(R.id.tvScanHint).text = "Scan Cloud QR or type 6-letter Room Code"
        }
    }

    private fun showProPaywallDialog() {
        val options = arrayOf("⭐ Unlock Pro Lifetime ($19)", "🔑 Enter License Key", "🏠 Stay on Free Local Mode")
        val message = """
            🚀 NXTslide Pro Lifetime Features:

            🌍 Present from Anywhere on Earth
            Control slides across 5G/LTE, hotel Wi-Fi, or across countries without network configuration.

            📱 Multi-Presenter Mode (Up to 5 Phones)
            Connect up to 5 mobile phones simultaneously to pass slide control seamlessly on stage.

            💎 Zero Subscriptions — Pay Once ($19)
            No monthly fees or recurring charges. Keep forever with all future updates.

            ⚡ Instant 6-Letter Room Code
            Bypasses hotel, university, and corporate firewalls in 2 seconds.

            📳 Stealth Pocket Haptic Timer
            Discreet vibration pulses at 10m, 5m, and 1m remaining.
        """.trimIndent()

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("⭐ Unlock Global Cloud Relay (PRO)")
            .setMessage(message)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://github.com/DilpreetSinghVerma/nextPresent#pricing"))
                        startActivity(intent)
                    }
                    1 -> {
                        showEnterKeyDialog()
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showEnterKeyDialog() {
        val input = EditText(this)
        input.hint = "e.g. NXT-PRO-XXXX"
        input.setSingleLine()
        input.setTextColor(android.graphics.Color.WHITE)
        input.setHintTextColor(android.graphics.Color.GRAY)
        val container = android.widget.FrameLayout(this)
        val params = android.widget.FrameLayout.LayoutParams(
            android.widget.ViewGroup.LayoutParams.MATCH_PARENT,
            android.widget.ViewGroup.LayoutParams.WRAP_CONTENT
        )
        params.leftMargin = 50
        params.rightMargin = 50
        input.layoutParams = params
        container.addView(input)

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Activate Pro License")
            .setMessage("Enter your NXTslide Pro license key:")
            .setView(container)
            .setPositiveButton("Activate") { _, _ ->
                val key = input.text.toString().trim().uppercase()
                if (key.length >= 6) {
                    val prefs = getSharedPreferences("NXTslidePrefs", Context.MODE_PRIVATE)
                    prefs.edit()
                        .putBoolean("nxtslide_pro_unlocked", true)
                        .putString("nxtslide_license_key", key)
                        .apply()
                    updateProBadgeUI()
                    switchMode("cloud")
                    Toast.makeText(this, "✅ Pro Activated! Cloud mode unlocked.", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Invalid license key (min 6 characters)", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────
    override fun onDestroy() {
        super.onDestroy()
        if (::cameraExecutor.isInitialized) cameraExecutor.shutdown()
    }
}
