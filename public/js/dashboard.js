// Dashboard Controller for NXTslide
let ws = null;
let currentRemoteUrl = '';
let currentPort = 3333;

const qrCodeImg = document.getElementById('qrCodeImg');
const ipSelect = document.getElementById('ipSelect');
const remoteUrlDisplay = document.getElementById('remoteUrlDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const wsStatusPill = document.getElementById('wsStatusPill');
const wsStatusText = document.getElementById('wsStatusText');
const btnStopServer = document.getElementById('btnStopServer');

const connectedClientsVal = document.getElementById('connectedClientsVal');
const slideNumberVal = document.getElementById('slideNumberVal');
const presentationTimerVal = document.getElementById('presentationTimerVal');
const totalClicksVal = document.getElementById('totalClicksVal');
const clickRatioVal = document.getElementById('clickRatioVal');
const eventLogBox = document.getElementById('eventLogBox');
const btnClearLog = document.getElementById('btnClearLog');

// Test Pad Buttons
const btnNext = document.getElementById('btnNext');
const btnPrev = document.getElementById('btnPrev');
const btnF5 = document.getElementById('btnF5');
const btnShiftF5 = document.getElementById('btnShiftF5');
const btnBlackout = document.getElementById('btnBlackout');
const btnWhiteout = document.getElementById('btnWhiteout');
const btnEsc = document.getElementById('btnEsc');

// Profile Selector
const profileSelect = document.getElementById('profileSelect');
const profileKeyHint = document.getElementById('profileKeyHint');

const PROFILE_HINTS = {
  powerpoint: 'Next → Right Arrow  |  Prev → Left Arrow  |  Blackout → B  |  Start → F5',
  google_slides: 'Next → Right Arrow  |  Prev → Left Arrow  |  Fullscreen / Exit → Esc',
  canva: 'Next → Right Arrow  |  Prev → Left Arrow  |  Exit → Esc',
  libreoffice: 'Next → Page Down  |  Prev → Page Up  |  Start → F5',
  pdf: 'Next → Page Down  |  Prev → Page Up  |  (Adobe, Edge, Chrome PDF)',
  prezi: 'Next → Spacebar  |  Prev → Backspace',
  keynote_mac: 'Next → Right Arrow  |  Prev → Left Arrow'
};

// Profile Switcher
function applyProfileUI(profile) {
  if (!profile) return;
  if (profileSelect.value !== profile) {
    profileSelect.value = profile;
  }
  if (PROFILE_HINTS[profile]) {
    profileKeyHint.textContent = PROFILE_HINTS[profile];
  }
}

profileSelect.addEventListener('change', (e) => {
  const chosen = e.target.value;
  applyProfileUI(chosen);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'SET_PROFILE', profile: chosen }));
  } else {
    fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: chosen })
    }).catch(console.error);
  }
  logEvent(`Profile switched to: ${chosen}`, 'Dashboard Settings', 'special');
});

// Relay UI elements
const relayBanner      = document.getElementById('relayBanner');
const relayConnecting  = document.getElementById('relayConnecting');
const roomCodeDisplay  = document.getElementById('roomCodeDisplay');
const copyRelayUrlBtn  = document.getElementById('copyRelayUrlBtn');
const shareRelayBtn    = document.getElementById('shareRelayBtn');

let relayPhoneUrl = '';

function updateRelayUI(relay) {
  if (!relay) return;

  // Hide the connecting spinner always once we got a response
  if (relayConnecting) relayConnecting.style.display = 'none';

  if (relay.connected && relay.roomCode) {
    // Format code as ABC-123 (first 3 + dash + last 3)
    const code = relay.roomCode;
    const formatted = code.length === 6
      ? `${code.slice(0, 3)}-${code.slice(3)}`
      : code;

    if (roomCodeDisplay) roomCodeDisplay.textContent = formatted;
    if (relayBanner)     relayBanner.style.display = 'block';

    relayPhoneUrl = relay.phoneUrl || '';

    // Show native Share button if supported
    if (shareRelayBtn && navigator.share) {
      shareRelayBtn.style.display = 'inline-block';
    }
  } else {
    // Not connected yet — keep banner hidden, re-poll in 5s
    setTimeout(() => fetch('/api/info').then(r => r.json()).then(d => updateRelayUI(d.relay)).catch(() => {}), 5000);
  }
}

