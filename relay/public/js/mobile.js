// ══════════════════════════════════════════════════════════
//  NXTslide Mobile Remote  •  mobile.js
// ══════════════════════════════════════════════════════════
let ws = null;
let vibrate = true;
let audioCtx = null;
let audioSource = null;
let mediaSessionActive = false;

// ─── DOM ───────────────────────────────────────────────────
const connDot     = document.getElementById('connDot');
const slideNum    = document.getElementById('slideNum');
const timerVal    = document.getElementById('timerVal');
const timerRow    = document.getElementById('timerRow');
const timerIcon   = document.getElementById('timerIcon');
const flash       = document.getElementById('flash');

const volBanner   = document.getElementById('volBanner');
const volIcon     = document.getElementById('volIcon');
const volTitle    = document.getElementById('volTitle');
const volSub      = document.getElementById('volSub');
const volBtn      = document.getElementById('volBtn');

const zonePrev    = document.getElementById('zonePrev');
const zoneNext    = document.getElementById('zoneNext');
const zones       = document.getElementById('zones');

const toolBlackout = document.getElementById('toolBlackout');
const toolF5       = document.getElementById('toolF5');
const toolVibrate  = document.getElementById('toolVibrate');
const vibrateLabel = document.getElementById('vibrateLabel');
const toolTimer    = document.getElementById('toolTimer');

const infoBtn     = document.getElementById('infoBtn');
const modal       = document.getElementById('modal');
const closeModal  = document.getElementById('closeModal');

const mobileProfilePill   = document.getElementById('mobileProfilePill');
const mobileProfileSelect = document.getElementById('mobileProfileSelect');

const PROFILE_NAMES = {
  powerpoint: 'PowerPoint',
  google_slides: 'Google Slides',
  canva: 'Canva',
  libreoffice: 'LibreOffice',
  pdf: 'PDF Viewer',
  prezi: 'Prezi',
  keynote_mac: 'Keynote'
};

function updateProfileUI(profile) {
  if (!profile) return;
  if (mobileProfilePill) {
    mobileProfilePill.textContent = PROFILE_NAMES[profile] || profile;
  }
  if (mobileProfileSelect && mobileProfileSelect.value !== profile) {
    mobileProfileSelect.value = profile;
  }
}

function getServerHost() {
  if (window.AndroidApp && typeof window.AndroidApp.getServerHost === 'function') {
    return window.AndroidApp.getServerHost();
  }
  if (location.host && location.protocol.startsWith('http')) {
    return location.host;
  }
  return localStorage.getItem('nextpresent_server_ip') || '192.168.101.9:3333';
}

let isMultiDeviceBlocked = false;

function getDeviceId() {
  if (window.AndroidApp && typeof window.AndroidApp.getDeviceId === 'function') {
    try {
      const id = window.AndroidApp.getDeviceId();
      if (id) return id;
    } catch (_) {}
  }
  let id = localStorage.getItem('nxtslide_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    localStorage.setItem('nxtslide_device_id', id);
  }
  return id;
}

// ══════════════════════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════════════════════
function initWS() {
  const host = getServerHost();
  const deviceId = getDeviceId();
  const wsUrl = `ws://${host.includes(':') ? host : host + ':3333'}/ws?role=remote&deviceId=${encodeURIComponent(deviceId)}`;

  try {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  } catch (_) {}

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (!isMultiDeviceBlocked) {
      connDot.classList.remove('off');
    }
  };

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'INIT' || d.type === 'STATE_SYNC') {
        if (d.isPro !== undefined) isHostPro = !!d.isPro;
        if (d.sessionState) syncState(d.sessionState);
        if (d.activeProfile) updateProfileUI(d.activeProfile);
        else if (d.sessionState && d.sessionState.activeProfile) updateProfileUI(d.sessionState.activeProfile);
      } else if (d.type === 'MULTI_DEVICE_BLOCKED') {
        isMultiDeviceBlocked = true;
        connDot.classList.add('off');
        showProPaywall('Multi-Presenter Mode (2+ remotes)');
        const desc = document.getElementById('proModalDesc');
        if (desc) {
          desc.textContent = d.message || 'Multi-Presenter Mode (2+ remotes) is an exclusive feature of NXTslide Lifetime Pro (₹149). Free version allows 1 remote at a time.';
        }
      } else if (d.type === 'PRO_STATUS_CHANGED') {
        isHostPro = !!d.isPro;
        if (isHostPro) isMultiDeviceBlocked = false;
      } else if (d.type === 'PROFILE_CHANGED') {
        updateProfileUI(d.profile);
      } else if (d.type === 'TIMER_SYNC') {
        syncTimer(d.sessionState);
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    connDot.classList.add('off');
    if (!isMultiDeviceBlocked) {
      setTimeout(initWS, 2500);
    }
  };
}

