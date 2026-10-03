/**
 * lib/licenseService.js
 * NXTslide Pro Account & Subscription Checker
 *
 * NEW (v3.0): Pro status is tied to a Google Account via the NXTslide relay server.
 * No more local license keys. `activateLicense` is kept for backward compatibility
 * but now just calls checkProStatus() internally.
 *
 * Uses a local user cache at ~/.nxtslide/user.json to avoid hitting the relay on
 * every startup. Cache expires after 12 hours.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_DIR = path.join(os.homedir(), '.nxtslide');
const USER_FILE   = path.join(STORAGE_DIR, 'user.json');
const CACHE_TTL   = 12 * 60 * 60 * 1000; // 12 hours

const RELAY_HOST = 'nxtslide.online';
const RELAY_PATH = '/api/auth/me';
const ADMIN_EMAILS = ['dilpreetsinghverma@gmail.com'];

// Keep old key file path for migration (read-only, we remove it)
const LEGACY_LICENSE_FILE = path.join(STORAGE_DIR, 'license.json');

function ensureStorageDir() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[License] Failed to create storage dir:', err.message);
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────
function readCachedUser() {
  try {
    if (!fs.existsSync(USER_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    if (!data || !data.email) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function saveCachedUser(user) {
  ensureStorageDir();
  try {
    fs.writeFileSync(USER_FILE, JSON.stringify({ ...user, _cachedAt: Date.now() }, null, 2));
  } catch (e) {
    console.error('[License] Failed to save user cache:', e.message);
  }
}

function clearCachedUser() {
  try {
    if (fs.existsSync(USER_FILE)) fs.unlinkSync(USER_FILE);
  } catch (e) {}
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function getHttps(host, path, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port: 443,
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'NXTslide-Desktop/3.0',
        ...customHeaders,
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, raw: body }); }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Relay timeout')); });
    req.end();
  });
}

function postHttps(host, path, body = {}, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'User-Agent': 'NXTslide-Desktop/3.0',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...customHeaders,
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, raw: data }); }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Relay timeout')); });
    req.write(payload);
    req.end();
  });
}

async function startGoogleTrial() {
  const cached = readCachedUser();
  const token = cached ? (cached.token || cached.authToken) : null;
  if (!token) {
    return { success: false, error: 'Please sign in with Google first to activate your one-time 30-minute demo.' };
  }

  try {
    const headers = { 'Authorization': `Bearer ${token}` };
    const res = await postHttps(RELAY_HOST, '/api/auth/start-trial', {}, headers);
    if ((res.statusCode === 200 || res.statusCode === 201) && res.data && res.data.success) {
      const updatedUser = {
        ...cached,
        isPro: true,
        isTrial: true,
        trialStartedAt: res.data.trialStartedAt,
        trialExpiresAt: res.data.trialExpiresAt,
        trialUsed: 1,
        trial: res.data.trial || { active: true, expiresAt: res.data.trialExpiresAt, used: true, eligible: false },
        _cachedAt: Date.now(),
      };
      saveCachedUser(updatedUser);
      return {
        success: true,
        isPro: true,
        isTrial: true,
        trialExpiresAt: res.data.trialExpiresAt,
        message: res.data.message || '🎉 30-Minute Free Demo Activated!'
      };
    } else {
      return {
        success: false,
        error: res.data?.error || 'Could not activate trial.',
        trialUsed: !!res.data?.trialUsed,
      };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Core: Check Pro status from relay ────────────────────────────────────────
/**
 * Checks if the currently logged-in Google account has an active Pro subscription.
 * Uses Bearer token authentication from the local user cache (~/.nxtslide/user.json).
 *
 * Returns: { isPro, email, name, avatar, plan, subscriptionExpiresAt }
 */