// Copy relay link button
if (copyRelayUrlBtn) {
  copyRelayUrlBtn.addEventListener('click', () => {
    if (!relayPhoneUrl) return;
    navigator.clipboard.writeText(relayPhoneUrl).then(() => {
      const orig = copyRelayUrlBtn.textContent;
      copyRelayUrlBtn.textContent = '✅ Copied!';
      setTimeout(() => { copyRelayUrlBtn.textContent = orig; }, 1800);
    }).catch(() => {
      prompt('Copy this link:', relayPhoneUrl);
    });
  });
}

// Native share button (mobile-friendly)
if (shareRelayBtn) {
  shareRelayBtn.addEventListener('click', async () => {
    if (!relayPhoneUrl) return;
    try {
      await navigator.share({
        title: 'Join my NXTslide session',
        text: 'Tap to open the slide remote',
        url: relayPhoneUrl,
      });
    } catch (_) {}
  });
}

// ─────────────────────────────────────────────────────────────────────
// Stop Server Button
// ─────────────────────────────────────────────────────────────────────
if (btnStopServer) {
  btnStopServer.addEventListener('click', async () => {
    const confirmed = confirm(
      'Stop the NXTslide server?\n\n' +
      'All connected phones will lose their connection. ' +
      'You can restart the app to resume hosting.'
    );
    if (!confirmed) return;

    btnStopServer.classList.add('stopping');
    btnStopServer.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      Stopping...`;

    try {
      await fetch('/api/server/stop', { method: 'POST' });
    } catch (_) {
      // Server closed — connection will drop, that's expected
    }

    if (ws) { try { ws.close(); } catch (_) {} }
    if (wsStatusPill) {
      wsStatusPill.style.background = 'rgba(239,68,68,0.1)';
      wsStatusPill.style.borderColor = 'rgba(239,68,68,0.3)';
      wsStatusPill.style.color = '#f87171';
    }
    if (wsStatusText) wsStatusText.textContent = 'Server Stopped';
    btnStopServer.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      Stopped`;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Mode Toggle (Local Wi-Fi Free vs. Cloud Relay Pro)
// ─────────────────────────────────────────────────────────────────────
const btnModeLocal      = document.getElementById('btnModeLocal');
const btnModeCloud      = document.getElementById('btnModeCloud');
const cloudModeBadge    = document.getElementById('cloudModeBadge');
const localConnectView  = document.getElementById('localConnectView');
const cloudConnectView  = document.getElementById('cloudConnectView');
const connectSubtitle   = document.getElementById('connectSubtitle');
const cloudQrCodeImg    = document.getElementById('cloudQrCodeImg');

const proModalBackdrop  = document.getElementById('proModalBackdrop');
const closeProModalBtn  = document.getElementById('closeProModalBtn');
const licenseKeyInput   = document.getElementById('licenseKeyInput');
const btnActivateKey    = document.getElementById('btnActivateKey');
const licenseFeedback   = document.getElementById('licenseFeedback');

let currentMode = 'local';

function isProUnlocked() {
  return localStorage.getItem('nxtslide_pro_unlocked') === 'true';
}

function updateProBadge() {
  if (!cloudModeBadge) return;
  if (isProUnlocked()) {
    cloudModeBadge.textContent = 'PRO ✓';
    cloudModeBadge.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    cloudModeBadge.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.4)';
  } else {
    cloudModeBadge.textContent = 'PRO 🔒';
    cloudModeBadge.style.background = '';
    cloudModeBadge.style.boxShadow = '';
  }
}

function switchMode(mode) {
  if (mode === 'local') {
    currentMode = 'local';
    if (btnModeLocal) btnModeLocal.classList.add('active');
    if (btnModeCloud) btnModeCloud.classList.remove('active');
    if (localConnectView) localConnectView.style.display = 'block';
    if (cloudConnectView) cloudConnectView.style.display = 'none';
    if (connectSubtitle) connectSubtitle.textContent = 'Scan QR code or open URL on your mobile browser';
  } else if (mode === 'cloud') {
    currentMode = 'cloud';
    if (btnModeCloud) btnModeCloud.classList.add('active');
    if (btnModeLocal) btnModeLocal.classList.remove('active');
    if (cloudConnectView) cloudConnectView.style.display = 'block';
    if (localConnectView) localConnectView.style.display = 'none';
    if (connectSubtitle) connectSubtitle.textContent = 'Enter the 6-letter room code or scan cloud QR code';
  }
}

function openProModal() {
  if (proModalBackdrop) {
    proModalBackdrop.style.display = 'flex';
    if (licenseKeyInput) licenseKeyInput.value = '';
    if (licenseFeedback) {
      licenseFeedback.textContent = '';
      licenseFeedback.className = 'license-feedback';
    }
  }
}

function closeProModal() {
  if (proModalBackdrop) {
    proModalBackdrop.style.display = 'none';
  }
}

const btnBuyProLifetime  = document.getElementById('btnBuyProLifetime');

async function handleLicenseActivation() {
  const key = (licenseKeyInput ? licenseKeyInput.value : '').trim();
  if (!key || key.length < 6) {
    if (licenseFeedback) {
      licenseFeedback.className = 'license-feedback error';
      licenseFeedback.textContent = 'Please enter a valid license key (min 6 characters).';
    }
    return;
  }

  if (btnActivateKey) {
    btnActivateKey.disabled = true;
    btnActivateKey.textContent = 'Verifying...';
  }

  if (licenseFeedback) {
    licenseFeedback.className = 'license-feedback';
    licenseFeedback.textContent = 'Validating license with server...';
  }

  try {
    const res = await fetch('/api/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      localStorage.setItem('nxtslide_pro_unlocked', 'true');
      updateProBadge();
      if (licenseFeedback) {
        licenseFeedback.className = 'license-feedback success';
        licenseFeedback.textContent = data.message || '✅ Pro Lifetime Activated!';
      }
      setTimeout(() => {
        closeProModal();
        switchMode('cloud');
      }, 1200);
    } else {
      if (licenseFeedback) {
        licenseFeedback.className = 'license-feedback error';
        licenseFeedback.textContent = data.message || 'Invalid license key. Please check and try again.';
      }
    }
  } catch (err) {
    // Fallback: if server endpoint has a network hitch, check key format locally
    if (key.length >= 8) {
      localStorage.setItem('nxtslide_pro_unlocked', 'true');
      updateProBadge();
      if (licenseFeedback) {
        licenseFeedback.className = 'license-feedback success';
        licenseFeedback.textContent = '✅ Pro Lifetime Activated!';
      }
      setTimeout(() => {
        closeProModal();
        switchMode('cloud');
      }, 1200);
    } else {
      if (licenseFeedback) {
        licenseFeedback.className = 'license-feedback error';
        licenseFeedback.textContent = 'Verification error. Please check your key.';
      }
    }
  } finally {
    if (btnActivateKey) {
      btnActivateKey.disabled = false;
      btnActivateKey.textContent = 'Activate';
    }
  }
}

function initModeSwitcher() {
  updateProBadge();

  if (btnModeLocal) {
    btnModeLocal.addEventListener('click', () => switchMode('local'));
  }

  if (btnModeCloud) {
    btnModeCloud.addEventListener('click', () => {
      if (isProUnlocked()) {
        switchMode('cloud');
      } else {
        openProModal();
      }
    });
  }

  if (closeProModalBtn) {
    closeProModalBtn.addEventListener('click', closeProModal);
  }

  if (proModalBackdrop) {
    proModalBackdrop.addEventListener('click', (e) => {
      if (e.target === proModalBackdrop) closeProModal();
    });
  }

  if (btnActivateKey) {
    btnActivateKey.addEventListener('click', handleLicenseActivation);
  }

  if (licenseKeyInput) {
    licenseKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLicenseActivation();
    });
  }
}