// ══════════════════════════════════════════════════════════
//  Send action
// ══════════════════════════════════════════════════════════
function send(action, source) {
  if (isMultiDeviceBlocked) {
    showProPaywall('Multi-Presenter Mode (2+ remotes)');
    return;
  }

  buzz(action);
  doFlash();

  // If inside native Android companion app, fire via native OkHttp WebSocket (0 delay)
  if (window.AndroidApp && typeof window.AndroidApp.sendAction === 'function') {
    window.AndroidApp.sendAction(action);
    return;
  }

  const deviceId = getDeviceId();
  const msg = JSON.stringify({ type: 'COMMAND', action, source: source || 'Mobile', deviceId });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);
  } else {
    // HTTP fallback
    const host = getServerHost();
    fetch(`http://${host.includes(':') ? host : host + ':3333'}/api/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, source: source || 'Mobile', deviceId })
    }).catch(() => {});
  }
}

// Handler called by Android MainActivity when receiving WebSocket messages from PC or Cloud Relay
window.onServerMessage = function(jsonStr) {
  try {
    const d = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    if (d.type === 'INIT' || d.type === 'STATE_SYNC') {
      if (d.isPro !== undefined) isHostPro = !!d.isPro;
      if (d.sessionState) syncState(d.sessionState);
      if (d.activeProfile) updateProfileUI(d.activeProfile);
      else if (d.sessionState && d.sessionState.activeProfile) updateProfileUI(d.sessionState.activeProfile);
    } else if (d.type === 'MULTI_DEVICE_BLOCKED') {
      isMultiDeviceBlocked = true;
      connDot.classList.add('off');
      showProPaywall('Multi-Presenter Mode (2+ remotes)');
      const desc = document.getElementById('proModalDesc');
      if (desc) {
        desc.textContent = d.message || 'Multi-Presenter Mode (2+ remotes) is an exclusive feature of NXTslide Lifetime Pro (₹149). Free version allows 1 remote at a time.';
      }
    } else if (d.type === 'PRO_STATUS_CHANGED') {
      isHostPro = !!d.isPro;
      if (isHostPro) isMultiDeviceBlocked = false;
    } else if (d.type === 'KEY_EVENT') {
      if (d.sessionState) syncState(d.sessionState);
    } else if (d.type === 'PROFILE_CHANGED') {
      updateProfileUI(d.profile);
    } else if (d.type === 'TIMER_SYNC') {
      syncTimer(d.sessionState);
    }
  } catch (_) {}
};

function syncState(s) {
  if (!s) return;
  slideNum.textContent = `Slide ${s.slideCount || 1}`;
  syncTimer(s);
}

function syncTimer(s) {
  if (!s) return;
  const secs = s.elapsedSeconds || 0;
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const sec = String(secs % 60).padStart(2, '0');
  timerVal.textContent = `${m}:${sec}`;

  const running = s.isTimerRunning;
  timerIcon.innerHTML = running
    ? `<rect x="6" y="4" width="4" height="16" fill="#f59e0b"/><rect x="14" y="4" width="4" height="16" fill="#f59e0b"/>`
    : `<polygon points="5 3 19 12 5 21 5 3" fill="#818cf8"/>`;
}

// ══════════════════════════════════════════════════════════
//  Visual & Haptic feedback
// ══════════════════════════════════════════════════════════
function doFlash() {
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 80);
}

function buzz(action) {
  if (!vibrate || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(action === 'NEXT' ? 30 : [20, 15, 20]);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════
//  MediaSession / Audio session activation
//  ──────────────────────────────────────────────────────
//  Why this exists: Chrome/Safari block hardware volume
//  rocker events from reaching JS. But once an AudioContext
//  is running and MediaSession handlers are set, the
//  OS media controls (lock screen, headset inline buttons,
//  Bluetooth media keys) fire nexttrack / previoustrack.
// ══════════════════════════════════════════════════════════
function activateMediaSession() {
  if (mediaSessionActive) return;

  try {
    // Create a near-silent audio loop using Web Audio API
    // (more reliable than <audio> element for keepalive)
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Oscillator at 1 Hz (inaudible rumble) → GainNode at 0.001 (silent)
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    audioSource = osc;

    setupMediaSession();
    mediaSessionActive = true;

    // Update UI to show active state
    volBanner.classList.add('active');
    volIcon.textContent = '🔊';
    volTitle.textContent = 'Headset & Lock Screen keys → slides ✓';
    volSub.textContent = 'Next/Prev buttons on headset & Bluetooth devices now work';
    volBtn.textContent = 'Active ✓';
    volBtn.style.cursor = 'default';

  } catch (err) {
    console.error('Audio activation failed:', err);
    volSub.textContent = 'Could not activate audio session: ' + err.message;
  }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'NXTslide — Slide Controller',
    artist: 'Headset Next/Prev → change slides',
    album: 'NXTslide Remote Active',
  });

  // Headset multi-button "Next Track" → Next Slide
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    send('NEXT', 'Headset / Lock Screen Next');
  });

  // Headset "Prev Track" → Previous Slide
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    send('PREV', 'Headset / Lock Screen Prev');
  });

  // Single-button headset (play/pause) → Next Slide
  navigator.mediaSession.setActionHandler('play', () => {
    send('NEXT', 'Headset Play button');
    // Keep audio playing so session stays alive
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    // Prevent pause from killing the session
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  });

  // seekforward / seekbackward also fire on some headsets
  navigator.mediaSession.setActionHandler('seekforward', () => {
    send('NEXT', 'Headset seek forward');
  });

  navigator.mediaSession.setActionHandler('seekbackward', () => {
    send('PREV', 'Headset seek backward');
  });
}

// ══════════════════════════════════════════════════════════
//  Touch Zone Handlers
// ══════════════════════════════════════════════════════════
zoneNext.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  zoneNext.classList.add('pressed');
  send('NEXT', 'Tap Next Zone');
});
zoneNext.addEventListener('pointerup', () => zoneNext.classList.remove('pressed'));
zoneNext.addEventListener('pointerleave', () => zoneNext.classList.remove('pressed'));

zonePrev.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  zonePrev.classList.add('pressed');
  send('PREV', 'Tap Prev Zone');
});
zonePrev.addEventListener('pointerup', () => zonePrev.classList.remove('pressed'));
zonePrev.addEventListener('pointerleave', () => zonePrev.classList.remove('pressed'));

// ══════════════════════════════════════════════════════════
//  Swipe Gesture
// ══════════════════════════════════════════════════════════
let tx = 0, ty = 0, tt = 0;

zones.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    tt = Date.now();
  }
}, { passive: true });

zones.addEventListener('touchend', (e) => {
  if (e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - tx;
  const dy = e.changedTouches[0].clientY - ty;
  const dt = Date.now() - tt;

  // Horizontal swipe: > 60px horizontal, mostly horizontal, < 400ms
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 400) {
    send(dx < 0 ? 'NEXT' : 'PREV', dx < 0 ? 'Swipe Left → Next' : 'Swipe Right → Prev');
  }
}, { passive: true });

// ══════════════════════════════════════════════════════════
//  Keyboard Events (Bluetooth clickers, USB keyboards,
//  some headsets that appear as keyboard HID devices)
// ══════════════════════════════════════════════════════════
window.addEventListener('keydown', (e) => {
  const k = e.key;

  // Headset / media keys that DO fire in browser
  if (k === 'MediaTrackNext') { e.preventDefault(); send('NEXT', 'Media Key: Next Track'); return; }
  if (k === 'MediaTrackPrevious') { e.preventDefault(); send('PREV', 'Media Key: Prev Track'); return; }
  if (k === 'MediaPlayPause') { e.preventDefault(); send('NEXT', 'Media Key: Play/Pause'); return; }

  // Bluetooth presentation clickers
  if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); send('NEXT', 'Clicker / Arrow Right'); return; }
  if (k === 'ArrowLeft' || k === 'PageUp')   { e.preventDefault(); send('PREV', 'Clicker / Arrow Left'); return; }
  if (k === ' ') { e.preventDefault(); send('NEXT', 'Space key'); return; }

  // Volume keys — these DO fire in some desktop browsers / WebView
  // On stock Android Chrome they are suppressed before reaching JS
  if (k === 'AudioVolumeUp'   || k === 'VolumeUp'   || e.keyCode === 175) {
    e.preventDefault(); send('NEXT', 'Volume Up Key'); return;
  }
  if (k === 'AudioVolumeDown' || k === 'VolumeDown' || e.keyCode === 174) {
    e.preventDefault(); send('PREV', 'Volume Down Key'); return;
  }
}, { passive: false });

// ══════════════════════════════════════════════════════════
//  Toolbar Actions
// ══════════════════════════════════════════════════════════
toolBlackout.addEventListener('click', () => send('B', 'Blackout'));
toolF5.addEventListener('click',       () => send('F5', 'Start F5'));

toolVibrate.addEventListener('click', () => {
  vibrate = !vibrate;
  vibrateLabel.textContent = vibrate ? 'Vibrate ON' : 'Vibrate OFF';
  toolVibrate.classList.toggle('active', vibrate);
  if (vibrate) buzz('NEXT');
});

toolTimer.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'TIMER_RESET' }));
  }
});

timerRow.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Toggle: check timerIcon rect for pause state
    const isRunning = timerIcon.querySelector('rect') !== null;
    ws.send(JSON.stringify({ type: isRunning ? 'TIMER_PAUSE' : 'TIMER_START' }));
  }
});

// ══════════════════════════════════════════════════════════
//  Volume Banner & Modal
// ══════════════════════════════════════════════════════════
volBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!mediaSessionActive) activateMediaSession();
});

volBanner.addEventListener('click', () => {
  modal.classList.add('open');
});

infoBtn.addEventListener('click', () => modal.classList.add('open'));
closeModal.addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.remove('open');
});

if (mobileProfilePill) {
  mobileProfilePill.addEventListener('click', () => {
    modal.classList.add('open');
  });
}

if (mobileProfileSelect) {
  mobileProfileSelect.addEventListener('change', (e) => {
    const profile = e.target.value;
    updateProfileUI(profile);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'SET_PROFILE', profile }));
    } else {
      fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile })
      }).catch(() => {});
    }
  });
}

// ══════════════════════════════════════════════════════════
//  Android Native Companion Bridge
// ══════════════════════════════════════════════════════════
window.onHardwareVolumeKey = function(action) {
  buzz(action);
  doFlash();
};

window.onServerIpUpdated = function(newIp) {
  localStorage.setItem('nextpresent_server_ip', newIp);
  initWS();
};

if (window.AndroidApp && typeof window.AndroidApp.isNativeApp === 'function' && window.AndroidApp.isNativeApp()) {
  if (volBanner) {
    volBanner.classList.add('active');
    volIcon.textContent = '🔊';
    volTitle.textContent = 'Hardware Volume Keys Active ✓';
    volSub.textContent = 'Press your phone\'s physical Volume Up / Down buttons';
    volBtn.textContent = 'Settings';
    volBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof window.AndroidApp.promptIpDialog === 'function') {
        window.AndroidApp.promptIpDialog();
      } else {
        modal.classList.add('open');
      }
    });
  }
}

// ══════════════════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════════════════
initWS();

// Auto-activate audio session on first user interaction
// (browsers require a gesture before AudioContext can start)
document.addEventListener('pointerdown', activateMediaSession, { once: true });

// ══════════════════════════════════════════════════════════
//  Virtual Laser Pointer & Compass Yaw Engine
// ══════════════════════════════════════════════════════════
const toolLaser        = document.getElementById('toolLaser');
const laserModal       = document.getElementById('laserModal');
const closeLaserModal  = document.getElementById('closeLaserModal');
const laserStyleBtn    = document.getElementById('laserStyleBtn');
const tabLaserGyro     = document.getElementById('tabLaserGyro');
const tabLaserTouch    = document.getElementById('tabLaserTouch');
const viewLaserGyro    = document.getElementById('viewLaserGyro');
const viewLaserTouch   = document.getElementById('viewLaserTouch');
const laserClutchBtn   = document.getElementById('laserClutchBtn');
const laserTouchpad    = document.getElementById('laserTouchpad');
const laserRecenterBtn = document.getElementById('laserRecenterBtn');

// Hardware Gyro Capability Check
let hasHardwareGyro = true;
if (window.AndroidApp && typeof window.AndroidApp.hasHardwareGyro === 'function') {
  try {
    hasHardwareGyro = window.AndroidApp.hasHardwareGyro();
  } catch (e) {
    console.warn('Error reading hasHardwareGyro:', e);
  }
}

let laserActiveMode = hasHardwareGyro ? 'gyro' : 'touch'; // 'gyro' | 'touch'
let laserStyle      = 'laser'; // 'laser' | 'spotlight'
let isLaserPointing = false;
let laserPointerX   = 0.5;
let laserPointerY   = 0.5;
let laserPhonePitch = 45;

// 1-Euro Adaptive Filter for Silky Human Steering
class LaserOneEuroFilter {
  constructor(freq = 60, mincutoff = 0.45, beta = 0.002, dcutoff = 1.0) {
    this.freq = freq;
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
    this.x = null;
    this.dx = 0;
    this.lastTime = null;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(val, timestamp) {
    if (this.lastTime === null) {
      this.x = val;
      this.dx = 0;
      this.lastTime = timestamp;
      return val;
    }
    const dt = Math.max((timestamp - this.lastTime) / 1000, 0.001);
    this.lastTime = timestamp;

    const dval = (val - this.x) / dt;
    const edx = this.dx + this.alpha(this.dcutoff, dt) * (dval - this.dx);
    this.dx = edx;

    const cutoff = this.mincutoff + this.beta * Math.abs(edx);
    const a = this.alpha(cutoff, dt);
    this.x = this.x + a * (val - this.x);
    return this.x;
  }

  reset(val) {
    this.x = val;
    this.dx = 0;
    this.lastTime = null;
  }
}

const laserFilterX = new LaserOneEuroFilter(60, 0.45, 0.002, 1.0);
const laserFilterY = new LaserOneEuroFilter(60, 0.45, 0.002, 1.0);

function sendLaserWs(data) {
  if (window.AndroidApp && typeof window.AndroidApp.sendLaserEvent === 'function') {
    try {
      window.AndroidApp.sendLaserEvent(data.type, data.x !== undefined ? data.x : 0.5, data.y !== undefined ? data.y : 0.5, data.style || laserStyle || 'laser');
      return;
    } catch (_) {}
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Apply Gyro Availability: on devices without a hardware gyro, hide Flashlight Aiming entirely!
function applyGyroAvailability(available) {
  hasHardwareGyro = !!available;
  const tabsContainer = document.querySelector('.laser-tabs');
  const laserHeaderTitle = document.querySelector('.laser-header strong');

  if (!hasHardwareGyro) {
    if (tabLaserGyro) {
      tabLaserGyro.style.display = 'none';
      tabLaserGyro.classList.remove('active');
    }
    if (viewLaserGyro) {
      viewLaserGyro.style.display = 'none';
      viewLaserGyro.classList.remove('active');
    }
    if (tabsContainer) {
      tabsContainer.style.display = 'none';
    }
    laserActiveMode = 'touch';
    if (tabLaserTouch) {
      tabLaserTouch.classList.add('active');
      tabLaserTouch.style.display = 'none';
    }
    if (viewLaserTouch) {
      viewLaserTouch.classList.add('active');
      viewLaserTouch.style.display = 'flex';
    }
    if (laserTouchpad) {
      laserTouchpad.style.height = '270px';
    }
    if (laserHeaderTitle) {
      laserHeaderTitle.textContent = 'Touchpad Pointer';
    }
  } else {
    if (tabLaserGyro) {
      tabLaserGyro.style.display = '';
    }
    if (tabLaserTouch) {
      tabLaserTouch.style.display = '';
    }
    if (tabsContainer) {
      tabsContainer.style.display = '';
    }
    if (laserHeaderTitle) {
      laserHeaderTitle.textContent = 'Virtual Laser Pointer';
    }
  }
}

window.nxtslideSetGyroAvailable = function(available) {
  applyGyroAvailability(available);
};

// Immediately apply on page load
applyGyroAvailability(hasHardwareGyro);

function applyNativeAppUI() {
  if (window.AndroidApp) {
    if (volBanner) {
      volBanner.classList.add('active');
      if (volIcon) volIcon.textContent = '⚡';
      if (volTitle) volTitle.textContent = 'Physical Volume Buttons Active ✓';
      if (volSub) volSub.textContent = 'Vol Up / Down change slides (screen off in pocket supported)';
      if (volBtn) {
        volBtn.textContent = 'Active ✓';
        volBtn.style.cursor = 'default';
      }
    }

    const badgeRow = document.getElementById('badgeRow');
    if (badgeRow) {
      badgeRow.innerHTML = `
        <span class="badge green">✓ Physical Volume Keys</span>
        <span class="badge green">✓ Pocket Mode (Screen Off)</span>
        <span class="badge green">✓ Stealth Blackout Mode</span>
        <span class="badge green">✓ Tap zones</span>
        <span class="badge green">✓ Swipe gestures</span>
        <span class="badge green">✓ Headset &amp; Media keys</span>
      `;
    }
  }
}
applyNativeAppUI();
window.onServerConnected = function() {
  applyNativeAppUI();
};

let isHostPro = false;

function isProActive() {
  if (window.AndroidApp && typeof window.AndroidApp.isProUnlocked === 'function') {
    try {
      if (window.AndroidApp.isProUnlocked()) return true;
    } catch (_) {}
  }
  if (isHostPro) return true;
  try {
    const userStr = localStorage.getItem('nxtslide_user');
    if (userStr) {
      const u = JSON.parse(userStr);
      if (u && (u.isPro || u.plan === 'pro')) return true;
    }
    if (localStorage.getItem('nxtslide_pro_unlocked') === 'true') return true;
  } catch(_) {}
  return false;
}

function showProPaywall(featureName) {
  const modal = document.getElementById('mobileProModal');
  const desc = document.getElementById('proModalDesc');
  const proEmailInput = document.getElementById('proEmailInput');

  if (desc && featureName) {
    desc.textContent = `${featureName} is an exclusive feature of NXTslide Lifetime Pro (₹149). Unlock once, own forever!`;
  }

  // Pre-fill email if available
  if (proEmailInput && !proEmailInput.value) {
    let savedEmail = '';
    if (window.AndroidApp && typeof window.AndroidApp.getUserEmail === 'function') {
      savedEmail = window.AndroidApp.getUserEmail();
    }
    if (!savedEmail) {
      try {
        const u = JSON.parse(localStorage.getItem('nxtslide_user') || '{}');
        if (u.email) savedEmail = u.email;
      } catch(_) {}
    }
    if (savedEmail) proEmailInput.value = savedEmail;
  }

  if (modal) {
    modal.style.display = 'flex';
  }
}

const closeMobileProModal = document.getElementById('closeMobileProModal');
if (closeMobileProModal) {
  closeMobileProModal.addEventListener('click', () => {
    const modal = document.getElementById('mobileProModal');
    if (modal) modal.style.display = 'none';
  });
}

// ─── Direct In-App Razorpay Checkout (UPI GPay, PhonePe, Paytm, Cards) ───────
const proUpgradeBtn = document.getElementById('proUpgradeBtn');
const proEmailInput = document.getElementById('proEmailInput');

async function startInAppProUpgrade() {
  let email = proEmailInput ? proEmailInput.value.trim() : '';
  if (!email && window.AndroidApp && typeof window.AndroidApp.getUserEmail === 'function') {
    email = window.AndroidApp.getUserEmail();
  }
  if (!email) {
    try {
      const u = JSON.parse(localStorage.getItem('nxtslide_user') || '{}');
      if (u.email) email = u.email;
    } catch(_) {}
  }

  if (!email || !email.includes('@')) {
    if (proEmailInput) {
      proEmailInput.focus();
      proEmailInput.style.borderColor = '#ef4444';
    }
    alert('Please enter your email address to receive your Lifetime Pro receipt and license.');
    return;
  }

  let name = '';
  if (window.AndroidApp && typeof window.AndroidApp.getUserName === 'function') {
    name = window.AndroidApp.getUserName();
  }
  if (!name) {
    try {
      const u = JSON.parse(localStorage.getItem('nxtslide_user') || '{}');
      if (u.name) name = u.name;
    } catch(_) {}
  }

  const origBtnHtml = proUpgradeBtn ? proUpgradeBtn.innerHTML : '';
  if (proUpgradeBtn) {
    proUpgradeBtn.disabled = true;
    proUpgradeBtn.innerHTML = '<span>⏳</span> <span>Connecting to Razorpay...</span>';
  }

  try {
    const relayBase = 'https://nxtslide.online';

    // 1. Create order on relay server
    const token = localStorage.getItem('nxtslide_auth_token') || localStorage.getItem('auth_token') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${relayBase}/api/billing/subscribe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, name })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Could not initiate payment: ' + (err.error || 'Server error. Please try again.'));
      if (proUpgradeBtn) {
        proUpgradeBtn.disabled = false;
        proUpgradeBtn.innerHTML = origBtnHtml;
      }
      return;
    }

    const order = await res.json();

    // 2. If inside native Android companion app, use Razorpay Native Android SDK
    // This natively displays all installed UPI apps (Google Pay, PhonePe, Paytm, CRED) at the top!
    if (window.AndroidApp && typeof window.AndroidApp.startRazorpayPayment === 'function') {
      window.AndroidApp.startRazorpayPayment(
        order.orderId,
        order.amount,
        order.key,
        email,
        name
      );
      if (proUpgradeBtn) {
        proUpgradeBtn.disabled = false;
        proUpgradeBtn.innerHTML = origBtnHtml;
      }
      return;
    }

    // 3. Fallback for mobile web browser: Ensure Razorpay checkout.js is loaded
    if (!window.Razorpay) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    // 4. Open Razorpay Checkout modal (supports UPI GPay, PhonePe, Paytm, CRED, Cards)
    const rzp = new window.Razorpay({
      key:         order.key,
      amount:      order.amount,
      currency:    order.currency || 'INR',
      name:        'NXTslide',
      description: 'Lifetime Pro Plan (Permanent License)',
      order_id:    order.orderId,
      prefill: {
        name:  order.user?.name  || name  || '',
        email: order.user?.email || email || '',
      },
      theme: { color: '#22c55e' },
      modal: {
        ondismiss: function() {
          if (proUpgradeBtn) {
            proUpgradeBtn.disabled = false;
            proUpgradeBtn.innerHTML = origBtnHtml;
          }
        }
      },
      handler: async function(response) {
        if (proUpgradeBtn) {
          proUpgradeBtn.innerHTML = '<span>✅</span> <span>Verifying Payment...</span>';
        }

        try {
          await fetch(`${relayBase}/api/billing/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId:   response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              email:     email
            })
          });
        } catch(e) {
          console.warn('[Billing] Verify request warning:', e);
        }

        // Save Pro status to Android SharedPreferences
        if (window.AndroidApp && typeof window.AndroidApp.setProUnlocked === 'function') {
          try {
            window.AndroidApp.setProUnlocked(true, email);
          } catch(_) {}
        }

        // Save Pro status locally
        localStorage.setItem('nxtslide_pro_unlocked', 'true');
        const userData = { email, name, isPro: true, plan: 'pro' };
        localStorage.setItem('nxtslide_user', JSON.stringify(userData));

        // Close modal
        const modal = document.getElementById('mobileProModal');
        if (modal) modal.style.display = 'none';

        if (proUpgradeBtn) {
          proUpgradeBtn.disabled = false;
          proUpgradeBtn.innerHTML = origBtnHtml;
        }

        // Update Account Pill UI if present
        if (typeof window.nxtslideOnAuthSuccess === 'function') {
          window.nxtslideOnAuthSuccess(userData);
        }

        alert('🎉 Congratulations!\n\nNXTslide Lifetime Pro is now activated.\nYou have unlimited access to Stealth Blackout Mode, Virtual Laser Pointer, Touchpad, and Multi-Device presentation forever!');
      }
    });

    rzp.on('payment.failed', function(resp) {
      console.error('[Billing] Payment failed:', resp.error);
      alert('Payment cancelled or failed: ' + (resp.error?.description || 'Please try again.'));
      if (proUpgradeBtn) {
        proUpgradeBtn.disabled = false;
        proUpgradeBtn.innerHTML = origBtnHtml;
      }
    });

    rzp.open();
  } catch(err) {
    console.error('[Billing] Checkout error:', err);
    alert('Error opening payment checkout: ' + (err.message || 'Please check your connection and try again.'));
    if (proUpgradeBtn) {
      proUpgradeBtn.disabled = false;
      proUpgradeBtn.innerHTML = origBtnHtml;
    }
  }
}

