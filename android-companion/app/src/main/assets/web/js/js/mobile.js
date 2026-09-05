// ══════════════════════════════════════════════════════════
//  nextPresent Mobile Remote  •  mobile.js
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

// ══════════════════════════════════════════════════════════
//  WebSocket
// ══════════════════════════════════════════════════════════
function initWS() {
  const host = getServerHost();
  const wsUrl = `ws://${host.includes(':') ? host : host + ':3333'}/ws`;

  try {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  } catch (_) {}

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    connDot.classList.remove('off');
  };

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'INIT' || d.type === 'STATE_SYNC') {
        if (d.sessionState) syncState(d.sessionState);
        if (d.activeProfile) updateProfileUI(d.activeProfile);
        else if (d.sessionState && d.sessionState.activeProfile) updateProfileUI(d.sessionState.activeProfile);
      } else if (d.type === 'PROFILE_CHANGED') {
        updateProfileUI(d.profile);
      } else if (d.type === 'TIMER_SYNC') {
        syncTimer(d.sessionState);
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    connDot.classList.add('off');
    setTimeout(initWS, 2500);
  };
}

// ══════════════════════════════════════════════════════════
//  Send action
// ══════════════════════════════════════════════════════════
function send(action, source) {
  buzz(action);
  doFlash();

  const msg = JSON.stringify({ type: 'COMMAND', action, source: source || 'Mobile' });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);
  } else if (window.AndroidApp && typeof window.AndroidApp.sendAction === 'function') {
    window.AndroidApp.sendAction(action);
  } else {
    // HTTP fallback
    const host = getServerHost();
    fetch(`http://${host.includes(':') ? host : host + ':3333'}/api/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, source: source || 'Mobile' })
    }).catch(() => {});
  }
}

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
    title: 'nextPresent — Slide Controller',
    artist: 'Headset Next/Prev → change slides',
    album: 'nextPresent Remote Active',
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
