const fs      = require('fs');
const http    = require('http');
const path    = require('path');
const dgram   = require('dgram');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode  = require('qrcode');
const { getPrimaryLocalIp, getLocalIpAddresses } = require('./lib/network');
const keySender = require('./lib/keySender');
const licenseService = require('./lib/licenseService');
const cloudSync = require('./lib/cloudSync');

// ─────────────────────────────────────────────────────────────────────
// Cloud Relay Configuration
// Set RELAY_URL env var to enable cloud mode (e.g. wss://yourapp.railway.app)
// Leave unset to use LAN-only mode.
// ─────────────────────────────────────────────────────────────────────
const RELAY_BASE_URL = process.env.RELAY_URL || 'https://nxtslide.online';
const RELAY_WS_BASE  = RELAY_BASE_URL.replace(/^http/, 'ws');

// Keep cloud relay awake (prevents Render/free-tier cold starts)
setInterval(() => {
  if (RELAY_BASE_URL && !RELAY_BASE_URL.includes('localhost')) {
    fetch(`${RELAY_BASE_URL}/health`).catch(() => {});
  }
}, 10 * 60 * 1000); // every 10 min

let relayRoomCode   = null;   // e.g. 'ABC123'
let relayPhoneUrl   = null;   // share URL shown in QR
let relayWsClient   = null;   // WebSocket to relay (PC side)
let relayConnected  = false;
let relayPingTimer  = null;

/** Register a room on the relay server and connect the PC WebSocket */
async function connectToRelay() {
  const license = licenseService.getLicenseStatus();
  if (!license.isPro) {
    console.log('[Relay] Host is on Free Community plan. Cloud Relay is locked (Pro required).');
    relayConnected = false;
    relayRoomCode = null;
    relayPhoneUrl = null;
    return;
  }
  try {
    if (relayPingTimer) clearInterval(relayPingTimer);

    const res  = await fetch(`${RELAY_BASE_URL}/api/rooms`, { method: 'POST' });
    if (!res.ok) throw new Error(`Relay responded ${res.status}`);
    const data = await res.json();
    relayRoomCode = data.code;
    relayPhoneUrl = data.phoneUrl;  // https://...relay.../r/ABC123

    const wsUrl = data.wsUrl;       // wss://...relay.../ws/ABC123/pc
    relayWsClient = new WebSocket(wsUrl, { perMessageDeflate: false });

    relayWsClient.on('open', () => {
      relayConnected = true;
      if (relayWsClient._socket) {
        relayWsClient._socket.setNoDelay(true);
      }
      console.log(`[Relay] Connected as PC to room ${relayRoomCode}`);
      console.log(`[Relay] Share URL: ${relayPhoneUrl}`);

      // WebSocket heartbeat ping every 25s to keep NAT/firewalls warm
      relayPingTimer = setInterval(() => {
        if (relayWsClient && relayWsClient.readyState === WebSocket.OPEN) {
          relayWsClient.ping();
        }
      }, 25000);
    });

    // Phone messages arrive here — same handling as local WS messages
    relayWsClient.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'COMMAND') {
          await handleAction(data.action, data.source || 'Relay Phone');
        } else if (data.type === 'SET_PROFILE') {
          if (SOFTWARE_PROFILES[data.profile]) {
            sessionState.activeProfile = data.profile;
            broadcast({ type:'PROFILE_CHANGED', profile:data.profile,
              profileInfo:SOFTWARE_PROFILES[data.profile], sessionState });
          }
        } else if (data.type === 'LASER_DOWN' || data.type === 'LASER_MOVE' || data.type === 'LASER_UP' || data.type === 'LASER_STYLE') {
          if (!licenseService.getLicenseStatus().isPro) return; // Pro feature
          broadcast(data);
        } else if (data.type === 'PING') {
          relayWsClient.send(JSON.stringify({ type:'PONG', timestamp:Date.now() }));
        }
      } catch (_) {}
    });

    relayWsClient.on('close', () => {
      relayConnected = false;
      if (relayPingTimer) clearInterval(relayPingTimer);
      console.log('[Relay] Disconnected — retrying in 10s...');
      setTimeout(connectToRelay, 10000);
    });

    relayWsClient.on('error', (err) => {
      console.warn('[Relay] WS error:', err.message);
    });

  } catch (err) {
    console.warn('[Relay] Could not connect:', err.message, '— retrying in 15s');
    setTimeout(connectToRelay, 15000);
  }
}