// Initialize Dashboard
async function initDashboard() {
  initModeSwitcher();

  // Detect if we're running on the cloud (Render) vs locally
  const isCloud = location.hostname.includes('onrender.com') ||
                  location.hostname.includes('netlify.app') ||
                  location.hostname.includes('vercel.app') ||
                  location.hostname.includes('github.io');

  if (isCloud) {
    showNoServerOverlay();
    return;
  }

  try {
    const res = await fetch('/api/info');
    if (!res.ok) throw new Error('Server not running');
    const data = await res.json();

    currentPort = data.port;
    currentRemoteUrl = data.remoteUrl;
    qrCodeImg.src = data.lanQrDataUrl || data.qrDataUrl;
    if (cloudQrCodeImg && data.cloudQrDataUrl) {
      cloudQrCodeImg.src = data.cloudQrDataUrl;
    }
    remoteUrlDisplay.textContent = currentRemoteUrl;

    // Populate IP Dropdown
    ipSelect.innerHTML = '';
    data.allIps.forEach(net => {
      const opt = document.createElement('option');
      opt.value = net.address;
      opt.textContent = `${net.interface} (${net.address})${net.isVirtual ? ' [Virtual]' : ''}`;
      if (net.address === data.primaryIp) opt.selected = true;
      ipSelect.appendChild(opt);
    });

    if (data.sessionState && data.sessionState.activeProfile) {
      applyProfileUI(data.sessionState.activeProfile);
    } else if (data.activeProfile) {
      applyProfileUI(data.activeProfile);
    }

    // Synchronize Pro License status from server
    if (data.license) {
      if (data.license.isPro) {
        localStorage.setItem('nxtslide_pro_unlocked', 'true');
        updateProBadge();
      }
      if (data.license.checkoutUrl && btnBuyProLifetime) {
        btnBuyProLifetime.href = data.license.checkoutUrl;
      }
    }

    // Show relay room code banner
    updateRelayUI(data.relay);

    updateSessionUI(data.sessionState);
    connectWebSocket();
  } catch (err) {
    console.error('Failed to load server info:', err);
    showNoServerOverlay();
  }
}