// Global callback from Android Native Razorpay SDK
window.onNativePaymentSuccess = function(paymentId) {
  localStorage.setItem('nxtslide_pro_unlocked', 'true');
  const proEmailInput = document.getElementById('proEmailInput');
  const email = (proEmailInput && proEmailInput.value) || 'pro@nxtslide.online';
  const userData = { email, isPro: true, plan: 'pro' };
  localStorage.setItem('nxtslide_user', JSON.stringify(userData));

  const modal = document.getElementById('mobileProModal');
  if (modal) modal.style.display = 'none';

  if (typeof window.nxtslideOnAuthSuccess === 'function') {
    window.nxtslideOnAuthSuccess(userData);
  }
};

window.onNativePaymentError = function(errorMsg) {
  const proUpgradeBtn = document.getElementById('proUpgradeBtn');
  if (proUpgradeBtn) {
    proUpgradeBtn.disabled = false;
    proUpgradeBtn.innerHTML = '<span>⚡ Pay ₹149 via UPI / Cards</span>';
  }
};

if (proUpgradeBtn) {
  proUpgradeBtn.addEventListener('click', startInAppProUpgrade);
}

// Modal open / close
if (toolLaser) {
  toolLaser.addEventListener('click', () => {
    if (!isProActive()) {
      showProPaywall('Virtual Laser Pointer & 3D Gyro Aiming');
      return;
    }
    applyGyroAvailability(hasHardwareGyro);
    if (laserModal) laserModal.classList.add('open');
  });
}

