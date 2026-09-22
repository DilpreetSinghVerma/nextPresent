/**
 * lib/cloudSync.js
 * Automatic Cloud UI Synchronization for NXTslide Windows Desktop
 *
 * Keeps the desktop dashboard and mobile web UI continuously synced
 * with the latest GitHub repository releases without requiring users
 * to download a new installer for frontend updates.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

const STORAGE_DIR  = path.join(os.homedir(), '.nxtslide');
const UI_CACHE_DIR = path.join(STORAGE_DIR, 'ui_cache');
const VERSION_FILE = path.join(UI_CACHE_DIR, 'sync_version.json');

const GITHUB_RAW_BASE   = 'https://raw.githubusercontent.com/DilpreetSinghVerma/nextPresent/main/public';
const GITHUB_COMMIT_API = 'https://api.github.com/repos/DilpreetSinghVerma/nextPresent/commits/main';

const SYNC_FILES = [
  'dashboard.html',
  'js/dashboard.js',
  'js/auth.js',
  'css/dashboard.css',
  'mobile.html',
  'js/mobile.js',
  'css/mobile.css',
  'admin.html',
];

let isUpdating = false;

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function fetchUrl(url, isJson = false) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    const req = https.request({
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'GET',
      headers: {
        'User-Agent': 'NXTslide-CloudSync/3.0',
        'Cache-Control': 'no-cache',
      },
      timeout: 8000,
    }, (res) => {
      // Handle HTTP redirects (301, 302, 307)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, isJson).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (isJson) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.end();
  });
}

function readVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function writeVersion(data) {
  ensureDir(UI_CACHE_DIR);
  try {
    fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

/**
 * Returns absolute path in UI_CACHE_DIR if the file exists there,
 * otherwise returns null (caller should fall back to bundled file).
 */
function getCachedFilePath(relPath) {
  const norm = relPath.replace(/^(\/|\\)+/, '');
  const candidate = path.join(UI_CACHE_DIR, norm);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Checks for updates from GitHub and downloads changed files into cache.
 */
async function checkAndUpdate(onUpdate) {
  if (isUpdating) return { updating: true };
  isUpdating = true;

  try {
    ensureDir(UI_CACHE_DIR);
    console.log('[CloudSync] Checking GitHub for latest UI updates...');
    const commitData = await fetchUrl(GITHUB_COMMIT_API, true);
    const remoteSha = commitData?.sha;
    if (!remoteSha) {
      isUpdating = false;
      return { success: false, reason: 'No SHA found' };
    }

    const current = readVersion();
    if (current && current.commitSha === remoteSha) {
      console.log(`[CloudSync] UI is up-to-date (${remoteSha.substring(0, 7)}).`);
      isUpdating = false;
      return { success: true, updated: false, sha: remoteSha };
    }

    console.log(`[CloudSync] New UI version found: ${remoteSha.substring(0, 7)}. Downloading assets...`);

    let downloadCount = 0;
    for (const relFile of SYNC_FILES) {
      try {
        const fileUrl = `${GITHUB_RAW_BASE}/${relFile}`;
        const content = await fetchUrl(fileUrl, false);
        const destPath = path.join(UI_CACHE_DIR, relFile);
        ensureDir(path.dirname(destPath));
        fs.writeFileSync(destPath, content, 'utf8');
        downloadCount++;
      } catch (err) {
        console.warn(`[CloudSync] Failed to download ${relFile}:`, err.message);
      }
    }

    writeVersion({
      commitSha: remoteSha,
      updatedAt: Date.now(),
      fileCount: downloadCount,
    });

    console.log(`[CloudSync] Successfully synced ${downloadCount} UI assets to ${UI_CACHE_DIR}`);
    if (typeof onUpdate === 'function') {
      onUpdate(remoteSha);
    }

    isUpdating = false;
    return { success: true, updated: true, sha: remoteSha, count: downloadCount };
  } catch (err) {
    console.warn('[CloudSync] Check failed (running offline):', err.message);
    isUpdating = false;
    return { success: false, error: err.message };
  }
}

/**
 * Initializes background synchronization
 */
function init(onUpdate) {
  // Check 3 seconds after launch
  setTimeout(() => {
    checkAndUpdate(onUpdate).catch(() => {});
  }, 3000);

  // Periodic check every 30 minutes
  setInterval(() => {
    checkAndUpdate(onUpdate).catch(() => {});
  }, 30 * 60 * 1000);
}

module.exports = {
  init,
  checkAndUpdate,
  getCachedFilePath,
  getVersion: readVersion,
};
