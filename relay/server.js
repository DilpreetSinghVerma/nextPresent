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
const fs           = require('fs');
const crypto       = require('crypto');
const express      = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes } = require('crypto');
const url          = require('url');

// ─── Auth & Session ───────────────────────────────────────────────────────────
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieSession  = require('cookie-session');

// ─── Database (Turso LibSQL Cloud with Local SQLite Fallback) ──────────────────
let createClient;
try {
  ({ createClient } = require('@libsql/client'));
} catch (e) {
  console.warn('[DB] @libsql/client not available:', e.message);
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
const BASE_URL    = process.env.PUBLIC_URL || (process.env.RENDER ? 'https://nxtslide.online' : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`));
const SESSION_SECRET = process.env.SESSION_SECRET || 'nxtslide-secret-2026';
const ADMIN_EMAILS   = ['dilpreetsinghverma@gmail.com'];
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'nxtslide-admin-2026';

// Pro Plan price in paise (₹89 Lifetime Permanent Account = 8900 paise)
const PRO_LIFETIME_PRICE = 8900;

// ─── Database Setup ───────────────────────────────────────────────────────────
let db = null;

async function setupDatabase() {
  if (!createClient) {
    console.error('[DB] Cannot initialize database: @libsql/client is missing.');
    return null;
  }
  try {
    let client;
    if (process.env.TURSO_DATABASE_URL) {
      console.log('[DB] Connecting to Turso Cloud Database:', process.env.TURSO_DATABASE_URL);
      client = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    } else {
      const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'nxtslide_users.db');
      console.log('[DB] Using local SQLite database file at:', dbPath);
      client = createClient({
        url: `file:${dbPath}`,
      });
    }

    await client.batch([
      `CREATE TABLE IF NOT EXISTS users (
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
      );`,
      `CREATE TABLE IF NOT EXISTS auth_tokens (
        token     TEXT PRIMARY KEY,
        userId    TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
      );`,
      `CREATE TABLE IF NOT EXISTS payments (
        id         TEXT PRIMARY KEY,
        userId     TEXT,
        userEmail  TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        currency   TEXT NOT NULL DEFAULT 'INR',
        orderId    TEXT,
        paymentId  TEXT,
        status     TEXT NOT NULL DEFAULT 'paid',
        source     TEXT NOT NULL DEFAULT 'razorpay',
        notes      TEXT,
        createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE SET NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_payments_userId ON payments(userId);`,
      `CREATE INDEX IF NOT EXISTS idx_payments_createdAt ON payments(createdAt);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_paymentId ON payments(paymentId) WHERE paymentId IS NOT NULL;`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`
    ]);

    console.log('[DB] Database schema verified and ready.');
    return client;
  } catch (err) {
    console.error('[DB] Failed to initialize database:', err.message);
    return null;
  }
}

// ─── User DB & Token helpers ──────────────────────────────────────────────────
function generateId() {
  return randomBytes(8).toString('hex');
}

async function createAuthToken(userId) {
  if (!db || !userId) return null;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days
  try {
    await db.execute({
      sql: 'INSERT INTO auth_tokens (token, userId, expiresAt) VALUES (?, ?, ?)',
      args: [token, userId, expiresAt]
    });
    return token;
  } catch (err) {
    console.error('[DB] Failed to create auth token:', err.message);
    return null;
  }
}

async function getUserByToken(token) {
  if (!db || !token) return null;
  try {
    const res = await db.execute({
      sql: `SELECT u.* FROM users u
            JOIN auth_tokens t ON t.userId = u.id
            WHERE t.token = ? AND datetime(t.expiresAt) > datetime('now')`,
      args: [token]
    });
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Failed to get user by token:', err.message);
    return null;
  }
}

async function resolveUser(req) {
  // 1. Bearer token in Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const user = await getUserByToken(token);
    if (user) return user;
  }
  // 2. Query param ?token=
  if (req.query && req.query.token) {
    const user = await getUserByToken(req.query.token);
    if (user) return user;
  }
  // 3. Cookie session (passport)
  if (req.isAuthenticated && req.isAuthenticated()) {
    return req.user;
  }
  return null;
}

async function getUserById(id) {
  if (!db || !id) return null;
  try {
    const res = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [id]
    });
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Failed to get user by id:', err.message);
    return null;
  }
}

async function getUserByGoogleId(googleId) {
  if (!db || !googleId) return null;
  try {
    const res = await db.execute({
      sql: 'SELECT * FROM users WHERE googleId = ?',
      args: [googleId]
    });
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Failed to get user by googleId:', err.message);
    return null;
  }
}

