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
const { handlers, setupInterceptors, CHROME_UA } = require('./ipc-handlers');
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
const {
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
  setLogPath,
} = require('./discord-rpc');

// Must run before userData / store is touched.
configurePortableUserData();

// Discord RPC / native pipes can emit errors that would otherwise kill Electron.
process.on('uncaughtException', (err) => {
  console.error('[kstream-desktop] uncaughtException (kept alive):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error(
    '[kstream-desktop] unhandledRejection (kept alive):',
    reason?.message || reason,
  );
});

// Look like Chrome, not Electron — many CDNs/WAFs block Electron UAs.
app.userAgentFallback = CHROME_UA;

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

  try {
    mainWindow.webContents.setUserAgent(CHROME_UA);
  } catch (_) {
    // ignore
  }

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    // X button (and Alt+F4): pause playback. Minimize does not hit this path.
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('kstream:pause-for-close');
      }
    } catch (err) {
      console.warn('[kstream-desktop] pause-for-close send failed', err);
    }

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
  startDiscordPresence(app.getPath('userData'));
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

let lastMediaBody = null;
/** @type {Map<string, { releaseDate?: string, releaseYear?: number }>} */
const releaseDateCache = new Map();

function registerIpc() {
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, (_event, body) => handler(body));
  });

  ipcMain.handle('updateMediaMetadata', async (_event, body) => {
    const enriched = await enrichPresenceFromVideo(body || null);
    lastMediaBody = enriched;
    console.log(
      '[kstream-desktop] updateMediaMetadata',
      enriched && enriched.clear
        ? 'clear'
        : enriched?.idle
          ? 'idle'
          : `${enriched?.title || '(empty)'} S${enriched?.seasonNumber || '-'}E${enriched?.episodeNumber || '-'} date=${enriched?.releaseDate || enriched?.releaseYear || '-'}`,
    );
    return updateDiscordPresence(enriched);
  });
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

/**
 * Live site can lag behind desktop. Read <video> + window.meta, and if the
 * month is missing, resolve release_date from TMDB in the page context.
 */
async function enrichPresenceFromVideo(body) {
  if (!body || body.idle || body.clear) return body;
  if (!mainWindow || mainWindow.isDestroyed()) return body;

  try {
    const info = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const v = document.querySelector('video');
        const meta = window.meta && window.meta.player && window.meta.player.meta;
        const duration = v ? Number(v.duration) : NaN;
        const currentTime = v ? Number(v.currentTime) : NaN;
        return {
          hasVideo: Boolean(v),
          durationSec:
            Number.isFinite(duration) && duration > 0 && duration !== Infinity
              ? duration
              : 0,
          currentTime: Number.isFinite(currentTime)
            ? Math.max(0, currentTime)
            : 0,
          paused: v ? Boolean(v.paused) : null,
          tmdbId: meta && meta.tmdbId ? String(meta.tmdbId) : null,
          mediaType: meta && meta.type === 'show' ? 'show' : 'movie',
          releaseYear:
            meta && typeof meta.year === 'number' && meta.year > 0
              ? meta.year
              : null,
          releaseDate:
            meta && typeof meta.releaseDate === 'string' && meta.releaseDate
              ? meta.releaseDate
              : null,
          seasonNumber:
            window.meta &&
            window.meta.player &&
            window.meta.player.season &&
            window.meta.player.season.number
              ? window.meta.player.season.number
              : null,
          episodeNumber:
            window.meta &&
            window.meta.player &&
            window.meta.player.episode &&
            window.meta.player.episode.number
              ? window.meta.player.episode.number
              : null,
        };
      })()`,
      true,
    );
    if (!info) return body;

    const next = { ...body };
    if (typeof info.paused === 'boolean') {
      next.isPaused = info.paused;
    }
    if (info.releaseDate) next.releaseDate = info.releaseDate;
    if (info.releaseYear) next.releaseYear = info.releaseYear;
    if (info.seasonNumber) next.seasonNumber = info.seasonNumber;
    if (info.episodeNumber) next.episodeNumber = info.episodeNumber;

    // Fill month+year from TMDB for movies when the web build only has a year
    const isShow =
      Number(next.seasonNumber) > 0 && Number(next.episodeNumber) > 0;
    const needsMonth =
      !isShow &&
      (!next.releaseDate || !/^\d{4}-\d{2}/.test(String(next.releaseDate)));
    if (needsMonth && info.tmdbId) {
      const cached = releaseDateCache.get(info.tmdbId);
      if (cached?.releaseDate) {
        next.releaseDate = cached.releaseDate;
        if (cached.releaseYear) next.releaseYear = cached.releaseYear;
      } else {
        const fetched = await fetchReleaseDateFromPage(
          info.tmdbId,
          info.mediaType,
        );
        if (fetched?.releaseDate) {
          releaseDateCache.set(info.tmdbId, fetched);
          next.releaseDate = fetched.releaseDate;
          if (fetched.releaseYear) next.releaseYear = fetched.releaseYear;
        }
      }
    }

    return next;
  } catch (err) {
    console.warn(
      '[kstream-desktop] video enrich failed',
      err?.message || err,
    );
    return body;
  }
}

/** Resolve YYYY-MM-DD from TMDB inside the loaded site (uses its existing key). */
async function fetchReleaseDateFromPage(tmdbId, mediaType) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const kind = mediaType === 'show' ? 'tv' : 'movie';
  try {
    const result = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        const id = ${JSON.stringify(String(tmdbId))};
        const kind = ${JSON.stringify(kind)};
        let token =
          (window.__CONFIG__ && window.__CONFIG__.VITE_TMDB_READ_API_KEY) || '';
        if (!token) {
          const script = [...document.querySelectorAll('script[src]')].find(
            (s) => /\\/assets\\/index-/.test(s.src),
          );
          if (script) {
            const text = await fetch(script.src).then((r) => r.text());
            const m = text.match(/TMDB_READ_API_KEY:"(eyJ[^"]+)"/);
            if (m) token = m[1];
          }
        }
        if (!token) return null;
        const res = await fetch(
          'https://api.themoviedb.org/3/' + kind + '/' + id,
          {
            headers: {
              Authorization: 'Bearer ' + token,
              Accept: 'application/json',
            },
          },
        );
        if (!res.ok) return null;
        const data = await res.json();
        const releaseDate = data.release_date || data.first_air_date || null;
        if (!releaseDate) return null;
        const year = Number(String(releaseDate).slice(0, 4));
        return {
          releaseDate: String(releaseDate).slice(0, 10),
          releaseYear: Number.isFinite(year) && year > 0 ? year : null,
        };
      })()`,
      true,
    );
    return result;
  } catch (err) {
    console.warn(
      '[kstream-desktop] TMDB release date fetch failed',
      err?.message || err,
    );
    return null;
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[kstream-desktop] skipping auto-updater in dev');
    return;
  }

  // Never auto-install without asking — avoids surprise relaunches.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    console.log('[kstream-desktop] update available', info.version);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update available',
        message: `kstream ${info.version} is available.`,
        detail: 'Download and install now?',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate().catch((err) => {
            console.warn('[kstream-desktop] update download failed', err);
          });
        }
      })
      .catch(() => {});
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[kstream-desktop] update downloaded', info.version);
    if (!mainWindow || mainWindow.isDestroyed()) return;
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
      })
      .catch(() => {});
  });

  autoUpdater.on('error', (err) => {
    console.warn('[kstream-desktop] updater error', err?.message || err);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[kstream-desktop] update check failed', err?.message || err);
    });
  }, 15000);
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
      startDiscordPresence(app.getPath('userData'));
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
  shutdownDiscordPresence();
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