if (closeLaserModal) {
  closeLaserModal.addEventListener('click', () => {
    if (laserModal) laserModal.classList.remove('open');
    if (isLaserPointing) {
      isLaserPointing = false;
      sendLaserWs({ type: 'LASER_UP' });
    }
  });
}

if (laserStyleBtn) {
  laserStyleBtn.addEventListener('click', () => {
    if (laserStyle === 'laser') {
      laserStyle = 'spotlight';
      laserStyleBtn.textContent = '🔦 Spotlight';
      laserStyleBtn.style.color = '#fef08a';
      laserStyleBtn.style.background = 'rgba(234,179,8,0.18)';
      laserStyleBtn.style.borderColor = 'rgba(234,179,8,0.35)';
    } else {
      laserStyle = 'laser';
      laserStyleBtn.textContent = '🔴 Laser';
      laserStyleBtn.style.color = '#fda4af';
      laserStyleBtn.style.background = 'rgba(244,63,94,0.15)';
      laserStyleBtn.style.borderColor = 'rgba(244,63,94,0.3)';
    }
    sendLaserWs({ type: 'LASER_STYLE', style: laserStyle });
  });
}

// Tabs: Gyro vs Touchpad
if (tabLaserGyro && tabLaserTouch) {
  tabLaserGyro.addEventListener('click', () => {
    if (!hasHardwareGyro) return;
    laserActiveMode = 'gyro';
    tabLaserGyro.classList.add('active');
    tabLaserTouch.classList.remove('active');
    if (viewLaserGyro) {
      viewLaserGyro.style.display = 'flex';
      viewLaserGyro.classList.add('active');
    }
    if (viewLaserTouch) {
      viewLaserTouch.style.display = 'none';
      viewLaserTouch.classList.remove('active');
    }
  });

  tabLaserTouch.addEventListener('click', () => {
    laserActiveMode = 'touch';
    tabLaserTouch.classList.add('active');
    tabLaserGyro.classList.remove('active');
    if (viewLaserTouch) {
      viewLaserTouch.style.display = 'flex';
      viewLaserTouch.classList.add('active');
    }
    if (viewLaserGyro) {
      viewLaserGyro.style.display = 'none';
      viewLaserGyro.classList.remove('active');
    }
  });
}

