# 🎯 NXTslide

> **Control your PC presentation from your phone using physical volume keys.**
> No USB, no Bluetooth pairing, no extra hardware — just Wi-Fi.

---

## ✨ Features

| Feature | Details |
|---|---|
| 📱 Mobile Web Remote | Open in any browser — no app install needed |
| 🔊 Volume Key Support | Physical Vol Up/Down → Next/Prev Slide |
| 🤖 Android Native App | Zero volume-popup; true hardware key interception |
| ⚡ Ultra-low Latency | Local Wi-Fi WebSocket (<15ms round trip) |
| 👆 No-Look Clicker Mode | Giant tactile thumb zones with haptic vibration |
| 👈 Swipe Gestures | Swipe left/right to navigate slides |
| 🎧 Headset & BT Clicker | Inline headset button + lock screen media controls |
| ⏱️ Presentation Timer | Live stopwatch across PC and mobile |
| 📺 Blackout / Whiteout | One tap to blank screen (`B` / `W`) |
| 🖥️ Works with All Apps | PowerPoint, Google Slides, Keynote, PDF viewers |
| 🔗 QR Code Pairing | Instant URL sharing via QR scan |

---

## 🚀 Quick Start

### 1. Install & Start

```powershell
# In NXTslide folder:
npm install
npm start
```

The terminal will show a QR code and the connection URL (e.g. `http://192.168.1.15:3333/remote`).

### 2. Connect Your Phone

1. Make sure your **phone and PC are on the same Wi-Fi network**.
2. **Scan the QR code** shown on the PC dashboard, or open the URL manually.
3. Open your presentation on the PC.
4. Use your phone to switch slides!

---

## 📱 Phone Controls

| Gesture / Key | Action |
|---|---|
| Tap bottom 70% of screen | ▶ Next Slide |
| Tap top 30% of screen | ◀ Previous Slide |
| Swipe Left | ▶ Next Slide |
| Swipe Right | ◀ Previous Slide |
| **Volume Up** (physical key) | ▶ Next Slide |
| **Volume Down** (physical key) | ◀ Previous Slide |
| Headset / Bluetooth button (Next) | ▶ Next Slide |
| Lock Screen media next button | ▶ Next Slide |
| [B] button | Toggle Blackout |
| [F5] button | Start Slideshow |

---

## 🤖 Android Companion App (Full Volume Key Support)

For **true physical volume rocker** interception (suppresses system volume popup entirely):

1. Open the `android-companion` folder in **Android Studio**.
2. Connect your phone via USB with Developer Mode enabled.
3. Press **Run (▶)**.
4. When prompted, enter your PC's local IP address.

See [`android-companion/README.md`](android-companion/README.md) for full build instructions.

---

## 🖥️ PC Dashboard

Open `http://localhost:3333/dashboard` to see:
- Live QR code for pairing
- Number of connected phones
- Real-time slide event log
- Presentation timer
- Quick test buttons for Next/Prev/F5/Blackout/Esc

---

## 💎 Pricing

| Feature | Community (Free) | Pro Lifetime ($19 one-time) |
|---|:---:|:---:|
| **Physical Volume Key Clicker** | ✅ | ✅ |
| **Local Wi-Fi & Hotspot Mode** | ✅ | ✅ |
| **All Software Profiles** (PowerPoint, Keynote, Canva, etc.) | ✅ | ✅ |
| **🌍 Global Cloud Relay** (Across 5G/LTE, hotel Wi-Fi & different countries) | ❌ | ✅ |
| **📱 Multi-Presenter Mode** (Connect up to 5 phones simultaneously) | ❌ | ✅ |
| **⚡ Instant 6-Letter Room Code** (Bypass enterprise firewalls) | ❌ | ✅ |
| **📳 Stealth Pocket Haptics** (10m, 5m, 1m pace vibrations) | ❌ | ✅ |
| **Zero Subscriptions** (Pay once, own forever) | ✅ | ✅ |
| **All Future Updates Included** | ✅ | ✅ |

---

## 🔧 Configuration

| Setting | Default | Environment Variable |
|---|---|---|
| Server Port | `3333` | `PORT=4000 npm start` |

---

## 🗂️ Project Structure

```
NXTslide/
├── server.js               # Main WebSocket + Express server
├── lib/
│   ├── keySender.cs        # Native C# Windows key injector source
│   └── keySender.js        # Node.js wrapper (with Python fallback)
│   └── network.js          # Local IP detection
├── bin/
│   └── keySender.exe       # Compiled key injector
├── public/
│   ├── index.html          # PC Dashboard
│   ├── mobile.html         # Mobile Remote Controller
│   ├── css/
│   │   ├── dashboard.css
│   │   └── mobile.css
│   └── js/
│       ├── dashboard.js
│       └── mobile.js
└── android-companion/      # Native Android app for hardware volume keys
    └── app/src/main/java/com/nextpresent/remote/MainActivity.kt
```
