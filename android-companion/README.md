# NXTslide Android Companion App

This lightweight Android companion app enables **direct physical volume key interception** (`Volume Up` -> Next Slide, `Volume Down` -> Previous Slide) while suppressing the Android system volume UI.

---

## Why Use the Companion App?

Standard mobile web browsers (Chrome, Firefox, Safari) prevent web pages from overriding hardware volume rockers for device security.

This companion app provides:
1. **Physical Volume Rocker Control**: Pressing your phone's physical `Volume Up` or `Volume Down` button immediately switches slides without showing the system volume slider.
2. **Haptic Pulse**: Instant vibration confirmation in your palm when pressing either button.
3. **Embedded Low-Latency Controller**: Houses the complete touch interface (giant tactile thumb zones, stopwatch timer, blackout `B`, restart `F5`).

---

## How to Build & Install

### Option 1: Open in Android Studio
1. Open **Android Studio**.
2. Click **Open** and select the `android-companion` folder.
3. Connect your Android phone via USB (with USB Debugging enabled) or use Wi-Fi pairing.
4. Click the green **Run (▶)** button.

### Option 2: Build via Command Line (Gradle)
```bash
cd android-companion
./gradlew assembleDebug
```
The compiled APK will be generated at:
`android-companion/app/build/outputs/apk/debug/app-debug.apk`

Transfer and install `app-debug.apk` on your phone.

---

## Usage
1. Launch `NXTslide` on your PC (`npm start`).
2. Make sure your phone and laptop are connected to the same Wi-Fi network.
3. Open the **NXTslide** app on your phone.
4. Enter the IP address shown on your PC screen (e.g. `192.168.1.15`).
5. Start your presentation in PowerPoint / Google Slides on your PC.
6. Press your phone's **Volume Up** or **Volume Down** buttons to switch slides!