// Read phone pitch for 6-DOF projection
window.addEventListener('deviceorientation', (e) => {
  if (e.beta !== null) laserPhonePitch = e.beta;
});

// Gyro Aiming Engine
let laserLastTime = performance.now();

window.addEventListener('devicemotion', (e) => {
  if (!isLaserPointing || laserActiveMode !== 'gyro' || !e.rotationRate) return;

  const now = performance.now();
  const dt = Math.min((now - laserLastTime) / 1000, 0.04);
  laserLastTime = now;

  const rr = e.rotationRate;
  const pitchRad = (Math.max(10, Math.min(85, laserPhonePitch)) * Math.PI) / 180;
  const sinP = Math.sin(pitchRad);
  const cosP = Math.cos(pitchRad);

  // Projected horizontal yaw
  const rawYaw = (rr.alpha * sinP + rr.gamma * cosP);
  const rawPitch = rr.beta;

  const deadzone = 0.5;
  const sensX = 0.0048;
  const sensY = 0.0040;

  function filterDeadzone(rate) {
    const abs = Math.abs(rate);
    if (abs < deadzone) return 0;
    const sign = Math.sign(rate);
    return sign * ((abs - deadzone) * 0.95);
  }

  let vy = filterDeadzone(rawYaw);
  let vp = -filterDeadzone(rawPitch);

  let rawTargetX = Math.max(0.01, Math.min(0.99, laserPointerX - vy * dt * sensX * 30));
  let rawTargetY = Math.max(0.01, Math.min(0.99, laserPointerY - vp * dt * sensY * 30));

  laserPointerX = laserFilterX.filter(rawTargetX, now);
  laserPointerY = laserFilterY.filter(rawTargetY, now);

  sendLaserWs({
    type: 'LASER_MOVE',
    x: laserPointerX,
    y: laserPointerY
  });
});

