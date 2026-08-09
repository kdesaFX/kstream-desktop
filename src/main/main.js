'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  session,
  dialog,
} = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { handlers, setupInterceptors } = require('./ipc-handlers');
const SimpleStore = require('./storage');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
// Temporary production host until kdesa.stream is live on the VPS.
const DEFAULT_STREAM_URL =
  process.env.KSTREAM_URL || 'https://kstream-one.vercel.app';
const LEGACY_STREAM_HOSTS = new Set(['kstream.lol', 'www.kstream.lol']);

const store = new SimpleStore({
  configName: 'user-preferences',
  defaults: {
    windowBounds: { width: 1280, height: 800 },
    streamUrl: DEFAULT_STREAM_URL,
    closeToTray: true,
  },
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

function migrateStreamUrl() {
  const current = store.get('streamUrl', DEFAULT_STREAM_URL);
  if (!current || typeof current !== 'string') {
    store.set('streamUrl', DEFAULT_STREAM_URL);
    return;
  }
  try {
    const host = new URL(current).hostname.toLowerCase();
    if (LEGACY_STREAM_HOSTS.has(host)) {
      store.set('streamUrl', DEFAULT_STREAM_URL);
    }
  } catch {
    store.set('streamUrl', DEFAULT_STREAM_URL);
  }
}

migrateStreamUrl();

function getStreamUrl() {
  return store.get('streamUrl', DEFAULT_STREAM_URL) || DEFAULT_STREAM_URL;
}

function getStreamHostname() {
  try {
    return new URL(getStreamUrl()).hostname;
  } catch {
    return null;
  }
}

function createTray(win) {
  const iconPath = path.join(ROOT, 'logo.png');
  let image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    image = image.resize({ width: 16, height: 16 });
  }

  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('kstream');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show kstream',
      click: () => {
        win.show();
        win.focus();
      },
    },
    {
      label: 'Check for updates',
      click: () => {
        autoUpdater.checkForUpdates().catch((err) => {
          console.warn('[kstream-desktop] update check failed', err);
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    win.show();
    win.focus();
  });
}

function createWindow() {
  const bounds = store.get('windowBounds', { width: 1280, height: 800 });
  const iconPath = path.join(ROOT, 'logo.png');

  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    icon: iconPath,
    title: 'kstream',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && store.get('closeToTray', true)) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      const { width, height, x, y } = mainWindow.getBounds();
      store.set('windowBounds', { width, height, x, y });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // aborted
    console.error('[kstream-desktop] failed to load', code, desc, url);
    dialog.showErrorBox(
      'kstream failed to load',
      `Could not open ${url}\n\n${desc} (${code})\n\nCheck your connection, then restart the app.`,
    );
  });

  const url = getStreamUrl();
  console.log('[kstream-desktop] loading', url);
  mainWindow.loadURL(url);

  createTray(mainWindow);
  return mainWindow;
}

function registerIpc() {
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, (_event, body) => handler(body));
  });

  // No-op channels the web may fire
  ipcMain.handle('updateMediaMetadata', async () => ({ success: true }));
  ipcMain.handle('openOfflineApp', async () => ({ success: true }));

  ipcMain.on('open-settings', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'kstream',
      message: 'App settings',
      detail:
        'Core v1 loads your kstream site with native scraping.\n\n' +
        `URL: ${getStreamUrl()}\n\n` +
        'Offline downloads and advanced desktop settings come in a later update.\n\n' +
        'Unsigned builds may show a Windows SmartScreen warning — choose More info → Run anyway.',
    });
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[kstream-desktop] skipping auto-updater in dev');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('[kstream-desktop] update available', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[kstream-desktop] update downloaded', info.version);
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update ready',
        message: `kstream ${info.version} is ready to install.`,
        detail: 'Restart now to apply the update?',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[kstream-desktop] updater error', err);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[kstream-desktop] update check failed', err);
    });
  }, 5000);
}

app.whenReady().then(() => {
  setupInterceptors(session.defaultSession, { getStreamHostname });
  registerIpc();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { width, height, x, y } = mainWindow.getBounds();
    store.set('windowBounds', { width, height, x, y });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray when close-to-tray is on
    if (!store.get('closeToTray', true)) {
      app.quit();
    }
  }
});
