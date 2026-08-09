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
const {
  configurePortableUserData,
  needsSetup,
  writePortableMarker,
  installToAppData,
  launchInstalledAndExit,
  getSetupInfo,
  getInstallDir,
} = require('./install');

// Must run before userData / store is touched.
configurePortableUserData();

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const SETUP_PRELOAD = path.join(__dirname, '..', 'preload', 'setup-preload.js');
const WELCOME_HTML = path.join(__dirname, '..', 'renderer', 'welcome', 'index.html');

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
    runMode: null,
  },
});

let mainWindow = null;
let tray = null;
let isQuitting = false;
let showingSetup = false;

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
  if (tray) return tray;

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

  return tray;
}

function createSetupWindow() {
  showingSetup = true;

  const { width: workW, height: workH } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(520, Math.max(420, workW - 80));
  const height = Math.min(680, Math.max(560, workH - 80));

  mainWindow = new BrowserWindow({
    width,
    height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#030303',
    icon: path.join(ROOT, 'logo.png'),
    title: 'kstream',
    webPreferences: {
      preload: SETUP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      zoomFactor: 1,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.webContents.setZoomFactor(1);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (showingSetup && !isQuitting) {
      // Closed setup without choosing — exit
      app.quit();
    }
  });

  mainWindow.loadFile(WELCOME_HTML);
  return mainWindow;
}

function createMainWindow() {
  showingSetup = false;
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

function openAppAfterSetup() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showingSetup = false;
    mainWindow.removeAllListeners('closed');
    mainWindow.close();
    mainWindow = null;
  }
  createMainWindow();
  setupAutoUpdater();
}

function registerSetupIpc() {
  ipcMain.handle('setup:getInfo', async () => {
    const info = getSetupInfo();
    return {
      ...info,
      installDirShort: 'appdata\\programs\\kstream',
    };
  });

  ipcMain.handle('setup:install', async () => {
    try {
      const result = await installToAppData();
      store.set('runMode', 'installed');

      if (result.dev) {
        openAppAfterSetup();
        return result;
      }

      isQuitting = true;
      launchInstalledAndExit(result.exePath);
      return result;
    } catch (err) {
      console.error('[kstream-desktop] install failed', err);
      throw new Error(err.message || 'Install failed');
    }
  });

  ipcMain.handle('setup:portable', async () => {
    try {
      writePortableMarker();
      store.set('runMode', 'portable');
      openAppAfterSetup();
      return { ok: true };
    } catch (err) {
      console.error('[kstream-desktop] portable setup failed', err);
      throw new Error(err.message || 'Portable setup failed');
    }
  });
}

function registerIpc() {
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, (_event, body) => handler(body));
  });

  ipcMain.handle('updateMediaMetadata', async () => ({ success: true }));
  ipcMain.handle('openOfflineApp', async () => ({ success: true }));

  ipcMain.on('open-settings', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'kstream',
      message: 'App settings',
      detail:
        'Core loads your kstream site with native scraping.\n\n' +
        `URL: ${getStreamUrl()}\n` +
        `Mode: ${store.get('runMode', 'unknown')}\n` +
        `Install folder: ${getInstallDir()}\n\n` +
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
    setupInterceptors(session.defaultSession, { getStreamHostname });
    registerIpc();
    registerSetupIpc();

    if (needsSetup(store)) {
      createSetupWindow();
    } else {
      createMainWindow();
      setupAutoUpdater();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (needsSetup(store)) createSetupWindow();
        else createMainWindow();
      } else if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed() && !showingSetup) {
    const { width, height, x, y } = mainWindow.getBounds();
    store.set('windowBounds', { width, height, x, y });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (showingSetup || !store.get('closeToTray', true)) {
      app.quit();
    }
  }
});
