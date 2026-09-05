# nextPresent — Play Store Listing

## App Details

| Field | Value |
|---|---|
| **App Name** | nextPresent — Slide Remote |
| **Package ID** | `com.nextpresent.remote` |
| **Category** | Productivity / Business |
| **Content Rating** | Everyone |
| **Price** | Free (with optional Pro upgrade) |

---

## Short Description (80 chars max)
> Control presentations wirelessly — scan QR, press volume keys, done.

## Full Description (4000 chars max)

**nextPresent turns your Android phone into a wireless presentation remote — instantly.**

### How it works
1. Open nextPresent on your PC (download the tiny host app)
2. Scan the QR code on your PC dashboard **or** type the 6-char room code
3. You're connected! Now use your **volume buttons** to go forward/backward through slides

### Works from anywhere
Unlike Bluetooth remotes that only work 10 metres away, nextPresent uses a **cloud relay** — so you can control slides across different Wi-Fi networks, through walls, or even from another room entirely.

### Features
- 📸 **QR code scanning** — connect in under 3 seconds
- 🔊 **Volume buttons** — press Vol Up / Vol Down to advance slides (no touching the screen)
- 🔒 **Lock-screen control** — works even when your phone screen is locked
- ☁️ **Cloud relay** — no need to be on the same Wi-Fi as the presenter's PC
- 💻 **Supports** Microsoft PowerPoint, Google Slides, Canva, LibreOffice Impress, PDF viewers, Prezi
- 📊 **Live dashboard** on PC — see slide count, connected phones, and presentation timer
- ⚡ **Zero latency** — commands arrive in under 100ms
- 🔋 **Background-safe** — persistent notification keeps it alive, minimal battery drain

### Compatible software (on the PC)
- Microsoft PowerPoint (Arrow keys)
- Google Slides (Arrow keys)
- Canva Presentations (Arrow keys)
- LibreOffice Impress (Page Up/Down)
- Adobe Acrobat / Edge PDF (Page Up/Down)
- Prezi (Space / Backspace)
- Apple Keynote on Mac

### Privacy
- **No account required** — room codes are temporary (8-hour expiry)
- **No data stored** — commands are relayed in real time and never saved
- Camera is used only for QR code scanning, on-device only

---

## Screenshots Needed (Play Store requires)
1. **Connect screen** — QR scanner viewfinder with room code input
2. **Remote UI** — slide control buttons on phone
3. **PC Dashboard** — showing room code, QR, and metrics
4. **Lock screen notification** — showing volume control is active
5. **Feature graphic** — 1024×500 banner

---

## Keywords (for ASO)
presentation remote, slide clicker, PowerPoint remote, wireless presenter, QR remote, volume button slides, Google Slides remote, Canva remote, PDF presenter, clicker app

---

## Privacy Policy URL
> Required for Play Store. Host a simple policy page on your domain, e.g.:
> `https://nextpresent.io/privacy`

Minimum content needed:
- What data is collected (none stored persistently)
- Camera is used for on-device QR scanning only
- No account, no login, no tracking

---

## Release Build Instructions

### Prerequisites
- Android Studio (latest)
- JDK 17+

### Generate a keystore (first time only)
```bash
keytool -genkey -v -keystore nextpresent-release.jks \
  -alias nextpresent -keyalg RSA -keysize 2048 -validity 10000
```
Store `nextpresent-release.jks` safely — **never commit it to git**.

### Configure signing in `app/build.gradle`
```groovy
android {
    signingConfigs {
        release {
            storeFile file('../nextpresent-release.jks')
            storePassword System.getenv('KEYSTORE_PASS')
            keyAlias 'nextpresent'
            keyPassword System.getenv('KEY_PASS')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            shrinkResources true
        }
    }
}
```

### Build release AAB
```bash
./gradlew bundleRelease
```
Output: `app/build/outputs/bundle/release/app-release.aab`

### Upload to Play Console
1. Go to https://play.google.com/console
2. Create app → set name & category
3. Production → Create new release → Upload the `.aab`
4. Fill in store listing (above)
5. Submit for review (~2–4 weeks first submission, ~hours for updates)

---

## Relay Server Deployment (Railway)

```bash
# In /relay directory:
railway login
railway init
railway up
```

Or connect GitHub repo to Railway — it auto-deploys on every push.

### Environment variables (Railway dashboard)
| Variable | Value |
|---|---|
| `PORT` | Set automatically by Railway |
| `NODE_ENV` | `production` |

The relay URL will be: `https://nextpresent-relay-XXXX.up.railway.app`
Update `RELAY_BASE` in `ConnectActivity.kt` and `server.js` to match.

---

## Version History

| Version | Changes |
|---|---|
| 1.0 | LAN-only mode, volume key background control |
| 2.0 | Cloud relay, QR code scanning, ConnectActivity |
