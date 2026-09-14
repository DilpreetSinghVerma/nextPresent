/**
 * NXTslide Cloud Relay Server v3.0.0
 * Runs on Railway / Render / Fly.io free tier.
 *
 * REST API (Relay):
 *   POST /api/rooms        create room, returns { code, wsUrl, phoneUrl }
 *   GET  /api/rooms/:code  check room exists
 *   GET  /health           health check
 *
 * REST API (Auth):
 *   GET  /api/auth/google           redirect to Google Sign-In
 *   GET  /api/auth/google/callback  OAuth callback
 *   GET  /api/auth/me               current user info
 *   POST /api/auth/logout           logout
 *
 * REST API (Billing):
 *   POST /api/billing/subscribe     create Razorpay order for Pro
 *   POST /api/billing/webhook       Razorpay webhook (updates plan)
 *   GET  /api/billing/status        current subscription status
 *
 * WebSocket:
 *   WS /ws/:code/pc        PC connects as host
 *   WS /ws/:code/phone     Phone connects as remote
 */
'use strict';

require('dotenv').config();

const http         = require('http');
const path         = require('path');
const crypto       = require('crypto');
const express      = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('crypto');
const url          = require('url');

// ─── Auth & Session ───────────────────────────────────────────────────────────
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieSession  = require('cookie-session');

// ─── Database ─────────────────────────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[DB] better-sqlite3 not available:', e.message);
}

// ─── Razorpay ─────────────────────────────────────────────────────────────────
let Razorpay;
try {
  Razorpay = require('razorpay');
} catch (e) {
  console.warn('[Billing] Razorpay not available:', e.message);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 4000;
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const BASE_URL    = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'nxtslide-secret-2026';
const ADMIN_EMAILS   = ['dilpreetsinghverma@gmail.com'];

// Pro Plan price in paise (₹299/month = 29900 paise)
const PRO_MONTHLY_PRICE = 29900;

// ─── SQLite Database Setup ────────────────────────────────────────────────────
let db = null;

function setupDatabase() {
  if (!Database) return null;
  try {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'nxtslide_users.db');
    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                     TEXT PRIMARY KEY,
        googleId               TEXT UNIQUE,
        email                  TEXT UNIQUE NOT NULL,
        name                   TEXT,
        avatar                 TEXT,
        plan                   TEXT NOT NULL DEFAULT 'free',
        subscriptionStartedAt  TEXT,
        subscriptionExpiresAt  TEXT,
        razorpayCustomerId     TEXT,
        createdAt              TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    console.log('[DB] SQLite database ready at:', dbPath);
    return db;
  } catch (err) {
    console.error('[DB] Failed to initialize database:', err.message);
    return null;
  }
}

// ─── User DB helpers ─────────────────────────────────────────────────────────
function generateId() {
  return randomBytes(8).toString('hex');
}

function getUserById(id) {
  if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByGoogleId(googleId) {
  if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE googleId = ?').get(googleId);
}

function getUserByEmail(email) {
  if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
}

function createUser(data) {
  if (!db) return null;
  const id = generateId();
  db.prepare(`
    INSERT INTO users (id, googleId, email, name, avatar, plan)
    VALUES (?, ?, ?, ?, ?, 'free')
  `).run(id, data.googleId || null, data.email.toLowerCase(), data.name || null, data.avatar || null);
  return getUserById(id);
}

function updateUser(id, updates) {
  if (!db) return null;
  const allowed = ['googleId','name','avatar','plan','subscriptionStartedAt','subscriptionExpiresAt','razorpayCustomerId'];
  const fields  = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return getUserById(id);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values    = fields.map(f => updates[f]);
  db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...values, id);
  return getUserById(id);
}