function showNoServerOverlay() {
  // Update header status pill to show offline
  if (wsStatusPill) {
    wsStatusPill.style.borderColor = 'rgba(245,158,11,0.4)';
    wsStatusPill.style.background  = 'rgba(245,158,11,0.1)';
    wsStatusPill.style.color       = '#fbbf24';
  }
  if (wsStatusText) wsStatusText.textContent = 'Desktop App Not Running';

  // Replace the relay connecting spinner with a clear message
  const relayConnecting = document.getElementById('relayConnecting');
  if (relayConnecting) {
    relayConnecting.innerHTML = `
      <div style="padding:4px 0 2px;font-size:1rem;">🖥️</div>
      <div style="font-weight:700;color:#fbbf24;margin-bottom:4px;">Desktop App Required</div>
      <div style="font-size:0.75rem;color:#94a3b8;line-height:1.5;">
        The dashboard only works when the NXTslide desktop app (or <code style="color:#a5b4fc">node server.js</code>) is running on your PC.<br><br>
        <a href="https://github.com/DilpreetSinghVerma/nextPresent/releases/latest"
           target="_blank" rel="noopener"
           style="color:#818cf8;text-decoration:underline;">Download NXTslide for Windows →</a>
      </div>
    `;
    relayConnecting.style.padding = '16px';
    relayConnecting.style.borderColor = 'rgba(245,158,11,0.3)';
  }

  // Replace QR image with placeholder message
  if (qrCodeImg) {
    qrCodeImg.style.display = 'none';
    const qrParent = qrCodeImg.parentElement;
    if (qrParent) {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;width:160px;height:160px;background:rgba(255,255,255,0.03);border:2px dashed rgba(99,102,241,0.3);border-radius:12px;color:#475569;font-size:0.72rem;text-align:center;gap:8px;padding:12px;';
      placeholder.innerHTML = '<span style="font-size:2rem;">🖥️</span><span>Open the desktop app to generate QR code</span>';
      qrParent.appendChild(placeholder);
    }
  }

  // Replace IP dropdown
  if (ipSelect) {
    ipSelect.innerHTML = '<option>— App not running —</option>';
    ipSelect.disabled = true;
  }
  if (remoteUrlDisplay) remoteUrlDisplay.textContent = 'http://...';
}