// Global callbacks from Android companion hardware
window.onHardwareLaserStart = function() {
  if (!hasHardwareGyro) return;
  if (laserModal) laserModal.classList.add('open');
  if (laserClutchBtn) laserClutchBtn.classList.add('pressed');
};

window.onHardwareLaserStop = function() {
  if (laserClutchBtn) laserClutchBtn.classList.remove('pressed');
};

// Clutch Button (Gyro Aiming)
if (laserClutchBtn) {
  laserClutchBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (window.AndroidApp && typeof window.AndroidApp.startHardwareLaser === 'function') {
      window.AndroidApp.startHardwareLaser();
      return;
    }
    isLaserPointing = true;
    laserClutchBtn.classList.add('pressed');
    buzz('next');

    laserPointerX = 0.5;
    laserPointerY = 0.5;
    laserFilterX.reset(0.5);
    laserFilterY.reset(0.5);
    laserLastTime = performance.now();

    sendLaserWs({
      type: 'LASER_DOWN',
      x: 0.5,
      y: 0.5,
      style: laserStyle
    });
  });

  const onLaserRelease = (e) => {
    if (window.AndroidApp && typeof window.AndroidApp.stopHardwareLaser === 'function') {
      window.AndroidApp.stopHardwareLaser();
      return;
    }
    if (!isLaserPointing) return;
    isLaserPointing = false;
    laserClutchBtn.classList.remove('pressed');
    sendLaserWs({ type: 'LASER_UP' });
  };

  window.addEventListener('pointerup', onLaserRelease);
  window.addEventListener('pointercancel', onLaserRelease);
}