const app = express();
const server = http.createServer(app);

// Graceful port collision handling (e.g. if background server is already active)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[NXTslide] Port ${PORT} is already in use. Attaching to existing running server.`);
  } else {
    console.error('[NXTslide] Server error:', err);
  }
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });

const PORT = process.env.PORT || 3333;
const primaryIp = getPrimaryLocalIp();
const remoteUrl = `http://${primaryIp}:${PORT}/remote`;

// UDP Auto-Discovery Service on port 3334
try {
  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('error', (err) => {
    console.warn('[UDP Discovery] socket error:', err.message);
  });
  udpSocket.on('message', (msg, rinfo) => {
    const text = msg.toString().trim();
    if (text.includes('NXTSLIDE')) {
      const reply = Buffer.from(JSON.stringify({
        type: 'DISCOVERY_RESPONSE',
        ip: primaryIp,
        port: PORT,
        name: 'NXTslide Host'
      }));
      udpSocket.send(reply, 0, reply.length, rinfo.port, rinfo.address, () => {});
    }
  });
  udpSocket.bind(3334, () => {
    try { udpSocket.setBroadcast(true); } catch (_) {}
  });
} catch (e) {
  console.warn('[UDP Discovery] Failed to start:', e.message);
}

app.use(express.json());

// ── Cloud-Sync UI Middleware (serves updated files from ~/.nxtslide/ui_cache) ──
app.use((req, res, next) => {
  const relPath = req.path.replace(/^\/+/, '');
  if (relPath && !relPath.startsWith('api/') && !relPath.startsWith('auth/')) {
    const cachedPath = cloudSync.getCachedFilePath(relPath);
    if (cachedPath) {
      return res.sendFile(cachedPath, { dotfiles: 'allow' }, (err) => {
        if (err) next();
      });
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));


// Health check endpoint (required for Railway / Render / Fly.io deployments)
app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'NXTslide', version: '2.2.0' }));

app.get('/api/version', (_req, res) => {
  res.json({
    latestVersion: '2.2.0',
    minSupportedVersion: '1.0.0',
    windows: {
      version: '2.2.0',
      installerUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v1.0.0/NXTslide.Setup.1.0.0.exe',
      portableUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v1.0.0/NXTslide-Portable.exe'
    },
    android: {
      versionName: '2.2.0',
      versionCode: 4,
      apkUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk'
    },
    releaseNotes: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/latest'
  });
});