async function getUserByEmail(email) {
  if (!db || !email) return null;
  try {
    const res = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });
    return res.rows[0] || null;
  } catch (err) {
    console.error('[DB] Failed to get user by email:', err.message);
    return null;
  }
}

async function createUser(data) {
  if (!db) return null;
  const id = generateId();
  try {
    await db.execute({
      sql: `INSERT INTO users (id, googleId, email, name, avatar, plan)
            VALUES (?, ?, ?, ?, ?, 'free')`,
      args: [id, data.googleId || null, data.email.toLowerCase(), data.name || null, data.avatar || null]
    });
    return await getUserById(id);
  } catch (err) {
    console.error('[DB] Failed to create user:', err.message);
    return null;
  }
}

async function updateUser(id, updates) {
  if (!db || !id) return null;
  const allowed = ['googleId','name','avatar','plan','subscriptionStartedAt','subscriptionExpiresAt','razorpayCustomerId'];
  const fields  = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return await getUserById(id);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values    = fields.map(f => updates[f]);
  values.push(id);
  try {
    await db.execute({
      sql: `UPDATE users SET ${setClause} WHERE id = ?`,
      args: values
    });
    return await getUserById(id);
  } catch (err) {
    console.error('[DB] Failed to update user:', err.message);
    return null;
  }
}