// Touchpad Drag Mode
if (laserTouchpad) {
  let touchStartX = 0;
  let touchStartY = 0;
  let padBaseX = 0.5;
  let padBaseY = 0.5;

  laserTouchpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isLaserPointing = true;
    buzz('next');

    const rect = laserTouchpad.getBoundingClientRect();
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    padBaseX = laserPointerX;
    padBaseY = laserPointerY;

    sendLaserWs({
      type: 'LASER_DOWN',
      x: laserPointerX,
      y: laserPointerY,
      style: laserStyle
    });
  });

  laserTouchpad.addEventListener('pointermove', (e) => {
    if (!isLaserPointing || laserActiveMode !== 'touch') return;

    const rect = laserTouchpad.getBoundingClientRect();
    const sens = 0.85;

    const deltaX = ((e.clientX - touchStartX) / rect.width) * sens;
    const deltaY = ((e.clientY - touchStartY) / rect.height) * sens;

    laserPointerX = Math.max(0.01, Math.min(0.99, padBaseX + deltaX));
    laserPointerY = Math.max(0.01, Math.min(0.99, padBaseY + deltaY));

    sendLaserWs({
      type: 'LASER_MOVE',
      x: laserPointerX,
      y: laserPointerY
    });
  });

  laserTouchpad.addEventListener('pointerup', () => {
    if (!isLaserPointing) return;
    isLaserPointing = false;
    sendLaserWs({ type: 'LASER_UP' });
  });
}

if (laserRecenterBtn) {
  laserRecenterBtn.addEventListener('click', () => {
    laserPointerX = 0.5;
    laserPointerY = 0.5;
    laserFilterX.reset(0.5);
    laserFilterY.reset(0.5);
    sendLaserWs({ type: 'LASER_MOVE', x: 0.5, y: 0.5 });
    buzz('next');
  });
}