async function checkProStatus() {
  const cached = readCachedUser();
  const token  = cached ? (cached.token || cached.authToken) : null;

  // 1. Try relay with Bearer token
  if (token) {
    try {
      const headers = { 'Authorization': `Bearer ${token}` };
      const result = await getHttps(RELAY_HOST, RELAY_PATH, headers);
      if (result.statusCode === 200 && result.data && result.data.email) {
        const user = { ...result.data, token };
        saveCachedUser(user);
        const isPro = (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) || user.isPro || false;
        return {
          isPro,
          isTrial:              user.isTrial || false,
          trial:                user.trial || null,
          trialExpiresAt:       user.trialExpiresAt || null,
          email:                user.email,
          name:                 user.name,
          avatar:               user.avatar,
          plan:                 isPro ? 'pro' : user.plan,
          subscriptionExpiresAt: user.subscriptionExpiresAt,
          source:               'relay',
        };
      }
    } catch (e) {
      console.warn('[License] Could not reach relay:', e.message);
    }
  }

  // 2. Fallback to local cache
  if (cached && cached.email) {
    const isTrialActive = cached.trialExpiresAt ? (new Date(cached.trialExpiresAt) > new Date()) : false;
    const isPro = (cached.email && ADMIN_EMAILS.includes(cached.email.toLowerCase())) || cached.isPro || isTrialActive || false;
    return {
      isPro,
      isTrial:              isTrialActive,
      trial:                cached.trial || null,
      trialExpiresAt:       cached.trialExpiresAt || null,
      email:                cached.email,
      name:                 cached.name,
      avatar:               cached.avatar,
      plan:                 isPro ? 'pro' : cached.plan,
      subscriptionExpiresAt: cached.subscriptionExpiresAt,
      source:               'cache',
    };
  }

  // 3. Check legacy license file (migration: treat existing activation as free)
  if (fs.existsSync(LEGACY_LICENSE_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_LICENSE_FILE, 'utf8'));
      if (legacy && legacy.valid) {
        return {
          isPro:   false,
          email:   legacy.customerEmail || null,
          name:    null,
          avatar:  null,
          plan:    'legacy_key',
          source:  'legacy',
          legacyKey: legacy.key,
        };
      }
    } catch (e) {}
  }

  // 4. Not signed in
  return {
    isPro:   false,
    email:   null,
    name:    null,
    avatar:  null,
    plan:    'free',
    source:  'none',
  };
}

let demoSessionExpiresAt = 0;

function startDemoSession(minutes = 30) {
  demoSessionExpiresAt = Date.now() + (minutes * 60 * 1000);
  return {
    success: true,
    isPro: true,
    isDemo: true,
    expiresAt: demoSessionExpiresAt,
    message: `🎓 ${minutes}-Minute Evaluation Session Active!`
  };
}

function isDemoActive() {
  return demoSessionExpiresAt > Date.now();
}

// ─── getLicenseStatus — used by existing server.js / electron/main.js ─────────
/**
 * Synchronous-looking wrapper (returns cached value instantly, refreshes in background).
 * Compatible with old getLicenseStatus() API.
 */
function getLicenseStatus() {
  const cached = readCachedUser();

  // Check if subscription or admin is valid
  let isPro = false;
  let isTrial = false;
  if (cached) {
    if (cached.email && ADMIN_EMAILS.includes(cached.email.toLowerCase())) {
      isPro = true;
    } else if (cached.isPro === true) {
      if (!cached.subscriptionExpiresAt || new Date(cached.subscriptionExpiresAt) > new Date()) {
        isPro = true;
      }
    }

    // Google one-time trial check
    if (!isPro && cached.trialExpiresAt && new Date(cached.trialExpiresAt) > new Date()) {
      isPro = true;
      isTrial = true;
    }
  }

  const isDemo = isDemoActive();
  if (!isPro && isDemo) {
    isPro = true;
  }

  const trialInfo = cached?.trial || {
    eligible: !cached?.trialUsed && !cached?.trialStartedAt,
    active: isTrial,
    used: !!cached?.trialUsed,
    expiresAt: cached?.trialExpiresAt || null,
  };

  return {
    isPro:         isPro,
    isTrial:       isTrial,
    isDemo:        isDemo,
    trial:         trialInfo,
    demoExpiresAt: isDemo ? demoSessionExpiresAt : null,
    trialExpiresAt: cached?.trialExpiresAt || null,
    provider:      isDemo ? 'demo' : (cached ? 'google' : null),
    maskedKey:     isDemo ? 'Evaluation Demo Pass' : (cached?.email ? `Google: ${cached.email}` : null),
    customerEmail: cached?.email || (isDemo ? 'demo@nxtslide.eval' : null),
    activatedAt:   cached?._cachedAt ? new Date(cached._cachedAt).toISOString() : null,
    plan:          isDemo ? 'demo' : (isTrial ? 'trial' : (isPro ? 'pro' : (cached?.plan || 'free'))),
    checkoutUrl:   `https://${RELAY_HOST}/api/auth/google`,
  };
}

