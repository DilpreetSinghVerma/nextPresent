/**
 * lib/licenseService.js
 * NXTslide Pro License Key Activation & Verification Engine
 * Supports Lemon Squeezy, Gumroad, and Offline Dev Keys.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// License storage directory: ~/.nxtslide/license.json
const STORAGE_DIR = path.join(os.homedir(), '.nxtslide');
const LICENSE_FILE = path.join(STORAGE_DIR, 'license.json');

// Configuration
const DEFAULT_CHECKOUT_URL = process.env.CHECKOUT_URL || 'https://github.com/DilpreetSinghVerma/nextPresent#pricing';

/**
 * Ensures ~/.nxtslide directory exists
 */
function ensureStorageDir() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('[License] Failed to create storage dir:', err.message);
  }
}

/**
 * Reads locally cached license
 */
function readLocalLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      const raw = fs.readFileSync(LICENSE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.valid === true) {
        return data;
      }
    }
  } catch (err) {
    console.warn('[License] Could not read local license file:', err.message);
  }
  return null;
}

/**
 * Saves license data locally
 */
function saveLocalLicense(data) {
  try {
    ensureStorageDir();
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[License] Failed to write license file:', err.message);
    return false;
  }
}

/**
 * Masks a license key for display (e.g. NXT-PRO-****-9821)
 */
function maskKey(key) {
  if (!key || key.length < 8) return '****';
  const first = key.slice(0, 4);
  const last = key.slice(-4);
  return `${first}-****-${last}`;
}

/**
 * Helper to make HTTPS POST requests without external dependencies
 */
function postHttps(url, payload) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const postData = typeof payload === 'string' ? payload : JSON.stringify(payload);

      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'NXTslide-License-Client/1.0'
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out connecting to license server'));
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Verifies with Lemon Squeezy API
 * https://docs.lemonsqueezy.com/help/licensing/license-api
 */
async function verifyLemonSqueezy(licenseKey, instanceName) {
  try {
    const res = await postHttps('https://api.lemonsqueezy.com/v1/licenses/activate', {
      license_key: licenseKey,
      instance_name: instanceName || os.hostname() || 'Desktop'
    });

    if (res.data && res.data.activated === true) {
      return {
        valid: true,
        provider: 'lemonsqueezy',
        customerEmail: res.data.meta?.customer_email || 'Customer',
        instanceId: res.data.instance?.id,
        message: 'Lemon Squeezy License Activated'
      };
    }

    const errorMsg = res.data?.error || res.data?.message || 'Invalid Lemon Squeezy license key';
    return { valid: false, message: errorMsg };
  } catch (err) {
    return { valid: false, message: `Lemon Squeezy connection error: ${err.message}` };
  }
}

/**
 * Verifies with Gumroad API
 * https://app.gumroad.com/api#licenses
 */
async function verifyGumroad(licenseKey, productPermalink) {
  try {
    const permalink = productPermalink || process.env.GUMROAD_PRODUCT_PERMALINK;
    const res = await postHttps('https://api.gumroad.com/v2/licenses/verify', {
      product_permalink: permalink,
      license_key: licenseKey
    });

    if (res.data && res.data.success === true) {
      return {
        valid: true,
        provider: 'gumroad',
        customerEmail: res.data.purchase?.email || 'Customer',
        message: 'Gumroad License Verified'
      };
    }

    const errorMsg = res.data?.message || 'Invalid Gumroad license key';
    return { valid: false, message: errorMsg };
  } catch (err) {
    return { valid: false, message: `Gumroad connection error: ${err.message}` };
  }
}

/**
 * Core activation method
 */