// IP Switcher
ipSelect.addEventListener('change', async (e) => {
  const chosenIp = e.target.value;
  if (!chosenIp) return;

  const newUrl = `http://${chosenIp}:${currentPort}/remote`;
  currentRemoteUrl = newUrl;
  remoteUrlDisplay.textContent = newUrl;

  // Re-fetch QR from server or generate client-side
  try {
    const res = await fetch(`/api/info?ip=${chosenIp}`);
    const data = await res.json();
    qrCodeImg.src = data.qrDataUrl;
  } catch (_) {}
});

// Copy URL
copyUrlBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentRemoteUrl).then(() => {
    const orig = copyUrlBtn.textContent;
    copyUrlBtn.textContent = 'Copied!';
    setTimeout(() => copyUrlBtn.textContent = orig, 1800);
  });
});

// WebSocket Connection
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    wsStatusPill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    wsStatusPill.style.background = 'rgba(16, 185, 129, 0.1)';
    wsStatusPill.style.color = '#10b981';
    wsStatusText.textContent = `Listening on Port ${currentPort} (Connected)`;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'INIT' || data.type === 'STATE_SYNC') {
        if (data.sessionState && data.sessionState.activeProfile) {
          applyProfileUI(data.sessionState.activeProfile);
        } else if (data.activeProfile) {
          applyProfileUI(data.activeProfile);
        }
        updateSessionUI(data.sessionState);
      } else if (data.type === 'PROFILE_CHANGED') {
        applyProfileUI(data.profile);
        logEvent(`Profile changed: ${data.profileInfo ? data.profileInfo.label : data.profile}`, 'Settings', 'special');
        if (data.sessionState) updateSessionUI(data.sessionState);
      } else if (data.type === 'KEY_EVENT') {
        logKeyEvent(data.action, data.source, data.keyCommand);
        if (data.sessionState) updateSessionUI(data.sessionState);
      } else if (data.type === 'CLIENT_CONNECTED') {
        connectedClientsVal.textContent = data.clientCount;
        logEvent('Device Connected', data.isMobile ? '📱 Mobile Phone' : '💻 Browser', 'special');
      } else if (data.type === 'CLIENT_DISCONNECTED') {
        connectedClientsVal.textContent = data.clientCount;
        logEvent('Device Disconnected', '', 'special');
      } else if (data.type === 'TIMER_SYNC') {
        updateTimerUI(data.sessionState);
      }
    } catch (err) {
      console.error('Error handling WS message:', err);
    }
  };

  ws.onclose = () => {
    wsStatusPill.style.borderColor = 'rgba(244, 63, 94, 0.3)';
    wsStatusPill.style.background = 'rgba(244, 63, 94, 0.1)';
    wsStatusPill.style.color = '#f43f5e';
    wsStatusText.textContent = 'Reconnecting...';
    setTimeout(connectWebSocket, 2000);
  };
}

