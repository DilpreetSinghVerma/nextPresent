const { app, BrowserWindow, Tray, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

let autoUpdater = null;

/**
 * Frees port 3333 (or any port) by finding and killing the process occupying it.
 * Works on Windows using netstat + taskkill.
 */
function freePort(port) {
  try {
    // netstat output has the PID in the last column of lines matching the port
    const output = execSync(
      `netstat -ano | findstr :${port}`,
      { encoding: 'utf8', windowsHide: true }
    );
    const lines = output.split('\n').filter(l =>
      l.includes(`:${port} `) && l.includes('LISTENING')
    );
    const pids = new Set();
    lines.forEach(line => {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid && pid > 0) pids.add(pid);
    });

    pids.forEach(pid => {
      try {
        execSync(`taskkill /PID ${pid} /F`, { windowsHide: true });
        console.log(`[Electron] Freed port ${port} — killed PID ${pid}`);
      } catch (_) {}
    });
  } catch (_) {
    // Port was already free — no output from netstat, that's fine
  }
}

// Free port 3333 before starting the internal server so we never get EADDRINUSE
freePort(3333);

// Small delay to let the OS reclaim the port socket
setTimeout(() => {
  try {
    require('../server.js');
  } catch (err) {
    console.error('[Electron] Server start error:', err);
  }
}, 250);

let mainWindow = null;
let tray = null;
let isQuitting = false;

const PORT = process.env.PORT || 3333;
const DASHBOARD_URL = `http://localhost:${PORT}/dashboard`;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    setupAutoUpdater();
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    title: 'NXTslide — by Dilpreet Singh',
    icon: iconPath,
    backgroundColor: '#05070d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  waitForServer(DASHBOARD_URL, () => {
    mainWindow.loadURL(DASHBOARD_URL);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Minimize to tray when closing so presentations aren't interrupted accidentally
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'NXTslide v1.0 — by Dilpreet Singh',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Show Dashboard',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: 'Open in Default Browser',
      click: () => {
        shell.openExternal(DASHBOARD_URL);
      }
    },
    {
      label: 'Check for Updates...',
      click: () => {
        if (app.isPackaged) {
          autoUpdater.checkForUpdates().catch(() => {
            shell.openExternal('https://github.com/DilpreetSinghVerma/nextPresent/releases/latest');
          });
        } else {
          shell.openExternal('https://github.com/DilpreetSinghVerma/nextPresent/releases/latest');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit NXTslide',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('NXTslide — Presentation Remote by Dilpreet Singh');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function setupAutoUpdater() {
  if (!app || !app.isPackaged) {
    console.log('[AutoUpdater] In development mode — skipping auto-update checks');
    return;
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.warn('[AutoUpdater] Failed to load electron-updater:', err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking GitHub releases...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        if (typeof showUpdateToast === 'function') {
          showUpdateToast('Downloading NXTslide v${info.version}...');
        }
      `).catch(() => {});
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded successfully:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        if (typeof showUpdateReadyToast === 'function') {
          showUpdateReadyToast('NXTslide v${info.version} ready! Restart to apply.');
        }
      `).catch(() => {});
    }
  });

  autoUpdater.on('error', (err) => {
    console.warn('[AutoUpdater] Check error:', err ? err.message : err);
  });

  // Check 5 seconds after launch, then every 4 hours
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 5000);

  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

function waitForServer(url, callback, maxTries = 30) {
  let tries = 0;
  const check = () => {
    http.get(url, (res) => {
      if (res.statusCode === 200 || res.statusCode === 304) {
        callback();
      } else {
        retry();
      }
    }).on('error', retry);
  };

  const retry = () => {
    tries++;
    if (tries < maxTries) {
      setTimeout(check, 300);
    } else {
      callback();
    }
  };

  check();
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