function isUserPro(user) {
  if (!user) return false;
  if (ADMIN_EMAILS.includes(user.email)) return true;
  if (user.plan === 'free') return false;
  if (!user.subscriptionExpiresAt) return false;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

// ─── Payments & Admin DB Helpers ──────────────────────────────────────────────
async function recordPayment(data) {
  if (!db) return null;

  // Deduplication check: if paymentId already recorded, avoid duplicate ledger entries
  if (data.paymentId) {
    try {
      const existing = await db.execute({
        sql: 'SELECT * FROM payments WHERE paymentId = ? LIMIT 1',
        args: [data.paymentId]
      });
      if (existing.rows && existing.rows.length > 0) {
        console.log(`[DB] Payment ${data.paymentId} already recorded. Returning existing entry.`);
        return existing.rows[0];
      }
    } catch (_) {}
  }

  const id = generateId();
  try {
    await db.execute({
      sql: `INSERT INTO payments (id, userId, userEmail, amount, currency, orderId, paymentId, status, source, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.userId || null,
        (data.userEmail || '').toLowerCase(),
        data.amount || 0,
        data.currency || 'INR',
        data.orderId || null,
        data.paymentId || null,
        data.status || 'paid',
        data.source || 'razorpay',
        data.notes ? (typeof data.notes === 'string' ? data.notes : JSON.stringify(data.notes)) : null
      ]
    });
    const res = await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [id] });
    return res.rows[0] || null;
  } catch (err) {
    // If unique constraint triggers on duplicate paymentId, gracefully return existing record
    if (data.paymentId) {
      try {
        const res = await db.execute({ sql: 'SELECT * FROM payments WHERE paymentId = ? LIMIT 1', args: [data.paymentId] });
        if (res.rows && res.rows[0]) return res.rows[0];
      } catch (_) {}
    }
    console.error('[DB] Failed to record payment:', err.message);
    return null;
  }
}

async function getAllPayments(limit = 100, offset = 0) {
  if (!db) return [];
  try {
    const res = await db.execute({
      sql: `SELECT p.*, u.name as userName, u.avatar as userAvatar
            FROM payments p
            LEFT JOIN users u ON p.userId = u.id
            ORDER BY datetime(p.createdAt) DESC
            LIMIT ? OFFSET ?`,
      args: [limit, offset]
    });
    return res.rows;
  } catch (err) {
    console.error('[DB] Failed to query payments:', err.message);
    return [];
  }
}

async function getAllUsers(query = '', planFilter = 'all', limit = 100, offset = 0) {
  if (!db) return { users: [], total: 0 };
  try {
    let sql = 'SELECT * FROM users WHERE 1=1';
    let countSql = 'SELECT count(*) as total FROM users WHERE 1=1';
    const params = [];
    const countParams = [];

    if (query) {
      const q = `%${query.toLowerCase()}%`;
      sql += ' AND (LOWER(email) LIKE ? OR LOWER(name) LIKE ?)';
      countSql += ' AND (LOWER(email) LIKE ? OR LOWER(name) LIKE ?)';
      params.push(q, q);
      countParams.push(q, q);
    }

    if (planFilter === 'pro') {
      sql += " AND (plan = 'pro' AND datetime(subscriptionExpiresAt) > datetime('now'))";
      countSql += " AND (plan = 'pro' AND datetime(subscriptionExpiresAt) > datetime('now'))";
    } else if (planFilter === 'free') {
      sql += " AND (plan = 'free' OR datetime(subscriptionExpiresAt) <= datetime('now'))";
      countSql += " AND (plan = 'free' OR datetime(subscriptionExpiresAt) <= datetime('now'))";
    }

    sql += ' ORDER BY datetime(createdAt) DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const countRes = await db.execute({ sql: countSql, args: countParams });
    const total = Number(countRes.rows[0]?.total || 0);

    const usersRes = await db.execute({ sql, args: params });
    const users = usersRes.rows.map(u => ({
      ...u,
      isPro: isUserPro(u),
    }));

    return { users, total };
  } catch (err) {
    console.error('[DB] Failed to query users:', err.message);
    return { users: [], total: 0 };
  }
}

async function getAdminStats() {
  if (!db) return { totalUsers: 0, proUsers: 0, freeUsers: 0, totalRevenue: 0, recentSignups: 0, activeRooms: rooms.size, conversionRate: '0' };
  try {
    const totalRes = await db.execute('SELECT count(*) as count FROM users');
    const totalUsers = Number(totalRes.rows[0]?.count || 0);

    const proSql = `
      SELECT count(*) as count FROM users 
      WHERE (plan = 'pro' AND datetime(subscriptionExpiresAt) > datetime('now'))
         OR email IN ('${ADMIN_EMAILS.join("','")}')
    `;
    const proRes = await db.execute(proSql);
    const proUsers = Number(proRes.rows[0]?.count || 0);
    const freeUsers = Math.max(0, totalUsers - proUsers);

    const revRes = await db.execute("SELECT sum(amount) as totalPaise FROM payments WHERE status = 'paid'");
    const totalRevenue = Math.round(Number(revRes.rows[0]?.totalPaise || 0) / 100);

    const recentRes = await db.execute("SELECT count(*) as count FROM users WHERE datetime(createdAt) >= datetime('now', '-7 days')");
    const recentSignups = Number(recentRes.rows[0]?.count || 0);

    return {
      totalUsers,
      proUsers,
      freeUsers,
      totalRevenue,
      recentSignups,
      activeRooms: rooms.size,
      conversionRate: totalUsers > 0 ? ((proUsers / totalUsers) * 100).toFixed(1) : '0',
    };
  } catch (err) {
    console.error('[DB] Failed to get admin stats:', err.message);
    return { totalUsers: 0, proUsers: 0, freeUsers: 0, totalRevenue: 0, recentSignups: 0, activeRooms: rooms.size, conversionRate: '0' };
  }
}

async function deleteUserAccount(userId) {
  if (!db || !userId) return false;
  try {
    await db.execute({ sql: 'DELETE FROM auth_tokens WHERE userId = ?', args: [userId] });
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
    return true;
  } catch (err) {
    console.error('[DB] Failed to delete user:', err.message);
    return false;
  }
}

async function setManualPlan(userId, plan, expiresAt, adminNotes = '') {
  const user = await getUserById(userId);
  if (!user) return null;

  const now = new Date();
  let exp = expiresAt;
  if (!exp) {
    exp = (plan === 'pro') ? '2099-12-31T23:59:59.999Z' : null;
  }

  const updated = await updateUser(userId, {
    plan: plan || 'free',
    subscriptionStartedAt: (plan === 'pro') ? now.toISOString() : null,
    subscriptionExpiresAt: exp,
  });

  // Record a payment entry if granting Pro
  if (plan === 'pro') {
    await recordPayment({
      userId: user.id,
      userEmail: user.email,
      amount: 0,
      currency: 'INR',
      status: 'paid',
      source: 'admin_manual',
      notes: adminNotes || 'Granted manually by Admin',
    });
  }

  return { ...updated, isPro: isUserPro(updated) };
}

// ─── Admin Security Middleware ────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  // 1. Master admin secret key via header or query
  const keyHeader = req.headers['x-admin-key'];
  const keyQuery  = req.query.admin_key;
  if ((keyHeader && keyHeader === ADMIN_SECRET_KEY) || (keyQuery && keyQuery === ADMIN_SECRET_KEY)) {
    return next();
  }

  // 2. Cookie session isAdmin flag
  if (req.session && req.session.isAdmin) {
    return next();
  }

  // 3. User Google Email matches ADMIN_EMAILS
  const user = await resolveUser(req);
  if (user && ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return next();
  }

  return res.status(403).json({ error: 'Forbidden: Admin access required.' });
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

        let user = await getUserByGoogleId(profile.id);
        if (!user) {
          user = await getUserByEmail(email);
          if (user) {
            // Link Google account to existing email user
            user = await updateUser(user.id, {
              googleId: profile.id,
              avatar:   user.avatar || profile.photos?.[0]?.value || null,
            });
          } else {
            // New user — create account
            user = await createUser({
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
passport.deserializeUser(async (id, done) => {
  const user = await getUserById(id);
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
      versionName: '2.3.0',
      versionCode: 5,
      apkUrl: 'https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk'
    },
    releaseNotes: 'https://github.com/DilpreetSinghVerma/nextPresent/releases/latest'
  });
});

app.get(['/downloads/NXTslide.apk', '/NXTslide.apk', '/download/android'], (_req, res) => {
  res.redirect('https://github.com/DilpreetSinghVerma/nextPresent/raw/main/public/NXTslide.apk');
});

app.get(['/download/windows', '/downloads/NXTslide-Setup.exe', '/downloads/nextPresent-Setup.exe'], (_req, res) => {
  res.redirect('https://github.com/DilpreetSinghVerma/nextPresent/releases/latest');
});

app.get(['/download/portable', '/downloads/NXTslide-Portable.exe', '/downloads/nextPresent-Portable.exe'], (_req, res) => {
  res.redirect('https://github.com/DilpreetSinghVerma/nextPresent/releases/latest');
});

// ─── Cloud-Synced UI Routes ────────────────────────────────────────────────────
// The Android app and (optionally) Electron load these routes instead of local
// static files. Pushing new HTML/JS/CSS here updates all clients instantly.

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/DilpreetSinghVerma/nextPresent/main/public';
const _staticCache = new Map();

app.get(['/css/{*file}', '/js/{*file}', '/logo.png', '/favicon.ico', '/logo-icon.png', '/logo-icon.jpg', '/logo-wordmark.jpg'], async (req, res) => {
  const filePath = req.path.replace(/^\/+/, '');
  const localPath = path.resolve(__dirname, 'public', filePath);
  if (fs.existsSync(localPath)) {
    if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
    if (filePath.endsWith('.ico')) res.setHeader('Content-Type', 'image/x-icon');
    return res.sendFile(localPath);
  }
  const cached = _staticCache.get(filePath);
  if (cached && (Date.now() - cached.ts) < MOBILE_CACHE_TTL) {
    if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
    if (filePath.endsWith('.ico')) res.setHeader('Content-Type', 'image/x-icon');
    return res.send(cached.content);
  }
  try {
    const ghRes = await fetch(`${GITHUB_RAW_BASE}/${filePath}`, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!ghRes.ok) return res.sendStatus(404);
    const contentType = ghRes.headers.get('content-type');
    const buffer = Buffer.from(await ghRes.arrayBuffer());
    _staticCache.set(filePath, { content: buffer, ts: Date.now() });
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.send(buffer);
  } catch (err) {
    return res.sendStatus(404);
  }
});

app.get(['/mobile', '/r/:code'], async (req, res) => {
  if (_mobileCache && (Date.now() - _mobileCache.ts) < MOBILE_CACHE_TTL) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Source', 'cache');
    return res.send(_mobileCache.html);
  }
  try {
    const ghRes = await fetch(GITHUB_MOBILE_URL, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (!ghRes.ok) throw new Error('GitHub returned ' + ghRes.status);
    const html = await ghRes.text();
    _mobileCache = { html, ts: Date.now() };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Source', 'github');
    return res.send(html);
  } catch (err) {
    console.warn('[/mobile] GitHub fetch failed:', err.message);
    if (_mobileCache) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(_mobileCache.html);
    }
    res.status(503).send('<h1>NXTslide Remote</h1><p>Temporarily unavailable.</p>');
  }
});

// ─── Auth Routes ───────────────────────────────────────────────────────────────


// Initiate Google Sign-In (handles both /auth/google and /api/auth/google)
app.get(['/auth/google', '/api/auth/google'], (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });
  }
  const redirect = req.query.redirect || 'nxtslide://auth';
  req.session.postLoginRedirect = redirect;
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state: redirect, // Google preserves state through the OAuth redirect
  })(req, res, next);
});

// Google OAuth Callback (handles both /auth/google/callback and /api/auth/google/callback)
app.get(['/auth/google/callback', '/api/auth/google/callback'],
  passport.authenticate('google', { failureRedirect: '/api/auth/failed' }),
  async (req, res) => {
    const user = req.user;
    const token = await createAuthToken(user.id);
    const redirect = req.session.postLoginRedirect || req.query.state || '';
    delete req.session.postLoginRedirect;

    const safeUser = {
      id:                    user.id,
      email:                 user.email,
      name:                  user.name,
      avatar:                user.avatar,
      plan:                  user.plan,
      isPro:                 isUserPro(user),
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      token,
    };
    const data = Buffer.from(JSON.stringify(safeUser)).toString('base64');

    // 1. Web browser redirect (e.g. from landing page or web dashboard)
    if (redirect && (redirect.startsWith('http://') || redirect.startsWith('https://'))) {
      try {
        const dest = new URL(redirect);
        dest.searchParams.set('token', token);
        dest.searchParams.set('user', data);
        return res.redirect(dest.toString());
      } catch (_) {}
    }

    // 2. Desktop app / Android redirect: render sleek success page that saves token to browser
    //    localStorage AND automatically launches the desktop app via nxtslide:// deep-link.
    res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><title>NXTslide — Signed In</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { background:#05070d; color:#fff; font-family:system-ui,-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; flex-direction:column; text-align:center; padding:20px; margin:0; }
.card { background:#0f172a; border:1px solid #1e293b; border-radius:18px; padding:32px; max-width:440px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,0.5); box-sizing:border-box; }
.avatar { width:72px; height:72px; border-radius:50%; border:3px solid #6366f1; margin-bottom:1rem; object-fit:cover; }
h2 { color:#fff; margin:0 0 8px; font-size:1.4rem; }
.plan-badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:0.8rem; font-weight:700; margin-bottom:1.5rem; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; width:100%; padding:13px 18px; border-radius:10px; font-weight:700; text-decoration:none; margin-bottom:10px; cursor:pointer; font-size:0.95rem; box-sizing:border-box; transition:all 0.2s; }
.btn-primary { background:linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; border:none; box-shadow:0 4px 14px rgba(99,102,241,0.4); }
.btn-primary:hover { filter:brightness(1.1); transform:translateY(-1px); }
.btn-secondary { background:rgba(255,255,255,0.06); color:#cbd5e1; border:1px solid rgba(255,255,255,0.12); }
.btn-secondary:hover { background:rgba(255,255,255,0.1); }
.hint { margin-top:1.5rem; font-size:0.82rem; color:#94a3b8; line-height:1.45; }
</style></head>
<body>
<div class="card">
${safeUser.avatar ? `<img src="${safeUser.avatar}" class="avatar" alt="avatar">` : ''}
<h2>Welcome, ${safeUser.name || safeUser.email}!</h2>
<p style="color:#94a3b8;font-size:0.9rem;margin-bottom:1rem;">${safeUser.email}</p>
<div>
  <span class="plan-badge" style="background:${safeUser.isPro ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)'}; color:${safeUser.isPro ? '#4ade80' : '#94a3b8'}; border:1px solid ${safeUser.isPro ? 'rgba(34,197,94,0.3)' : 'rgba(148,163,184,0.3)'};">
    ${safeUser.isPro ? '✦ Pro Active' : 'Free Plan'}
  </span>
</div>

<a href="nxtslide://auth?token=${token}&user=${data}" class="btn btn-primary" id="openAppBtn">
  ✦ Return to NXTslide Desktop App
</a>
<a href="/" class="btn btn-secondary">
  Go to Website
</a>

<p class="hint" id="statusHint">
  Opening your NXTslide Desktop App... If it didn't open automatically, click the button above.
</p>
</div>

<script>
  // Store token and user locally in browser (keeps web browser logged in too)
  try {
    localStorage.setItem('nxtslide_auth_token', '${token}');
    localStorage.setItem('nxtslide_user', JSON.stringify(${JSON.stringify(safeUser)}));
  } catch(_) {}

  // Auto-launch desktop app
  const deepLinkUrl = "nxtslide://auth?token=${token}&user=${data}";
  setTimeout(() => {
    try {
      window.location.href = deepLinkUrl;
    } catch(e) {}
  }, 100);

  // Notify parent window if opened as popup
  if (window.opener) {
    window.opener.postMessage({ type: 'NXTSLIDE_AUTH_SUCCESS', token: '${token}', user: ${JSON.stringify(safeUser)} }, '*');
    setTimeout(() => window.close(), 1500);
  }

  // Notify Android WebView bridge if present
  if (window.AndroidApp && window.AndroidApp.onAuthSuccess) {
    window.AndroidApp.onAuthSuccess(JSON.stringify(${JSON.stringify(safeUser)}));
  }
</script>
</body></html>`);
  }
);

app.get(['/auth/failed', '/api/auth/failed'], (_req, res) => {
  res.status(401).send('<h2 style="font-family:sans-serif;color:#ef4444">Sign-in failed. Please try again.</h2>');
});

// Get current user (accepts session cookie or Bearer token)
app.get(['/auth/me', '/api/auth/me'], async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));
  res.json({
    id:                   user.id,
    email:                user.email,
    name:                 user.name,
    avatar:               user.avatar,
    plan:                 user.plan,
    isPro:                isUserPro(user),
    isAdmin,
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    createdAt:            user.createdAt,
  });
});