// ══════════════════════════════════════════════════════════
//  Stealth Blackout Mode (OLED Fake Screen-Off Touchpad)
// ══════════════════════════════════════════════════════════
const btnEnterStealth = document.getElementById('btnEnterStealth');
const stealthOverlay  = document.getElementById('stealthOverlay');
const btnExitStealth  = document.getElementById('btnExitStealth');
const stealthHintBox  = document.getElementById('stealthHintBox');

let isStealthActive = false;
let stealthHintTimer = null;

function enterStealthMode() {
  if (!isProActive()) {
    showProPaywall('Stealth Blackout Mode');
    return;
  }

  isStealthActive = true;
  if (stealthOverlay) {
    stealthOverlay.classList.add('active');
  }

  // Close Laser modal so it doesn't stay open behind
  if (laserModal) {
    laserModal.classList.remove('open');
  }

  // Dim Android screen brightness to 0.01 (near pitch black)
  if (window.AndroidApp && typeof window.AndroidApp.setStealthBrightness === 'function') {
    try {
      window.AndroidApp.setStealthBrightness(true);
    } catch (_) {}
  }

  // Haptic feedback confirming stealth mode entry
  buzz('next');

  // Fade out hints after 2.8 seconds so screen becomes 100% pitch black
  if (stealthHintBox) {
    stealthHintBox.style.opacity = '1';
    stealthHintBox.style.display = 'flex';
    clearTimeout(stealthHintTimer);
    stealthHintTimer = setTimeout(() => {
      stealthHintBox.style.opacity = '0';
      setTimeout(() => {
        if (isStealthActive && stealthHintBox) stealthHintBox.style.display = 'none';
      }, 1200);
    }, 2800);
  }
}

function exitStealthMode() {
  if (!isStealthActive) return;
  isStealthActive = false;

  if (stealthOverlay) {
    stealthOverlay.classList.remove('active');
  }

  // Restore screen brightness in Android companion
  if (window.AndroidApp && typeof window.AndroidApp.setStealthBrightness === 'function') {
    try {
      window.AndroidApp.setStealthBrightness(false);
    } catch (_) {}
  }

  // Turn off laser pointer if pointing
  if (isLaserPointing) {
    isLaserPointing = false;
    sendLaserWs({ type: 'LASER_UP' });
  }

  // Double buzz feedback on exit
  buzz('prev');

  if (stealthHintBox) {
    stealthHintBox.style.opacity = '1';
    stealthHintBox.style.display = 'flex';
  }
}

if (btnEnterStealth) {
  btnEnterStealth.addEventListener('click', enterStealthMode);
}

if (btnExitStealth) {
  btnExitStealth.addEventListener('click', (e) => {
    e.stopPropagation();
    exitStealthMode();
  });
}

// Stealth Touchpad & Gesture Handlers
if (stealthOverlay) {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let hasLaserDragStarted = false;
  let padBaseX = 0.5;
  let padBaseY = 0.5;

  // Two-finger touch anywhere exits Stealth Mode immediately
  stealthOverlay.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length >= 2) {
      exitStealthMode();
    }
  }, { passive: true });

  stealthOverlay.addEventListener('pointerdown', (e) => {
    // If clicking exit button, let its listener handle it
    if (e.target === btnExitStealth || (btnExitStealth && btnExitStealth.contains(e.target))) return;

    e.preventDefault();
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    touchStartTime = performance.now();
    hasLaserDragStarted = false;
    padBaseX = laserPointerX;
    padBaseY = laserPointerY;
  });

  stealthOverlay.addEventListener('pointermove', (e) => {
    if (!isStealthActive || touchStartTime === 0) return;

    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    const dist = Math.hypot(dx, dy);

    // If moved > 10px, activate laser aiming
    if (!hasLaserDragStarted && dist > 10) {
      hasLaserDragStarted = true;
      isLaserPointing = true;
      sendLaserWs({
        type: 'LASER_DOWN',
        x: laserPointerX,
        y: laserPointerY,
        style: laserStyle
      });
      buzz('next');
    }

    if (hasLaserDragStarted) {
      const sens = 0.90;
      const w = window.innerWidth || 360;
      const h = window.innerHeight || 640;

      laserPointerX = Math.max(0.01, Math.min(0.99, padBaseX + (dx / w) * sens));
      laserPointerY = Math.max(0.01, Math.min(0.99, padBaseY + (dy / h) * sens));

      sendLaserWs({
        type: 'LASER_MOVE',
        x: laserPointerX,
        y: laserPointerY
      });
    }
  });

  const onStealthPointerUp = (e) => {
    if (!isStealthActive || touchStartTime === 0) return;
    const duration = performance.now() - touchStartTime;
    touchStartTime = 0;

    if (hasLaserDragStarted) {
      hasLaserDragStarted = false;
      isLaserPointing = false;
      sendLaserWs({ type: 'LASER_UP' });
    } else if (duration < 450) {
      // Tap detected!
      const clickX = e.clientX || touchStartX;
      const screenWidth = window.innerWidth || 360;

      if (clickX > screenWidth * 0.42) {
        // Right side -> NEXT slide
        send('NEXT', 'Stealth Mode Tap');
      } else {
        // Left side -> PREVIOUS slide
        send('PREV', 'Stealth Mode Tap');
      }
    }
  };

  stealthOverlay.addEventListener('pointerup', onStealthPointerUp);
  stealthOverlay.addEventListener('pointercancel', onStealthPointerUp);
}