async function activateLicense(rawKey, instanceName = '') {
  const key = (rawKey || '').trim();
  if (!key || key.length < 6) {
    return { success: false, message: 'Please enter a valid license key (min 6 characters).' };
  }

  const upperKey = key.toUpperCase();

  // 1. Built-in Dev / Master Test Keys (for development, demos, and testing)
  const isDevKey = upperKey.startsWith('NXT-PRO-') ||
                   upperKey.startsWith('DEV-') ||
                   upperKey === 'TEST-PRO-LIFETIME' ||
                   (process.env.MASTER_LICENSE_KEY && upperKey === process.env.MASTER_LICENSE_KEY.toUpperCase());

  if (isDevKey) {
    const licenseRecord = {
      valid: true,
      key: maskKey(upperKey),
      fullKey: upperKey,
      provider: 'dev',
      customerEmail: 'developer@nxtslide.app',
      activatedAt: new Date().toISOString()
    };
    saveLocalLicense(licenseRecord);
    return {
      success: true,
      isPro: true,
      message: '✅ Pro Lifetime Activated (Dev/VIP Key)',
      license: licenseRecord
    };
  }

  // 2. Lemon Squeezy Provider
  const provider = (process.env.LICENSE_PROVIDER || '').toLowerCase();
  if (provider === 'lemonsqueezy' || process.env.LEMON_STORE_ID) {
    const lemonResult = await verifyLemonSqueezy(key, instanceName);
    if (lemonResult.valid) {
      const licenseRecord = {
        valid: true,
        key: maskKey(key),
        fullKey: key,
        provider: 'lemonsqueezy',
        customerEmail: lemonResult.customerEmail,
        instanceId: lemonResult.instanceId,
        activatedAt: new Date().toISOString()
      };
      saveLocalLicense(licenseRecord);
      return {
        success: true,
        isPro: true,
        message: '✅ Pro Lifetime Activated via Lemon Squeezy!',
        license: licenseRecord
      };
    } else {
      return { success: false, message: lemonResult.message };
    }
  }

  // 3. Gumroad Provider
  if (provider === 'gumroad' || process.env.GUMROAD_PRODUCT_PERMALINK) {
    const gumroadResult = await verifyGumroad(key);
    if (gumroadResult.valid) {
      const licenseRecord = {
        valid: true,
        key: maskKey(key),
        fullKey: key,
        provider: 'gumroad',
        customerEmail: gumroadResult.customerEmail,
        activatedAt: new Date().toISOString()
      };
      saveLocalLicense(licenseRecord);
      return {
        success: true,
        isPro: true,
        message: '✅ Pro Lifetime Activated via Gumroad!',
        license: licenseRecord
      };
    } else {
      return { success: false, message: gumroadResult.message };
    }
  }

  // 4. Default Verification for Launch: If no provider API keys are configured yet in .env,
  // accept any structured license key with format XXX-XXX-XXX or min 8 chars so beta testers
  // and direct customers can activate immediately!
  if (key.length >= 8) {
    const licenseRecord = {
      valid: true,
      key: maskKey(key),
      fullKey: key,
      provider: 'direct',
      customerEmail: 'pro-user@nxtslide.app',
      activatedAt: new Date().toISOString()
    };
    saveLocalLicense(licenseRecord);
    return {
      success: true,
      isPro: true,
      message: '✅ Pro Lifetime Activated!',
      license: licenseRecord
    };
  }

  return { success: false, message: 'Invalid license key. Please check your key and try again.' };
}

/**
 * Returns current license status
 */
function getLicenseStatus() {
  const local = readLocalLicense();
  if (local && local.valid) {
    return {
      isPro: true,
      provider: local.provider,
      maskedKey: local.key,
      customerEmail: local.customerEmail,
      activatedAt: local.activatedAt,
      checkoutUrl: DEFAULT_CHECKOUT_URL
    };
  }

  return {
    isPro: false,
    provider: null,
    maskedKey: null,
    customerEmail: null,
    activatedAt: null,
    checkoutUrl: DEFAULT_CHECKOUT_URL
  };
}

/**
 * Deactivates / removes the local license
 */
function deactivateLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      fs.unlinkSync(LICENSE_FILE);
    }
    return { success: true, message: 'License removed.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = {
  activateLicense,
  getLicenseStatus,
  deactivateLicense,
  DEFAULT_CHECKOUT_URL
};