// Logout
app.post(['/auth/logout', '/api/auth/logout'], async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && db) {
    const token = authHeader.slice(7).trim();
    try { await db.execute({ sql: 'DELETE FROM auth_tokens WHERE token = ?', args: [token] }); } catch (_) {}
  }
  req.logout((err) => {
    if (err) return next(err);
    res.json({ success: true });
  });
});

// ─── Billing Routes ───────────────────────────────────────────────────────────

// Get subscription status (works with both session auth and token auth)
app.get('/api/billing/status', async (req, res) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    plan:                 user.plan,
    isPro:                isUserPro(user),
    subscriptionExpiresAt: user.subscriptionExpiresAt,
    checkoutUrl:          razorpay ? `${BASE_URL}/api/billing/subscribe` : null,
  });
});

// Create Razorpay order for Lifetime Pro activation
app.post('/api/billing/subscribe', async (req, res) => {
  let user = await resolveUser(req);
  if (!user) {
    const email = req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : null;
    if (email && email.includes('@')) {
      user = await getUserByEmail(email);
      if (!user) {
        user = await createUser({
          email,
          name: (req.body && req.body.name) ? String(req.body.name).trim() : email.split('@')[0],
          plan: 'free',
          source: 'inapp_razorpay'
        });
      }
    }
  }

  if (!user) return res.status(401).json({ error: 'Please enter a valid email address to continue' });
  if (!razorpay) return res.status(503).json({ error: 'Payment system not configured' });

  try {
    const receipt = `nxt_ltd_${user.id}_${Date.now()}`;
    const options = {
      amount:   PRO_LIFETIME_PRICE,
      currency: 'INR',
      receipt,
      notes:    { userId: user.id, type: 'lifetime', plan: 'pro', email: user.email }
    };

    const order = await razorpay.orders.create(options);
    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID,
      user: {
        id:    user.id,
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

// Verify Razorpay payment signature and immediately unlock Pro
app.post('/api/billing/verify', async (req, res) => {
  const { orderId, paymentId, signature, email } = req.body || {};
  if (!orderId || !paymentId) {
    return res.status(400).json({ error: 'Missing orderId or paymentId' });
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (keySecret && signature) {
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      if (generatedSignature !== signature) {
        return res.status(400).json({ error: 'Invalid payment signature' });
      }
    }

    let user = await resolveUser(req);
    if (!user && email) {
      user = await getUserByEmail(email.toLowerCase().trim());
    }

    if (user) {
      const startedAt = new Date();
      const expiresAt = new Date('2099-12-31T23:59:59.999Z');
      await updateUser(user.id, {
        plan: 'pro',
        subscriptionStartedAt: startedAt.toISOString(),
        subscriptionExpiresAt: expiresAt.toISOString()
      });

      await recordPayment({
        userId: user.id,
        userEmail: user.email,
        amount: PRO_LIFETIME_PRICE,
        currency: 'INR',
        orderId,
        paymentId,
        status: 'paid',
        source: 'razorpay_direct',
        notes: { paymentId }
      });

      const token = await createAuthToken(user.id);
      return res.json({
        success: true,
        isPro: true,
        plan: 'pro',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isPro: true,
          plan: 'pro'
        }
      });
    }

    res.json({ success: true, isPro: true });
  } catch (err) {
    console.error('[Billing] Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Razorpay Webhook — verifies signature, updates user plan to Lifetime Pro
app.post('/api/billing/webhook', async (req, res) => {
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

      if (type === 'subscription' || type === 'lifetime' || plan === 'pro') {
        const startedAt  = new Date();
        const expiresAt  = new Date('2099-12-31T23:59:59.999Z'); // Permanent Lifetime Pro

        await updateUser(userId, {
          plan: 'pro',
          razorpayCustomerId:    payment?.customer_id || null,
          subscriptionStartedAt: startedAt.toISOString(),
          subscriptionExpiresAt: expiresAt.toISOString(),
        });

        await recordPayment({
          userId,
          userEmail: payment?.email || order?.notes?.email || notes?.email || '',
          amount: payment?.amount || order?.amount || PRO_LIFETIME_PRICE,
          currency: payment?.currency || order?.currency || 'INR',
          orderId: order?.id || payment?.order_id || null,
          paymentId: payment?.id || null,
          status: 'paid',
          source: 'razorpay',
          notes: { paymentMethod: payment?.method, rzpCustomerId: payment?.customer_id },
        });

        console.log(`[Webhook] User ${userId} upgraded to Lifetime Pro!`);
      }
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN MANAGEMENT API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Admin Key / Password Login
app.post('/api/admin/auth/key-login', (req, res) => {
  const { key } = req.body || {};
  if (key && key === ADMIN_SECRET_KEY) {
    req.session.isAdmin = true;
    return res.json({ success: true, token: ADMIN_SECRET_KEY, message: 'Admin authentication successful.' });
  }
  return res.status(401).json({ error: 'Invalid admin secret key.' });
});

// Admin Status & Key Verification
app.get('/api/admin/auth/verify', async (req, res) => {
  const keyHeader = req.headers['x-admin-key'];
  const keyQuery  = req.query.admin_key;
  const isMasterKey = (keyHeader && keyHeader === ADMIN_SECRET_KEY) || (keyQuery && keyQuery === ADMIN_SECRET_KEY);
  const isSessionAdmin = req.session && req.session.isAdmin;
  const user = await resolveUser(req);
  const isEmailAdmin = user && ADMIN_EMAILS.includes(user.email.toLowerCase());

  if (isMasterKey || isSessionAdmin || isEmailAdmin) {
    return res.json({
      authorized: true,
      adminEmail: user?.email || 'admin@nxtslide.master',
      name: user?.name || 'Administrator',
      avatar: user?.avatar || null,
    });
  }
  res.status(401).json({ authorized: false });
});

// KPI & Revenue Stats
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  res.json(await getAdminStats());
});

// Users List (Search, Plan Filter, Pagination)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const q          = (req.query.q || '').trim();
  const plan       = req.query.plan || 'all';
  const limit      = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const offset     = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json(await getAllUsers(q, plan, limit, offset));
});

// Change User Plan (Grant Pro, Revoke to Free, Set Expiration)
app.post('/api/admin/users/:id/plan', requireAdmin, async (req, res) => {
  const { plan, expiresAt, notes } = req.body || {};
  const updated = await setManualPlan(req.params.id, plan, expiresAt, notes);
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, user: updated });
});

// Delete User Account
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const success = await deleteUserAccount(req.params.id);
  if (!success) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, message: 'User deleted successfully.' });
});