function isUserPro(user) {
  if (!user) return false;
  if (ADMIN_EMAILS.includes(user.email)) return true;
  if (user.plan === 'free') return false;
  if (!user.subscriptionExpiresAt) return false;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const rooms  = new Map();

// Raw body capture for Razorpay webhook signature verification
app.use('/api/billing/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  // Allow Electron (file://) and any other origin
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Session & Passport ───────────────────────────────────────────────────────
app.use(cookieSession({
  name: 'nxtslide_session',
  keys: [SESSION_SECRET],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  secure: false,
  sameSite: 'lax',
  httpOnly: true,
}));

// Passport shim for cookie-session
app.use((req, _res, next) => {
  if (req.session && !req.session.regenerate) req.session.regenerate = (cb) => cb();
  if (req.session && !req.session.save) req.session.save = (cb) => cb();
  next();
});

app.use(passport.initialize());
app.use(passport.session());

// ─── Passport Google Strategy ────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`,
      proxy: true,
      passReqToCallback: true,
    },
    async (req, _accessToken, _refreshToken, profile, done) => {
      try {
        if (!db) return done(new Error('Database not available'));
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error('No email from Google'));

        let user = getUserByGoogleId(profile.id);
        if (!user) {
          user = getUserByEmail(email);
          if (user) {
            // Link Google account to existing email user
            user = updateUser(user.id, {
              googleId: profile.id,
              avatar:   user.avatar || profile.photos?.[0]?.value || null,
            });
          } else {
            // New user — create account
            user = createUser({
              googleId: profile.id,
              email,
              name:   profile.displayName || email.split('@')[0],
              avatar: profile.photos?.[0]?.value || null,
            });
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));
  console.log('[Auth] Google OAuth strategy configured.');
} else {
  console.warn('[Auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Google Sign-In disabled.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = getUserById(id);
  done(null, user || false);
});

// ─── Razorpay Instance ────────────────────────────────────────────────────────
let razorpay = null;
if (Razorpay && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('[Billing] Razorpay configured.');
} else {
  console.warn('[Billing] Razorpay credentials not set. Billing disabled.');
}

// ─── Keep-Alive (Render free tier) ────────────────────────────────────────────
const keepAliveTarget = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (keepAliveTarget) {
  console.log('[Relay] Keep-alive active for:', keepAliveTarget);
  setInterval(() => {
    fetch(`${keepAliveTarget}/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

// ─── Room helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(randomBytes(6)).map(b => chars[b % chars.length]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const code  = generateCode();
  const timer = setTimeout(() => deleteRoom(code), ROOM_TTL_MS);
  rooms.set(code, { pc: null, phones: new Set(), timer, createdAt: Date.now() });
  return code;
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.close(1001, 'Room expired');
  room.phones.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'Room expired'); });
  rooms.delete(code);
  console.log('[Relay] Room', code, 'deleted. Rooms:', rooms.size);
}

function touchRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => deleteRoom(code), ROOM_TTL_MS);
}

function broadcastToPhones(room, data) {
  room.phones.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function sendToPc(room, data) {
  if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.send(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Health & Version ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() }));

app.get('/api/version', (_req, res) => {
  res.json({
    latestVersion: '2.2.0',
    minSupportedVersion: '1.0.0',
    windows: {
      version: '2.2.0',
      installerUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v1.0.0/NXTslide.Setup.1.0.0.exe',
      portableUrl:  'https://github.com/DilpreetSinghVerma/nextPresent/releases/download/v1.0.0/NXTslide-Portable.exe'
    },
    android: {
      versionName: '2.2.0',
      versionCode: 4,
      apkUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk'
    },
    releaseNotes: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/latest'
  });
});

app.get(['/downloads/NXTslide.apk', '/NXTslide.apk'], (_req, res) => {
  res.redirect('https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk');
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// Initiate Google Sign-In (handles both /auth/google and /api/auth/google)
app.get(['/auth/google', '/api/auth/google'], (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });
  }
  // Store redirect URL for post-login (Electron passes ?redirect=nxtslide://auth)
  if (req.query.redirect) {
    req.session.postLoginRedirect = req.query.redirect;
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// Google OAuth Callback (handles both /auth/google/callback and /api/auth/google/callback)
app.get(['/auth/google/callback', '/api/auth/google/callback'],
  passport.authenticate('google', { failureRedirect: '/api/auth/failed' }),
  (req, res) => {
    const redirect = req.session.postLoginRedirect;
    delete req.session.postLoginRedirect;

    if (redirect && redirect.startsWith('nxtslide://')) {
      // Electron deep-link: encode user data in query param for the app to read
      const user = req.user;
      const data = Buffer.from(JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        plan: user.plan,
        isPro: isUserPro(user),
      })).toString('base64');
      return res.redirect(`nxtslide://auth?user=${data}`);
    }

    // Web / Android redirect: send to a success page
    res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><title>NXTslide - Signed In</title>
<style>body{background:#05070d;color:#fff;font-family:system-ui;display:flex;align-items:center;
justify-content:center;min-height:100vh;flex-direction:column;text-align:center}
h2{color:#818cf8;margin-bottom:1rem}.avatar{width:64px;height:64px;border-radius:50%;margin-bottom:1rem}
p{color:#94a3b8}</style></head>
<body>
${req.user.avatar ? `<img src="${req.user.avatar}" class="avatar" alt="avatar">` : ''}
<h2>Welcome, ${req.user.name || req.user.email}!</h2>
<p>Plan: <strong style="color:${isUserPro(req.user) ? '#4ade80' : '#94a3b8'}">${isUserPro(req.user) ? '✅ Pro' : 'Free'}</strong></p>
<p style="margin-top:1rem;font-size:0.85rem;color:#64748b">You can close this window and return to NXTslide.</p>
<script>
  // Try to notify the parent Electron window
  if (window.opener) { window.opener.postMessage({ type: 'NXTSLIDE_AUTH_SUCCESS' }, '*'); setTimeout(() => window.close(), 1500); }
  // Try Android WebView callback
  if (window.AndroidApp && window.AndroidApp.onAuthSuccess) { window.AndroidApp.onAuthSuccess(JSON.stringify(${JSON.stringify({ email: req.user.email, name: req.user.name, plan: req.user.plan, isPro: isUserPro(req.user) })})); }
</script>
</body></html>`);
  }
);

app.get(['/auth/failed', '/api/auth/failed'], (_req, res) => {
  res.status(401).send('<h2 style="font-family:sans-serif;color:#ef4444">Sign-in failed. Please try again.</h2>');
});

// Get current user
app.get(['/auth/me', '/api/auth/me'], (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const user = req.user;
  res.json({
    id:                   user.id,
    email:                user.email,
    name:                 user.name,
    avatar:               user.avatar,
    plan:                 user.plan,
    isPro:                isUserPro(user),
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    createdAt:            user.createdAt,
  });
});

// Logout
app.post(['/auth/logout', '/api/auth/logout'], (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.json({ success: true });
  });
});

// ─── Billing Routes ───────────────────────────────────────────────────────────

// Get subscription status (works with both session auth and token auth)
app.get('/api/billing/status', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const user = req.user;
  res.json({
    plan:                 user.plan,
    isPro:                isUserPro(user),
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    checkoutUrl:          razorpay ? `${BASE_URL}/api/billing/subscribe` : null,
  });
});

// Create Razorpay order for Pro Monthly subscription
app.post('/api/billing/subscribe', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  if (!razorpay) return res.status(503).json({ error: 'Payment system not configured' });

  const user = req.user;

  try {
    const receipt = `nxt_pro_${user.id}_${Date.now()}`;
    const options = {
      amount:   PRO_MONTHLY_PRICE,
      currency: 'INR',
      receipt,
      notes:    { userId: user.id, type: 'subscription', plan: 'pro', email: user.email }
    };

    const order = await razorpay.orders.create(options);
    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID,
      user: {
        name:  user.name  || user.email,
        email: user.email,
      }
    });
  } catch (err) {
    console.error('[Billing] Razorpay order error:', err);
    const msg = err.description || err.error?.description || err.message || 'Payment error';
    res.status(500).json({ error: msg });
  }
});

// Razorpay Webhook — verifies signature, updates user plan
app.post('/api/billing/webhook', (req, res) => {
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  const signature = req.headers['x-razorpay-signature'];

  // Immediately respond 200 to prevent Razorpay timeouts
  res.json({ status: 'ok' });

  // Verify signature asynchronously
  try {
    const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const digest  = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');

    if (signature && signature !== digest) {
      console.error('[Webhook] Invalid signature. Ignoring event.');
      return;
    }

    const event = JSON.parse(bodyStr);

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const payment = event.payload?.payment?.entity;
      const order   = event.payload?.order?.entity;
      const notes   = order?.notes || payment?.notes || {};
      const { userId, type, plan } = notes;

      if (!userId) {
        console.error('[Webhook] Missing userId in notes. Ignoring.');
        return;
      }

      if (type === 'subscription') {
        const startedAt  = new Date();
        const expiresAt  = new Date(startedAt);
        expiresAt.setMonth(expiresAt.getMonth() + 1); // 1 month Pro

        updateUser(userId, {
          plan: 'pro',
          razorpayCustomerId:    payment?.customer_id || null,
          subscriptionStartedAt: startedAt.toISOString(),
          subscriptionExpiresAt: expiresAt.toISOString(),
        });

        console.log(`[Webhook] User ${userId} upgraded to Pro until ${expiresAt.toISOString()}`);
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// ─── Room Routes ──────────────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const code = createRoom();
  const host  = req.headers.host;
  console.log('[Relay] Room created:', code, '| Total:', rooms.size);
  res.json({
    code,
    wsUrl:     `wss://${host}/ws/${code}/pc`,
    phoneUrl:  `https://${host}/r/${code}`,
    expiresAt: Date.now() + ROOM_TTL_MS,
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room  = rooms.get(code);
  if (!room) return res.status(404).json({ exists: false });
  res.json({ exists: true, phones: room.phones.size, hasPc: room.pc !== null, code });
});

// HTTP Fallback — zero lost clicks if WebSocket reconnecting
app.post('/api/rooms/:code/command', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room  = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { action, source } = req.body;
  if (!action) return res.status(400).json({ error: 'Action required' });

  touchRoom(code);
  const payload = JSON.stringify({ type: 'COMMAND', action, source: source || 'Relay HTTP Fallback', timestamp: Date.now() });
  sendToPc(room, payload);
  res.json({ success: true, action });
});

// Mobile QR / deep-link landing page
app.get('/r/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NXTslide - Connect</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#05070d;color:#fff;
font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;padding:2rem;text-align:center}
h1{font-size:1.5rem;margin-bottom:.5rem;color:#818cf8}p{color:#94a3b8;margin-bottom:1rem}
.code{font-size:3rem;font-weight:700;letter-spacing:.4rem;color:#818cf8;margin:1.5rem 0}
a.btn{display:block;padding:1rem 2rem;background:#6366f1;color:#fff;text-decoration:none;
border-radius:12px;font-weight:600;font-size:1.1rem;margin-bottom:1rem}
</style></head><body>
<h1>NXTslide</h1><p>Your room code is:</p>
<div class="code">${code}</div>
<a class="btn" href="nextpresent://connect?code=${code}">Open in App</a>
<p style="font-size:.85rem">Don't have the app? Download from Google Play Store.</p>
<script>setTimeout(()=>{window.location='intent://connect?code=${code}#Intent;scheme=nextpresent;package=com.nextpresent.remote;end';},500);</script>
</body></html>`);
});

app.get('/', (_req, res) => res.json({ service: 'NXTslide Relay', rooms: rooms.size, version: '3.0.0' }));

// ═══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════════
server.on('upgrade', (request, socket, head) => {
  const { pathname } = url.parse(request.url);
  const match = pathname.match(/^\/ws\/([A-Z0-9]{6})\/(pc|phone)$/i);
  if (!match) { socket.destroy(); return; }
  const code = match[1].toUpperCase();
  const role = match[2].toLowerCase();
  if (!rooms.has(code)) { socket.write('HTTP/1.1 404 Room Not Found\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, code, role));
});

wss.on('connection', (ws, _req, code, role) => {
  const room = rooms.get(code);
  if (!room) { ws.close(1008, 'Room gone'); return; }

  // Disable Nagle's algorithm for true 0-delay packet delivery
  if (ws._socket) ws._socket.setNoDelay(true);

  touchRoom(code);
  if (role === 'pc') {
    if (room.pc && room.pc.readyState === WebSocket.OPEN) room.pc.close(1001, 'New PC connected');
    room.pc = ws;
    console.log('[Relay] PC joined room', code);
    broadcastToPhones(room, JSON.stringify({ type: 'PC_CONNECTED' }));
    ws.on('message', (data) => { touchRoom(code); broadcastToPhones(room, data); });
    ws.on('close', () => {
      if (room.pc === ws) room.pc = null;
      broadcastToPhones(room, JSON.stringify({ type: 'PC_DISCONNECTED' }));
    });
  } else {
    room.phones.add(ws);
    console.log('[Relay] Phone joined room', code, '| Phones:', room.phones.size);
    sendToPc(room, JSON.stringify({ type: 'PHONE_COUNT', count: room.phones.size }));
    ws.on('message', (data) => { touchRoom(code); sendToPc(room, data); });
    ws.on('close', () => {
      room.phones.delete(ws);
      sendToPc(room, JSON.stringify({ type: 'PHONE_COUNT', count: room.phones.size }));
    });
  }
  ws.on('error', (err) => console.warn('[Relay] WS error room', code, err.message));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
db = setupDatabase();

process.on('SIGTERM', () => {
  rooms.forEach((_, c) => deleteRoom(c));
  server.close(() => process.exit(0));
});

server.listen(PORT, () => console.log('[Relay] NXTslide Cloud Relay v3.0.0 on port', PORT));
