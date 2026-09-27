# 🎯 NXTslide — Turn Your Smartphone into a Pro Presentation Clicker

> **Control your PC presentations seamlessly from your phone using physical hardware volume keys, a 3D gyro laser pointer, and a discreet stealth touchpad.**
> Zero USB dongles. Zero Bluetooth pairing hassles. Connects instantly over local Wi-Fi, offline hotspot, or Global Cloud Relay.

[![Website](https://img.shields.io/badge/Website-nxtslide.online-blue?style=flat-square&logo=googlechrome)](https://nxtslide.online)
[![Android APK](https://img.shields.io/badge/Android%20APK-v2.3.2-brightgreen?style=flat-square&logo=android)](https://nxtslide.online/NXTslide.apk)
[![Windows](https://img.shields.io/badge/Windows%20Host-v2.3.0-informational?style=flat-square&logo=windows)](https://github.com/DilpreetSinghVerma/nextPresent/releases/latest)
[![Pricing](https://img.shields.io/badge/Lifetime%20Pro-₹89%20One--Time-orange?style=flat-square)](https://nxtslide.online#pricing)
[![License](https://img.shields.io/badge/License-Proprietary%20%2F%20EventFold%20Studio-blueviolet?style=flat-square)](LICENSE)

---

## ⚡ Why NXTslide?

Physical presentation remotes (Logitech Spotlight, Kensington) cost **$60 to $130 (₹5,000–₹11,000)** and require dedicated USB dongles that get lost or require dongle adapters on modern USB-C laptops. Other mobile apps force you into **monthly recurring subscriptions**.

**NXTslide turns the smartphone already in your pocket into a studio-grade presentation wand.**

- **Pocket Mode:** Lock your phone and slide forward/backward using the physical volume keys from inside your jacket or pocket.
- **3D Gyro Laser & Spotlight:** Hold your phone like a wand to point a physics-smoothed red laser dot or dim the background into a crisp presentation spotlight over any slide or document.
- **Works Everywhere:** Connect locally over LAN/hotspot with zero internet, or connect globally via 6-letter cloud room codes across corporate firewalls, hotel Wi-Fi, and 5G cellular.

---

## ✨ Feature Comparison

| Feature | Community (Free) | Lifetime Pro (₹89 One-Time) |
|---|:---:|:---:|
| 🔊 **Hardware Volume Key Clicker** (True physical Vol Up/Down clicks) | ✅ | ✅ |
| 🔒 **Screen-Off Pocket Mode** (Operate invisibly behind locked screen) | ✅ | ✅ |
| ⬛ **Giant Touch Screen Clicker** (Next/Prev with haptic vibration) | ✅ | ✅ |
| 🏠 **Local Wi-Fi & Hotspot Mode** (<15ms ultra-low latency WebSocket) | ✅ | ✅ |
| 🖥️ **All Presentation Apps** (PowerPoint, Google Slides, Keynote, Canva, PDF) | ✅ | ✅ |
| 💼 **Zero-Install Portable Mode** (Run from USB without admin rights) | ✅ | ✅ |
| ⏱️ **Presentation Stopwatch & Pace Haptics** | ✅ | ✅ |
| 🔴 **3D Gyro Virtual Laser Pointer** (Wand pointing with physics smoothing) | ❌ | ✅ |
| 🔦 **Spotlight Focus Beam** (Dim background to highlight key points) | ❌ | ✅ |
| 📱 **Smart Touchpad Laser Fallback** (Smooth laser aiming on budget phones) | ❌ | ✅ |
| ☁️ **Global Cloud Relay** (Present across 5G/4G cellular & hotel Wi-Fi) | ❌ | ✅ |
| 👥 **Multi-Presenter Mode** (Connect up to 5 phones simultaneously) | ❌ | ✅ |
| ⚡ **Instant 6-Letter Room Code** (Bypasses college & corporate firewalls) | ❌ | ✅ |
| 💳 **Native In-App UPI & Razorpay** (GPay, PhonePe, Paytm, CRED, Cards) | ❌ | ✅ |
| ♾️ **Zero Subscriptions** (Pay once ₹89, own forever with all future updates) | — | ✅ |

---

## 🚀 Quick Download & Installation

### Option 1: Official Website & Prebuilt Installers (Recommended)
1. **Windows Presentation PC:**
   - [Download Windows Installer (.exe)](https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v2.3.2/NXTslide-Setup.exe)
   - Or [Download Portable Standalone (.exe)](https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v2.3.2/NXTslide-Portable.exe) — *Runs directly from a USB drive without admin rights on corporate laptops.*
2. **Android Phone:**
   - [Download Official NXTslide Companion APK (v2.3.2)](https://nxtslide.online/NXTslide.apk) (or [Direct GitHub Raw Link](https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk))
3. **iPhone / iPad / Guest Presenters:**
   - No app installation needed! Scan the QR code on your PC screen with your camera or open [nxtslide.online/mobile](https://nxtslide.online/mobile) and enter your 6-letter room code.

---

### Option 2: Run From Source (Developers)
```powershell
# Clone the repository
git clone https://github.com/DilpreetSinghVerma/nextPresent.git
cd nextPresent

# Install dependencies
npm install

# Start local server
npm start
```
The terminal and PC dashboard will launch at `http://localhost:3333` with your pairing QR code.

---

## 📱 Mobile Controls & Modes

- **🔊 Hardware Volume Clicker:** Press Volume Up to advance slides, Volume Down to go back.
- **👆 Giant Touch Clicker:** Bottom 70% tap zone for Next, top 30% for Prev with subtle haptic vibration.
- **🔴 3D Laser Pointer:** Hold the laser tab and aim your phone at the screen like a physical wand.
- **⬛ Stealth Touchpad:** Pitch-black OLED mode for dark auditoriums — swipe to move mouse cursor, tap to click without screen glare distracting the audience.
- **📺 Blank Screen:** Tap `B` for blackout, `W` for whiteout.
- **🎬 Fullscreen Slideshow:** Tap `F5` to start presentation from slide 1.

---

## 💎 Pricing: Permanent Lifetime Deal

NXTslide believes presenters shouldn't be trapped in endless monthly subscriptions:
- **Free Community Plan:** ₹0 forever for local Wi-Fi and hotspot presentations.
- **Lifetime Pro Plan:** **₹89 INR One-Time** (Never pay again).
  - Securely processed via **Razorpay** (supports Google Pay, PhonePe, Paytm, UPI, Net Banking, and Cards).
  - **7-Day 100% Money-Back Guarantee** — hassle-free refund if it doesn't work for you.

---

## 🛡️ Security & Privacy

- **Zero Cloud Storage of Presentations:** Slides and files stay completely on your PC. NXTslide only relays directional navigation commands (`NEXT`, `PREV`, `LASER_MOVE`).
- **Temporary Ephemeral Sessions:** Cloud relay room codes expire automatically after 8 hours.
- **Local Offline Capable:** Can run 100% offline on a closed local network or laptop mobile hotspot with zero internet access required.
- **Dual-Gated Pro Verification:** Pro features are cryptographically and server-validated on both the host desktop and cloud relay.

---

## 🛡️ License & Commercial Protection

Copyright © 2026 **EventFold Studio** · Founded and developed by **Dilpreet Singh**.

This repository contains the source code for the NXTslide community client and companion tooling. 
- You are free to inspect, review, and run the code for personal, non-commercial, and educational presentations.
- **Commercial re-hosting, white-labeling, re-branding, or selling of this software or its Cloud Relay services is strictly prohibited.**
- For commercial licensing inquiries or partnership queries, contact us at [nxtslide.online/contact](https://nxtslide.online/contact).

---

## 🔗 Official Links

- **Website:** [https://nxtslide.online](https://nxtslide.online)
- **Direct APK Download:** [https://nxtslide.online/NXTslide.apk](https://nxtslide.online/NXTslide.apk)
- **GitHub Repository:** [DilpreetSinghVerma/nextPresent](https://github.com/DilpreetSinghVerma/nextPresent)
- **Web Remote:** [https://nxtslide.online/mobile](https://nxtslide.online/mobile)
- **Legal & Policies:** [Terms](https://nxtslide.online/terms) · [Privacy](https://nxtslide.online/privacy) · [Refunds](https://nxtslide.online/refund) · [Contact](https://nxtslide.online/contact)