// Payments & Revenue Ledger
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  const limit  = Math.min(200, parseInt(req.query.limit, 10) || 100);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json({ payments: await getAllPayments(limit, offset) });
});

// Record Manual / Offline Payment
app.post('/api/admin/payments/manual', requireAdmin, async (req, res) => {
  const { email, amount, notes, upgradeUser } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  let user = await getUserByEmail(email);
  if (!user && upgradeUser) {
    user = await createUser({ email: email.toLowerCase(), name: email.split('@')[0] });
  }

  const payment = await recordPayment({
    userId: user ? user.id : null,
    userEmail: email.toLowerCase(),
    amount: Math.round((parseFloat(amount) || 0) * 100), // convert INR to paise
    currency: 'INR',
    status: 'paid',
    source: 'admin_manual',
    notes: notes || 'Manual payment entry by Admin',
  });

  if (upgradeUser && user) {
    await updateUser(user.id, {
      plan: 'pro',
      subscriptionStartedAt: new Date().toISOString(),
      subscriptionExpiresAt: '2099-12-31T23:59:59.999Z',
    });
  }

  res.json({ success: true, payment });
});

// Check Razorpay & Payment Gateway Configuration
app.get('/api/admin/billing/check', requireAdmin, async (_req, res) => {
  const isConfigured = !!(razorpay && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const isWebhookSet = !!process.env.RAZORPAY_WEBHOOK_SECRET;
  let apiSuccess = false;
  let message = '';
  let orderDetails = null;

  if (isConfigured) {
    try {
      const order = await razorpay.orders.create({
        amount: 100, // 1 INR in paise (test order verification)
        currency: 'INR',
        receipt: `ping_${Date.now()}`,
        notes: { ping: true, source: 'admin_check' }
      });
      if (order && order.id) {
        apiSuccess = true;
        message = 'Razorpay Live API connection verified successfully! Order creation works.';
        orderDetails = { orderId: order.id, amount: order.amount, currency: order.currency };
      }
    } catch (err) {
      message = err.description || err.error?.description || err.message || 'Razorpay API call failed';
    }
  } else {
    message = 'Razorpay credentials (RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET) not set in environment.';
  }

  res.json({
    configured: isConfigured,
    keyId: process.env.RAZORPAY_KEY_ID ? (process.env.RAZORPAY_KEY_ID.slice(0, 10) + '...') : null,
    webhookSecretConfigured: isWebhookSet,
    apiSuccess,
    message,
    orderDetails,
  });
});

// Serve Admin Panel UI
app.get(['/admin', '/admin.html'], async (_req, res) => {
  const localPaths = [
    path.resolve(__dirname, 'public', 'admin.html'),
    path.resolve(__dirname, '..', 'public', 'admin.html')
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      try {
        const html = fs.readFileSync(p, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (_) {}
    }
  }
  try {
    const ghRes = await fetch(`${GITHUB_RAW_BASE}/admin.html`, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (ghRes.ok) {
      const html = await ghRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (_) {}
  res.status(404).send('<h1>Admin Panel Not Found</h1>');
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

// Serve Landing Page (index.html)
app.get(['/', '/index.html'], async (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html')) {
    return res.json({ service: 'NXTslide Relay', rooms: rooms.size, version: '3.0.0' });
  }
  const localPaths = [
    path.resolve(__dirname, 'public', 'index.html'),
    path.resolve(__dirname, '..', 'public', 'index.html')
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      try {
        const html = fs.readFileSync(p, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (_) {}
    }
  }
  try {
    const ghRes = await fetch(`${GITHUB_RAW_BASE}/index.html`, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (ghRes.ok) {
      const html = await ghRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (_) {}
  res.json({ service: 'NXTslide Relay', rooms: rooms.size, version: '3.0.0' });
});

// Serve Dashboard (dashboard.html)
app.get(['/dashboard', '/dashboard.html'], async (_req, res) => {
  const localPaths = [
    path.resolve(__dirname, 'public', 'dashboard.html'),
    path.resolve(__dirname, '..', 'public', 'dashboard.html')
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      try {
        const html = fs.readFileSync(p, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (_) {}
    }
  }
  try {
    const ghRes = await fetch(`${GITHUB_RAW_BASE}/dashboard.html`, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (ghRes.ok) {
      const html = await ghRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (_) {}
  res.status(404).send('<h1>Dashboard Not Found</h1>');
});

// Serve Laser Overlay (laser.html)
app.get(['/laser', '/laser.html'], async (_req, res) => {
  const localPaths = [
    path.resolve(__dirname, 'public', 'laser.html'),
    path.resolve(__dirname, '..', 'public', 'laser.html')
  ];
  for (const p of localPaths) {
    if (fs.existsSync(p)) {
      try {
        const html = fs.readFileSync(p, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (_) {}
    }
  }
  try {
    const ghRes = await fetch(`${GITHUB_RAW_BASE}/laser.html`, {
      headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (ghRes.ok) {
      const html = await ghRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  } catch (_) {}
  res.status(404).send('<h1>Laser Not Found</h1>');
});

// Policy Pages (terms, privacy, refund, contact)
['terms', 'privacy', 'refund', 'contact'].forEach((page) => {
  app.get([`/${page}`, `/${page}.html`], async (_req, res) => {
    const localPaths = [
      path.resolve(__dirname, 'public', `${page}.html`),
      path.resolve(__dirname, '..', 'public', `${page}.html`)
    ];
    for (const p of localPaths) {
      if (fs.existsSync(p)) {
        try {
          const html = fs.readFileSync(p, 'utf8');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(html);
        } catch (_) {}
      }
    }
    try {
      const ghRes = await fetch(`${GITHUB_RAW_BASE}/${page}.html`, {
        headers: { 'User-Agent': 'NXTslide-Relay/3.0', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(8000),
      });
      if (ghRes.ok) {
        const html = await ghRes.text();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    } catch (_) {}
    res.status(404).send(`<h1>${page.toUpperCase()} Page Not Found</h1>`);
  });
});

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
(async () => {
  try {
    db = await setupDatabase();
  } catch (err) {
    console.error('[Startup] Database initialization failed:', err.message);
  }
  server.listen(PORT, () => console.log('[Relay] NXTslide Cloud Relay v3.0.0 on port', PORT));
})();

process.on('SIGTERM', () => {
  rooms.forEach((_, c) => deleteRoom(c));
  server.close(() => process.exit(0));
});
