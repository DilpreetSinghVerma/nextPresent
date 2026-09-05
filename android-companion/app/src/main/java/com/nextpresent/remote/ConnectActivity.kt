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

        cameraExecutor = Executors.newSingleThreadExecutor()

        requestCameraOrStart()

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

    // ─── Lifecycle ────────────────────────────────────────────────────────────
    override fun onDestroy() {
        super.onDestroy()
        if (::cameraExecutor.isInitialized) cameraExecutor.shutdown()
    }
}