// Update UI
function updateSessionUI(state) {
  if (!state) return;
  slideNumberVal.textContent = state.slideCount || 1;
  const total = (state.totalForwardClicks || 0) + (state.totalBackwardClicks || 0);
  totalClicksVal.textContent = total;
  clickRatioVal.textContent = `${state.totalForwardClicks || 0} fwd / ${state.totalBackwardClicks || 0} back`;
  connectedClientsVal.textContent = state.connectedClients || 0;
  if (state.activeProfile) applyProfileUI(state.activeProfile);
  updateTimerUI(state);
}

function updateTimerUI(state) {
  if (!state) return;
  const secs = state.elapsedSeconds || 0;
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  presentationTimerVal.textContent = `${m}:${s}`;
}

// Logging
function logKeyEvent(action, source, keyCommand) {
  let cssClass = 'special';
  let label = action;

  const keyDetail = keyCommand ? ` [${keyCommand}]` : '';

  if (action === 'NEXT' || action === 'PAGE_DOWN') {
    cssClass = 'next';
    label = `Next Slide (►)${keyDetail}`;
  } else if (action === 'PREV' || action === 'PAGE_UP') {
    cssClass = 'prev';
    label = `Previous Slide (◄)${keyDetail}`;
  } else if (action === 'F5') {
    label = `Start Presentation (F5)${keyDetail}`;
  } else if (action === 'SHIFT_F5') {
    label = `Start From Current (Shift+F5)${keyDetail}`;
  } else if (action === 'B') {
    label = `Toggle Black Screen (B)${keyDetail}`;
  } else if (action === 'W') {
    label = `Toggle White Screen (W)${keyDetail}`;
  } else if (action === 'ESC') {
    label = `Exit Presentation (Esc)${keyDetail}`;
  }

  logEvent(label, source, cssClass);
}

function logEvent(title, source, cssClass = 'special') {
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-action ${cssClass}">${title}</span>
    <span class="log-source">${source || ''}</span>
  `;
  eventLogBox.prepend(entry);

  // Keep max 50 items
  while (eventLogBox.children.length > 50) {
    eventLogBox.removeChild(eventLogBox.lastChild);
  }
}

btnClearLog.addEventListener('click', () => {
  eventLogBox.innerHTML = '';
});

// Test pad handlers
function sendCommand(action) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'COMMAND', action, source: 'PC Dashboard' }));
  } else {
    // HTTP API fallback
    fetch('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
  }
}

btnNext.addEventListener('click', () => sendCommand('NEXT'));
btnPrev.addEventListener('click', () => sendCommand('PREV'));
btnF5.addEventListener('click', () => sendCommand('F5'));
btnShiftF5.addEventListener('click', () => sendCommand('SHIFT_F5'));
btnBlackout.addEventListener('click', () => sendCommand('B'));
btnWhiteout.addEventListener('click', () => sendCommand('W'));
btnEsc.addEventListener('click', () => sendCommand('ESC'));

// Start
initDashboard();

// ─────────────────────────────────────────────────────────────────────
// Auto-Updater Notifications
// ─────────────────────────────────────────────────────────────────────
window.showUpdateToast = function(msg) {
  let toast = document.getElementById('autoUpdateToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'autoUpdateToast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#111111;border:1px solid rgba(34,197,94,0.4);color:#ededed;padding:12px 20px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.6);z-index:9999;font-size:0.875rem;display:flex;align-items:center;gap:12px;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span style="color:#22c55e;">✨</span> <span>${msg}</span>`;
};

window.showUpdateReadyToast = function(msg) {
  let toast = document.getElementById('autoUpdateToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'autoUpdateToast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#111111;border:1px solid #22c55e;color:#ededed;padding:12px 20px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.6);z-index:9999;font-size:0.875rem;display:flex;align-items:center;gap:12px;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span style="color:#22c55e;">🎉</span> <span>${msg}</span> <button onclick="window.close()" style="background:#16a34a;color:#fff;border:none;padding:6px 12px;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;margin-left:8px;">Restart</button>`;
};
