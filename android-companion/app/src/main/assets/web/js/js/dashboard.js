// Dashboard Controller for nextPresent
let ws = null;
let currentRemoteUrl = '';
let currentPort = 3333;

const qrCodeImg = document.getElementById('qrCodeImg');
const ipSelect = document.getElementById('ipSelect');
const remoteUrlDisplay = document.getElementById('remoteUrlDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const wsStatusPill = document.getElementById('wsStatusPill');
const wsStatusText = document.getElementById('wsStatusText');

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

// Initialize Dashboard
async function initDashboard() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();

    currentPort = data.port;
    currentRemoteUrl = data.remoteUrl;
    qrCodeImg.src = data.qrDataUrl;
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

    updateSessionUI(data.sessionState);
    connectWebSocket();
  } catch (err) {
    console.error('Failed to load server info:', err);
  }
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