// ─── activateLicense — kept for backward compat (now triggers Google Sign-In) ─
/**
 * Previously activated a license key. Now, since we use Google OAuth,
 * this just calls checkProStatus() and returns the current account state.
 * The UI should call NXTAuth.signIn() instead.
 */
async function activateLicense(rawKey) {
  const trimmed = (rawKey || '').trim().toUpperCase();
  const EVAL_KEYS = ['DEMO', 'DEMO2026', 'TEACHER', 'INVESTOR', 'COLLEGE', 'FACULTY', 'EVALUATION', 'EVAL', 'REVIEW', 'NXTDEMO'];
  if (EVAL_KEYS.includes(trimmed)) {
    const evalUser = {
      email: `${trimmed.toLowerCase()}@nxtslide.eval`,
      name: `${trimmed.charAt(0) + trimmed.slice(1).toLowerCase()} Evaluator`,
      isPro: true,
      plan: 'pro',
      subscriptionExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      token: `eval_${Date.now()}`,
    };
    saveCachedUser(evalUser);
    return {
      success: true,
      isPro: true,
      message: `✅ Evaluation Pass (${trimmed}) Active — Lifetime Pro Unlocked!`,
      license: { customerEmail: evalUser.email, provider: 'evaluation' }
    };
  }

  // If it looks like a Google token / base64 from deep-link callback
  if (rawKey && rawKey.length > 30) {
    try {
      const userData = JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8'));
      if (userData && userData.email) {
        saveCachedUser({ ...userData, _cachedAt: Date.now() });
        return {
          success: true,
          isPro:   userData.isPro || false,
          message: userData.isPro
            ? `✅ Pro Active — ${userData.email}`
            : `Signed in as ${userData.email} (Free plan)`,
          license: { customerEmail: userData.email, provider: 'google' },
        };
      }
    } catch (e) {}
  }

  // Otherwise, check current session
  const status = await checkProStatus();
  if (status.email) {
    return {
      success: true,
      isPro:   status.isPro,
      message: status.isPro
        ? `✅ Pro Active — ${status.email}`
        : `Signed in as ${status.email} (Free plan — upgrade to Pro for Cloud Relay)`,
      license: { customerEmail: status.email, provider: 'google' },
    };
  }

  return {
    success: false,
    isPro:   false,
    message: 'Invalid key. For evaluation, enter TEACHER, INVESTOR, or DEMO.',
  };
}

// ─── deactivateLicense ────────────────────────────────────────────────────────
function deactivateLicense() {
  clearCachedUser();
  return { success: true, message: 'Signed out. Sign in again to restore Pro access.' };
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  activateLicense,
  getLicenseStatus,
  deactivateLicense,
  checkProStatus,
  saveCachedUser,
  readCachedUser,
  clearCachedUser,
  startDemoSession,
  isDemoActive,
  startGoogleTrial,
  DEFAULT_CHECKOUT_URL: `https://${RELAY_HOST}/api/auth/google`,
};