// ─────────────────────────────────────────────────────────────────────
// Software Profiles — maps NEXT/PREV to specific key commands
// ─────────────────────────────────────────────────────────────────────
const SOFTWARE_PROFILES = {
  powerpoint: {
    label: 'Microsoft PowerPoint',
    next: 'NEXT_ARROW',   // Right Arrow
    prev: 'PREV_ARROW',   // Left Arrow
    supportsBlackout: true,
    supportsWhiteout: true,
    startKey: 'F5',
    startCurrentKey: 'SHIFT_F5',
  },
  google_slides: {
    label: 'Google Slides',
    next: 'NEXT_ARROW',
    prev: 'PREV_ARROW',
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: null,
    startCurrentKey: null,
  },
  canva: {
    label: 'Canva Presentations',
    next: 'NEXT_ARROW',
    prev: 'PREV_ARROW',
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: null,
    startCurrentKey: null,
  },
  libreoffice: {
    label: 'LibreOffice Impress',
    next: 'NEXT_PGDN',   // PageDown
    prev: 'PREV_PGUP',   // PageUp
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: 'F5',
    startCurrentKey: null,
  },
  pdf: {
    label: 'PDF Viewer (Adobe / Edge / Chrome)',
    next: 'NEXT_PGDN',   // PageDown
    prev: 'PREV_PGUP',   // PageUp
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: null,
    startCurrentKey: null,
  },
  keynote_mac: {
    label: 'Apple Keynote (Mac)',
    next: 'NEXT_ARROW',
    prev: 'PREV_ARROW',
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: null,
    startCurrentKey: null,
  },
  prezi: {
    label: 'Prezi',
    next: 'NEXT_SPACE',    // Space
    prev: 'PREV_BACKSPACE', // Backspace
    supportsBlackout: false,
    supportsWhiteout: false,
    startKey: null,
    startCurrentKey: null,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Session State
// ─────────────────────────────────────────────────────────────────────
const sessionState = {
  slideCount: 1,
  totalForwardClicks: 0,
  totalBackwardClicks: 0,
  connectedClients: 0,
  timerStartedAt: null,
  isTimerRunning: false,
  elapsedSeconds: 0,
  activeProfile: 'powerpoint',
};

// ─────────────────────────────────────────────────────────────────────
// Helper: get current profile
// ─────────────────────────────────────────────────────────────────────
function getCurrentProfile() {
  return SOFTWARE_PROFILES[sessionState.activeProfile] || SOFTWARE_PROFILES.powerpoint;
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  const cached = cloudSync.getCachedFilePath('dashboard.html');
  if (cached) {
    return res.sendFile(cached, { dotfiles: 'allow' }, (err) => {
      if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/remote', (req, res) => {
  const cached = cloudSync.getCachedFilePath('mobile.html');
  if (cached) {
    return res.sendFile(cached, { dotfiles: 'allow' }, (err) => {
      if (err) res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
    });
  }
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
  const cached = cloudSync.getCachedFilePath('admin.html');
  if (cached) {
    return res.sendFile(cached, { dotfiles: 'allow' }, (err) => {
      if (err) res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});


// Direct Download Convenience Endpoints
app.get(['/download/windows', '/downloads/NXTslide-Setup.exe', '/downloads/nextPresent-Setup.exe'], (req, res) => {
  const filePath = path.join(__dirname, 'public', 'downloads', 'NXTslide-Setup.exe');
  res.download(filePath, 'NXTslide-Setup.exe');
});

app.get(['/download/portable', '/downloads/NXTslide-Portable.exe', '/downloads/nextPresent-Portable.exe'], (req, res) => {
  const filePath = path.join(__dirname, 'public', 'downloads', 'NXTslide-Portable.exe');
  res.download(filePath, 'NXTslide-Portable.exe');
});

app.get(['/download/android', '/downloads/NXTslide.apk', '/downloads/nextPresent.apk', '/NXTslide.apk', '/nextPresent.apk'], (req, res) => {
  const fileInDownloads = path.join(__dirname, 'public', 'downloads', 'NXTslide.apk');
  const fileInPublic = path.join(__dirname, 'public', 'NXTslide.apk');
  const finalPath = fs.existsSync(fileInDownloads) ? fileInDownloads : fileInPublic;
  res.download(finalPath, 'NXTslide.apk');
});

app.get('/api/info', async (req, res) => {
  try {
    const overrideIp = req.query.ip;
    const useIp  = overrideIp || primaryIp;
    const lanUrl = `http://${useIp}:${PORT}/remote`;

    // Generate distinct QR codes for Local LAN and Cloud Relay
    const lanQrDataUrl = await QRCode.toDataURL(lanUrl, {
      margin: 1,
      width: 320,
      color: { dark: '#0f172a', light: '#ffffff' }
    });

    let cloudQrDataUrl = null;
    const isProUser = licenseService.getLicenseStatus().isPro;
    if (isProUser && relayPhoneUrl) {
      cloudQrDataUrl = await QRCode.toDataURL(relayPhoneUrl, {
        margin: 1,
        width: 320,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
    }

    res.json({
      port: PORT,
      primaryIp,
      remoteUrl:    lanUrl,
      allIps:       getLocalIpAddresses(),
      qrDataUrl:    lanQrDataUrl,
      lanQrDataUrl,
      cloudQrDataUrl,
      sessionState,
      profiles:     SOFTWARE_PROFILES,
      license:      licenseService.getLicenseStatus(),
      // Cloud relay info (null if relay not connected)
      relay: {
        connected:  relayConnected,
        roomCode:   relayRoomCode,
        phoneUrl:   relayPhoneUrl,
        relayBase:  RELAY_BASE_URL,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// License Key Management Endpoints
// ─────────────────────────────────────────────────────────────────────
app.get('/api/license/status', (req, res) => {
  res.json(licenseService.getLicenseStatus());
});

app.get('/api/auth/cached-user', (req, res) => {
  res.json({ user: licenseService.readCachedUser() });
});

// Cloud-Sync UI endpoints
app.post('/api/ui/sync', async (req, res) => {
  const result = await cloudSync.checkAndUpdate((newSha) => {
    broadcast({ type: 'UI_SYNC_UPDATED', sha: newSha });
  });
  res.json(result);
});

app.get('/api/ui/version', (req, res) => {
  res.json(cloudSync.getVersion() || { status: 'bundled' });
});



app.post('/api/license/activate', async (req, res) => {
  try {
    const { key, instanceName } = req.body || {};
    const result = await licenseService.activateLicense(key, instanceName);
    if (result.success) {
      if (result.isPro) {
        connectToRelay();
        broadcast({ type: 'PRO_STATUS_CHANGED', isPro: true });
      }
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/license/deactivate', (req, res) => {
  res.json(licenseService.deactivateLicense());
});

app.post('/api/profile', (req, res) => {
  const { profile } = req.body;
  if (!SOFTWARE_PROFILES[profile]) {
    return res.status(400).json({ error: `Unknown profile: ${profile}` });
  }
  sessionState.activeProfile = profile;
  broadcast({
    type: 'PROFILE_CHANGED',
    profile,
    profileInfo: SOFTWARE_PROFILES[profile],
    sessionState,
  });
  res.json({ success: true, profile, profileInfo: SOFTWARE_PROFILES[profile] });
// ─────────────────────────────────────────────────────────────────────
// Remote Presenter Device Tracker (Free: 1 remote, Pro: Unlimited)
// ─────────────────────────────────────────────────────────────────────
const activeRemoteDevices = new Map(); // deviceId -> Set<WebSocket>

function cleanDeadRemoteSockets() {
  for (const [id, socketSet] of activeRemoteDevices.entries()) {
    for (const s of socketSet) {
      if (s.readyState !== WebSocket.OPEN) {
        socketSet.delete(s);
      }
    }
    if (socketSet.size === 0) {
      activeRemoteDevices.delete(id);
    }
  }
}

app.post('/api/key', async (req, res) => {
  const { action, deviceId } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Action required' });

  const isPro = licenseService.getLicenseStatus().isPro;
  cleanDeadRemoteSockets();
  if (!isPro && activeRemoteDevices.size > 0 && deviceId && !activeRemoteDevices.has(deviceId)) {
    return res.status(403).json({
      error: 'Multi-device presentation is a Lifetime Pro feature (₹149). Free version allows 1 remote at a time.',
      code: 'MULTI_DEVICE_PRO_ONLY'
    });
  }

  await handleAction(action, 'API');
  res.json({ success: true, action });
});

// ─────────────────────────────────────────────────────────────────────
// Action Handler — resolves profile-aware key from logical action
// ─────────────────────────────────────────────────────────────────────
async function handleAction(action, source = 'unknown') {
  const normAction = action.toUpperCase().trim();
  const profile = getCurrentProfile();

  let keyCommand = normAction; // default: pass raw command

  if (normAction === 'NEXT') {
    sessionState.slideCount++;
    sessionState.totalForwardClicks++;
    keyCommand = profile.next;
  } else if (normAction === 'PREV') {
    if (sessionState.slideCount > 1) sessionState.slideCount--;
    sessionState.totalBackwardClicks++;
    keyCommand = profile.prev;
  } else if (normAction === 'RESET_SLIDES') {
    sessionState.slideCount = 1;
    broadcast({ type: 'STATE_SYNC', sessionState });
    return;
  }

  await keySender.send(keyCommand);

  broadcast({
    type: 'KEY_EVENT',
    action: normAction,
    keyCommand,
    source,
    timestamp: Date.now(),
    sessionState,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Broadcast
// ─────────────────────────────────────────────────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && !client.isBlockedMultiDevice) {
      client.send(payload);
    }
  }
  // Also forward state sync to cloud relay so remote phone updates instantly
  if (relayWsClient && relayWsClient.readyState === WebSocket.OPEN) {
    relayWsClient.send(payload);
  }
}

// ─────────────────────────────────────────────────────────────────────
// WebSocket Handling
// ─────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  if (ws._socket) {
    ws._socket.setNoDelay(true); // Disable Nagle algorithm for 0-latency
  }

  cleanDeadRemoteSockets();

  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const role = fullUrl.searchParams.get('role');
  const rawDeviceId = fullUrl.searchParams.get('deviceId');

  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '127.0.0.1')
    .replace(/^.*:/, ''); // normalize IPv6 ::ffff:192.168.x.x

  const isDashboard = role === 'dashboard' || (req.headers.referer && req.headers.referer.includes('/dashboard'));
  const isRemotePresenter = !isDashboard;
  const deviceId = rawDeviceId || (isRemotePresenter ? `ip_${clientIp}` : `dash_${Date.now()}`);

  const isPro = licenseService.getLicenseStatus().isPro;

  if (isRemotePresenter) {
    const isAlreadyConnected = activeRemoteDevices.has(deviceId);

    // Free plan: Only 1 remote device allowed at a time!
    if (!isPro && !isAlreadyConnected && activeRemoteDevices.size >= 1) {
      console.warn(`[Paywall] Blocked 2nd remote device '${deviceId}' from IP ${clientIp}. Active devices: ${activeRemoteDevices.size}`);
      ws.isBlockedMultiDevice = true;

      ws.send(JSON.stringify({
        type: 'MULTI_DEVICE_BLOCKED',
        code: 'MULTI_DEVICE_PRO_ONLY',
        message: 'Multi-Presenter Mode (2+ remotes) is a Lifetime Pro feature (₹149). Free plan allows 1 remote at a time. Upgrade to Pro for unlimited co-presenters, or disconnect the other phone.',
        isPro: false,
        activeDeviceCount: activeRemoteDevices.size
      }));

      // Notify host PC dashboard so host knows another device tried to connect
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && !client.isBlockedMultiDevice) {
          client.send(JSON.stringify({
            type: 'MULTI_DEVICE_ATTEMPT',
            message: 'A second presenter tried to connect. Upgrade to Lifetime Pro (₹149) to allow unlimited co-presenters!',
            attemptedDeviceId: deviceId,
            attemptedIp: clientIp,
            timestamp: Date.now()
          }));
        }
      }

      setTimeout(() => {
        try { ws.close(4003, 'Multi-device requires Lifetime Pro'); } catch (_) {}
      }, 500);

      return;
    }

    if (!activeRemoteDevices.has(deviceId)) {
      activeRemoteDevices.set(deviceId, new Set());
      console.log(`[Remote] Remote device '${deviceId}' connected. Active devices: ${activeRemoteDevices.size}`);
    }
    activeRemoteDevices.get(deviceId).add(ws);
  }

  sessionState.connectedClients = activeRemoteDevices.size;
  const clientUa = req.headers['user-agent'] || 'unknown';
  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(clientUa);

  ws.send(JSON.stringify({
    type: 'INIT',
    sessionState,
    remoteUrl,
    profiles: SOFTWARE_PROFILES,
    activeProfile: sessionState.activeProfile,
    isPro: licenseService.getLicenseStatus().isPro,
    deviceId: isRemotePresenter ? deviceId : undefined
  }));

  broadcast({
    type: 'CLIENT_CONNECTED',
    clientCount: activeRemoteDevices.size,
    isMobile,
    timestamp: Date.now(),
  });

  ws.on('message', async (message) => {
    if (ws.isBlockedMultiDevice) return;

    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'COMMAND') {
        await handleAction(data.action, data.source || (isMobile ? 'Mobile' : 'Web'));
      } else if (data.type === 'SET_PROFILE') {
        if (SOFTWARE_PROFILES[data.profile]) {
          sessionState.activeProfile = data.profile;
          broadcast({
            type: 'PROFILE_CHANGED',
            profile: data.profile,
            profileInfo: SOFTWARE_PROFILES[data.profile],
            sessionState,
          });
        }
      } else if (data.type === 'TIMER_START') {
        sessionState.isTimerRunning = true;
        sessionState.timerStartedAt = Date.now() - (sessionState.elapsedSeconds * 1000);
        broadcast({ type: 'TIMER_SYNC', sessionState });
      } else if (data.type === 'TIMER_PAUSE') {
        sessionState.isTimerRunning = false;
        broadcast({ type: 'TIMER_SYNC', sessionState });
      } else if (data.type === 'TIMER_RESET') {
        sessionState.isTimerRunning = false;
        sessionState.elapsedSeconds = 0;
        sessionState.timerStartedAt = null;
        broadcast({ type: 'TIMER_SYNC', sessionState });
      } else if (data.type === 'RESET_COUNTER') {
        sessionState.slideCount = 1;
        broadcast({ type: 'STATE_SYNC', sessionState });
      } else if (data.type === 'LASER_DOWN' || data.type === 'LASER_MOVE' || data.type === 'LASER_UP' || data.type === 'LASER_STYLE') {
        if (!licenseService.getLicenseStatus().isPro) return; // Pro feature
        broadcast(data);
      } else if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (err) {
      console.error('[WS Error]', err);
    }
  });

  ws.on('close', () => {
    if (isRemotePresenter && activeRemoteDevices.has(deviceId)) {
      const set = activeRemoteDevices.get(deviceId);
      set.delete(ws);
      if (set.size === 0) {
        activeRemoteDevices.delete(deviceId);
        console.log(`[Remote] Remote device '${deviceId}' disconnected. (Active devices: ${activeRemoteDevices.size})`);
      }
    }
    cleanDeadRemoteSockets();
    sessionState.connectedClients = activeRemoteDevices.size;
    broadcast({
      type: 'CLIENT_DISCONNECTED',
      clientCount: activeRemoteDevices.size,
      timestamp: Date.now(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Timer Ticker
// ─────────────────────────────────────────────────────────────────────
setInterval(() => {
  if (sessionState.isTimerRunning && sessionState.timerStartedAt) {
    sessionState.elapsedSeconds = Math.floor((Date.now() - sessionState.timerStartedAt) / 1000);
  }
}, 1000);

// ─────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n========================================================');
  console.log('         🚀 NXTslide Host is Running!                ');
  console.log('========================================================');
  console.log(`💻 PC Dashboard:     http://localhost:${PORT}/dashboard`);
  console.log(`📱 LAN Controller:   ${remoteUrl}`);
  console.log('--------------------------------------------------------');

  // Connect to cloud relay (non-blocking — LAN still works even if this fails)
  connectToRelay().then(() => {}).catch(() => {});

  // Initialize automatic Cloud-Sync for Desktop UI (checks GitHub for updates)
  cloudSync.init((newSha) => {
    broadcast({ type: 'UI_SYNC_UPDATED', sha: newSha });
  });


  console.log('📲 Scan QR on the dashboard to connect from any network:');
  try {
    const terminalQr = await QRCode.toString(remoteUrl, { type: 'terminal', small: true });
    console.log(terminalQr);
  } catch (_) {}

  console.log('========================================================\n');
});

// ─────────────────────────────────────────────────────────────────────
// Stop Server Endpoint (called by dashboard Stop button)
// ─────────────────────────────────────────────────────────────────────
app.post('/api/server/stop', (req, res) => {
  res.json({ success: true, message: 'Server shutting down...' });
  console.log('[NXTslide] Stop requested from dashboard.');
  keySender.destroy();
  // Close WebSocket connections gracefully
  wss.clients.forEach(client => {
    try { client.close(1001, 'Server stopping'); } catch (_) {}
  });
  // Give response time to send before closing HTTP server
  setTimeout(() => {
    server.close(() => {
      console.log('[NXTslide] Server stopped.');
      process.exit(0);
    });
  }, 300);
});

process.on('SIGINT', () => {
  console.log('\nStopping NXTslide server...');
  keySender.destroy();
  server.close(() => process.exit(0));
});
