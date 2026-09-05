const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');

// Start the internal nextPresent host server
try {
  require('../server.js');
} catch (err) {
  console.error('[Electron] Server start error:', err);
}

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
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    title: 'nextPresent — by Dilpreet Singh',
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
      label: 'nextPresent v1.0 — by Dilpreet Singh',
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
    { type: 'separator' },
    {
      label: 'Quit nextPresent',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('nextPresent — Presentation Remote by Dilpreet Singh');
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
