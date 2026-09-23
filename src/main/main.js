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
const fs = require('fs');
const path = require('path');
const { handlers, setupInterceptors, CHROME_UA } = require('./ipc-handlers');
const {
  setupBackgroundCheck,
  hasPendingApplyForCurrentVersion,
  checkDesktopUpdateAtStartup,
  applyDesktopUpdate,
  checkDesktopUpdate,
  getDesktopUpdateStatus,
  attachInstallerDownloadHandler,
  isKstreamSetupDownload,
} = require('./app-updater');
const SimpleStore = require('./storage');
const {
  configurePortableUserData,
  needsSetup,
  writePortableMarker,
  installToAppData,
  launchInstalledAndExit,
  getSetupInfo,
  getInstallDir,
  hasPortableMarker,
  resolveBrandIconPaths,
  ensureInstalledBranding,
  uninstallInstalled,
  isRunningFromInstallDir,
} = require('./install');
const {
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
  setPresenceSuspended,
  setLogPath,
} = require('./discord-rpc');
const { resolveWebRoot, startLocalServer } = require('./local-server');
const { migrateGuestLocalStorage } = require('./origin-migrate');
const { runNetworkCheck } = require('./network-check');
const {
  registerAuthProtocol,
  captureStartupAuthCallback,
  extractProtocolUrl,
  deliverAuthCallback,
  flushPendingAuthCallback,
  attachAuthNavigationGuards,
  installGlobalAuthGuards,
  setMainWebContents,
  normalizeDesktopOAuthUrl,
} = require('./auth-protocol');
const {
  initTmdbCache,
  getTmdbCacheEntry,
  setTmdbCacheEntry,
  getTmdbCacheStats,
} = require('./tmdb-cache');
const {
  initMangaOffline,
  downloadMangaChapter,
  getOfflineChapterPages,
  hasOfflineChapter,
} = require('./manga-offline');

const TITLE_BAR_OPTIONS = process.platform === 'win32'
  ? {
      frame: false,
    }
  : {
      titleBarStyle: 'hiddenInset',
    };

const DESKTOP_CHROME_CSS = `
  html,
  body {
    overflow-y: auto !important;
    scrollbar-width: none !important;
  }

  html::-webkit-scrollbar,
  body::-webkit-scrollbar,
  *::-webkit-scrollbar {
    width: 0 !important;
    height: 0 !important;
  }

  html::before {
    content: "";
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 32px;
    -webkit-app-region: drag;
    z-index: 1;
    pointer-events: none;
  }

`;

const DESKTOP_CHROME_JS = `void 0;`;
const {
  initVideoOffline,
  startVideoDownload,
  listDownloads,
  readMeta,
  getPlaybackUrl,
  deleteDownload,
} = require('./video-offline');

// Must run before userData / store is touched.
configurePortableUserData();
app.setName('kstream');
app.setAppUserModelId('com.kdesafx.kstream');

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

// Throttle timers/composites when the window is occluded or in the tray.
app.commandLine.appendSwitch(
  'enable-features',
  'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
);

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const SETUP_PRELOAD = path.join(__dirname, '..', 'preload', 'setup-preload.js');
const WELCOME_HTML = path.join(__dirname, '..', 'renderer', 'welcome', 'index.html');

// Remote fallback for dev when no bundled web UI is present.
// Packaged builds always use bundled local UI — KSTREAM_URL is dev-only.
const REMOTE_STREAM_URL = 'https://kdesa.stream';
const ENV_STREAM_URL = app.isPackaged ? null : process.env.KSTREAM_URL || null;
const LEGACY_STREAM_HOSTS = new Set([
  'kstream.lol',
  'www.kstream.lol',
  'kstream-one.vercel.app',
  'www.kdesa.stream',
  'kdesa.stream',
]);

const store = new SimpleStore({
  configName: 'user-preferences',
  defaults: {
    windowBounds: { width: 1280, height: 800 },
    windowMaximized: true,
    streamUrl: REMOTE_STREAM_URL,
    localUiPort: 18765,
    closeToTray: true,
    runMode: null,
  },
});

let mainWindow = null;
let tray = null;
let isQuitting = false;
let showingSetup = false;
let idleTrimTimer = null;
/** @type {{ origin: string, close: () => Promise<void> } | null} */
let localServer = null;
let defaultStreamUrl = ENV_STREAM_URL || REMOTE_STREAM_URL;
/** Origins to copy guest localStorage from after the first UI load. */
let pendingStorageOrigins = [];
let guestStorageInjected = false;

function isLocalOriginUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

function isUsingBundledUi() {
  return Boolean(localServer && isLocalOriginUrl(getStreamUrl()));
}

/**
 * Prefer bundled local UI when available. KSTREAM_URL always wins.
 * Migrate users off legacy remotes (and the old kdesa.stream default) onto local.
 */
function migrateStreamUrl() {
  if (ENV_STREAM_URL) {
    store.set('streamUrl', ENV_STREAM_URL);
    return;
  }

  // Packaged builds always load the bundled SPA from 127.0.0.1.
  if (localServer) {
    store.set('streamUrl', localServer.origin);
    return;
  }

  const preferred = defaultStreamUrl;
  const current = store.get('streamUrl', preferred);
  if (!current || typeof current !== 'string') {
    store.set('streamUrl', preferred);
    return;
  }

  try {
    const host = new URL(current).hostname.toLowerCase();
    const shouldMigrate =
      LEGACY_STREAM_HOSTS.has(host) ||
      (localServer && isLocalOriginUrl(preferred) && !isLocalOriginUrl(current));
    // Keep an existing local URL if the port matches a previous run — otherwise
    // refresh to the new ephemeral port from this session.
    if (localServer && isLocalOriginUrl(current)) {
      store.set('streamUrl', preferred);
      return;
    }
    if (shouldMigrate) {
      store.set('streamUrl', preferred);
    }
  } catch {
    store.set('streamUrl', preferred);
  }
}

function getRunModeLabel() {
  const mode = store.get('runMode', null);
  let base = 'unknown';
  if (mode === 'installed' || mode === 'portable') base = mode;
  else if (isRunningFromInstallDir()) base = 'installed';
  else if (hasPortableMarker()) base = 'portable';
  if (isUsingBundledUi()) {
    return base === 'unknown' ? 'bundled' : `${base}+bundled`;
  }
  return base;
}

function getStreamUrl() {
  return store.get('streamUrl', defaultStreamUrl) || defaultStreamUrl;
}

function getStreamHostname() {
  try {
    return new URL(getStreamUrl()).hostname;
  } catch {
    return null;
  }
}

async function quitMissingBundledWeb(reason) {
  const detail =
    reason ||
    'This installer should include a local copy of kstream. Reinstall from kdesa.stream or the latest GitHub release.';
  await dialog.showMessageBox({
    type: 'error',
    title: 'kstream',
    message: 'Bundled UI is missing',
    detail,
    buttons: ['Quit'],
    defaultId: 0,
    noLink: true,
  });
  app.quit();
}

async function ensureLocalServer() {
  if (ENV_STREAM_URL) {
    console.log('[kstream-desktop] KSTREAM_URL set — skipping bundled local server');
    return null;
  }
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    if (app.isPackaged) {
      await quitMissingBundledWeb();
      return null;
    }
    console.log('[kstream-desktop] no bundled web UI — using', REMOTE_STREAM_URL);
    return null;
  }
  if (localServer) return localServer;
  const previousUrl = store.get('streamUrl', '');
  const preferredPort = Number(store.get('localUiPort', 18765)) || 18765;
  localServer = await startLocalServer({ webRoot, preferredPort });
  store.set('localUiPort', localServer.port);
  defaultStreamUrl = localServer.origin;
  pendingStorageOrigins = [
    previousUrl,
    REMOTE_STREAM_URL,
    'https://www.kdesa.stream',
    'https://kstream.lol',
  ];
  return localServer;
}

function createTray(win) {
  if (tray) return tray;

  const { any: iconPath } = resolveBrandIconPaths();
  let image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
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
        checkDesktopUpdate().catch((err) => {
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

  const { any: iconPath } = resolveBrandIconPaths();

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
    ...TITLE_BAR_OPTIONS,
    icon: iconPath || undefined,
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
    mainWindow.webContents.insertCSS(DESKTOP_CHROME_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(DESKTOP_CHROME_JS).catch(() => {});
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

function syncWindowIdleState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let hidden = false;
  let minimized = false;
  try {
    hidden = !mainWindow.isVisible();
    minimized = mainWindow.isMinimized();
  } catch {
    return;
  }
  const idle = hidden || minimized;
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch {
    // ignore
  }
  try {
    mainWindow.webContents.send('kstream:window-idle', {
      idle,
      hidden,
      minimized,
    });
  } catch (err) {
    console.warn('[kstream-desktop] window-idle send failed', err);
  }
  try {
    setPresenceSuspended(hidden);
  } catch {
    // ignore
  }
  if (idleTrimTimer) {
    clearTimeout(idleTrimTimer);
    idleTrimTimer = null;
  }
  if (!hidden) return;
  idleTrimTimer = setTimeout(() => {
    idleTrimTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    try {
      mainWindow.webContents.invalidate();
    } catch {
      // ignore
    }
  }, 8000);
}

function createMainWindow() {
  showingSetup = false;
  const bounds = store.get('windowBounds', { width: 1280, height: 800 });
  const { any: iconPath } = resolveBrandIconPaths();

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
    ...TITLE_BAR_OPTIONS,
    icon: iconPath || undefined,
    title: 'kstream',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  try {
    mainWindow.webContents.setUserAgent(CHROME_UA);
  } catch (_) {
    // ignore
  }

  mainWindow.setMenuBarVisibility(false);

  // The desktop app should always occupy the full work area on launch.
  mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('minimize', () => syncWindowIdleState());
  mainWindow.on('restore', () => syncWindowIdleState());
  mainWindow.on('maximize', () => store.set('windowMaximized', true));
  mainWindow.on('unmaximize', () => store.set('windowMaximized', false));
  mainWindow.on('hide', () => syncWindowIdleState());
  mainWindow.on('show', () => syncWindowIdleState());
  mainWindow.on('focus', () => {
    try {
      mainWindow.webContents.invalidate();
    } catch {
      // ignore
    }
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
      syncWindowIdleState();
    } else {
      store.set('windowMaximized', mainWindow.isMaximized());
      if (!mainWindow.isMaximized()) {
        const { width, height, x, y } = mainWindow.getBounds();
        store.set('windowBounds', { width, height, x, y });
      }
    }
  });

  attachAuthNavigationGuards(mainWindow.webContents);
  setMainWebContents(mainWindow.webContents);

  mainWindow.on('closed', () => {
    setMainWebContents(null);
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(DESKTOP_CHROME_CSS).catch(() => {});
    mainWindow.webContents.executeJavaScript(DESKTOP_CHROME_JS).catch(() => {});
    flushPendingAuthCallback(mainWindow);
    if (guestStorageInjected || showingSetup) return;
    guestStorageInjected = true;
    const current = getStreamUrl();
    void migrateGuestLocalStorage(mainWindow, pendingStorageOrigins, current)
      .then((wrote) => {
        if (wrote > 0 && mainWindow && !mainWindow.isDestroyed()) {
          console.log('[kstream-desktop] restored', wrote, 'guest settings keys');
          mainWindow.reload();
        }
      })
      .catch((err) => {
        console.warn('[kstream-desktop] guest storage migrate failed', err?.message || err);
      });
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

function createUpdateWaitWindow() {
  const logoDataUri = getBundledLogoDataUri();
  const waitWindow = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#20242b',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  waitWindow.once('ready-to-show', () => waitWindow.show());
  waitWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#20242b;color:#f5f7fa;font:600 15px Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;text-align:center}
      main{width:100%;padding:28px}.logo{width:46px;height:46px;display:block;object-fit:contain;margin:0 auto 14px}.mark{width:38px;height:38px;margin:0 auto 16px;border:4px solid #46505d;border-top-color:#28c7b7;border-radius:50%;animation:spin 1s linear infinite}.title{font-size:16px}.detail{font-size:12px;font-weight:400;color:#aeb6c2;margin-top:9px}@keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><main>${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="kstream">` : ''}<div class="mark"></div><div class="title">Updating kstream...</div><div class="detail">Please wait while the update finishes.</div></main></body></html>
  `)}`);
  setTimeout(() => {
    if (!waitWindow.isDestroyed()) waitWindow.close();
    app.quit();
  }, 10000);
}

function getBundledLogoDataUri() {
  const candidates = [
    path.join(process.resourcesPath, 'logo.png'),
    path.join(app.getAppPath(), 'logo.png'),
    path.join(__dirname, '..', '..', 'logo.png'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return `data:image/png;base64,${fs.readFileSync(candidate).toString('base64')}`;
      }
    } catch (error) {
      console.warn('[kstream-desktop] unable to read bundled logo', candidate, error.message);
    }
  }

  return '';
}

function createStartupWindow() {
  const logoDataUri = getBundledLogoDataUri();
  const startupWindow = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#20242b',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  startupWindow.once('ready-to-show', () => startupWindow.show());
  startupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#091313;color:#f7fbfa;font:500 14px Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;text-align:center}
      main{width:100%;padding:25px 28px 23px}.logo{width:48px;height:48px;display:block;object-fit:contain;margin:0 auto 18px}.spinner{width:38px;height:38px;margin:0 auto 16px;border:3px solid #263e3d;border-top-color:#62e3d4;border-right-color:#27b9aa;border-radius:50%;animation:spin 850ms linear infinite}.title{font-size:15px;font-weight:650}.detail{font-size:12px;color:#8ea6a3;margin-top:8px}@keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><main>${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="kstream">` : ''}<div class="spinner"></div><div class="title">Getting things ready</div><div class="detail">Checking for updates</div></main></body></html>
  `)}`);
  return startupWindow;
}

function closeStartupWindow(startupWindow) {
  if (!startupWindow || startupWindow.isDestroyed()) return;
  try {
    startupWindow.hide();
    startupWindow.destroy();
  } catch {
    // The window may already be closing during app startup.
  }
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

  ipcMain.handle('getDesktopAppInfo', async () => ({
    streamUrl: getStreamUrl(),
    runMode: getRunModeLabel(),
    originMode: isUsingBundledUi() ? 'bundled' : 'remote',
    installDir: getInstallDir(),
    version: app.getVersion(),
    tmdbCache: getTmdbCacheStats(),
  }));

  ipcMain.handle('installDesktopUpdate', async (_event, body) =>
    applyDesktopUpdate(() => {
      isQuitting = true;
    }, body || {}),
  );
  ipcMain.handle('applyDesktopUpdate', async (_event, body) =>
    applyDesktopUpdate(() => {
      isQuitting = true;
    }, body || {}),
  );
  ipcMain.handle('checkDesktopUpdate', async (_event, body) =>
    checkDesktopUpdate(body || {}),
  );
  ipcMain.handle('getDesktopUpdateStatus', async () => getDesktopUpdateStatus());
  ipcMain.handle('windowControl:minimize', async (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
    return { ok: true };
  });
  ipcMain.handle('windowControl:toggleMaximize', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { ok: false };
    if (window.isMaximized()) {
      window.unmaximize();
    } else if (window.isMaximizable()) {
      window.maximize();
    }
    return { ok: true };
  });
  ipcMain.handle('windowControl:close', async (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
    return { ok: true };
  });

  ipcMain.handle('tmdbCacheGet', async (_event, body) => {
    const key = body?.key;
    if (!key?.url) return null;
    return getTmdbCacheEntry(key, { allowStale: Boolean(body?.allowStale) });
  });

  ipcMain.handle('tmdbCacheSet', async (_event, body) => {
    const key = body?.key;
    if (!key?.url || body?.value == null) return { ok: false };
    setTmdbCacheEntry(key, body.value, body.ttlSec);
    return { ok: true };
  });

  ipcMain.handle('mangaOfflineDownload', async (_event, body) =>
    downloadMangaChapter(body),
  );

  ipcMain.handle('mangaOfflineGetPages', async (_event, body) => {
    const chapterId = body?.chapterId;
    if (!chapterId) return null;
    const origin =
      localServer?.origin ||
      (isLocalOriginUrl(getStreamUrl()) ? getStreamUrl() : null);
    if (!origin) return null;
    return getOfflineChapterPages(chapterId, origin);
  });

  ipcMain.handle('mangaOfflineHas', async (_event, body) =>
    hasOfflineChapter(body?.chapterId),
  );

  ipcMain.handle('videoOfflineStart', async (_event, body) => startVideoDownload(body));

  ipcMain.handle('videoOfflineList', async () => {
    const origin =
      localServer?.origin ||
      (isLocalOriginUrl(getStreamUrl()) ? getStreamUrl() : null);
    const items = listDownloads().map((meta) => ({
      ...meta,
      playbackUrl:
        meta.status === 'ready' && origin ? getPlaybackUrl(meta.id, origin) : null,
    }));
    return { items };
  });

  ipcMain.handle('videoOfflineDelete', async (_event, body) =>
    deleteDownload(body?.id),
  );

  ipcMain.handle('openOfflineApp', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kstream:open-offline');
    }
    return { success: true };
  });

  ipcMain.handle('openExternalAuth', async (_event, body) => {
    const url = body?.url;
    if (!url || typeof url !== 'string') {
      throw new Error('Missing OAuth URL');
    }
    if (isKstreamSetupDownload('', url)) {
      return checkDesktopUpdate();
    }
    await shell.openExternal(normalizeDesktopOAuthUrl(url));
    return { ok: true };
  });

  ipcMain.handle('runNetworkCheck', async () =>
    runNetworkCheck({
      localOrigin: localServer?.origin || (isLocalOriginUrl(getStreamUrl()) ? getStreamUrl() : null),
    }),
  );
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
  setupBackgroundCheck(
    () => mainWindow,
    () => {
      isQuitting = true;
    },
  );
}

const gotLock = app.requestSingleInstanceLock();
registerAuthProtocol();
installGlobalAuthGuards();
captureStartupAuthCallback(process.argv);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const authUrl = extractProtocolUrl(commandLine);
    if (authUrl) deliverAuthCallback(mainWindow, authUrl);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.argv.includes('--uninstall')) {
      await uninstallInstalled(process.argv.includes('--quiet'));
      return;
    }

    initTmdbCache(app.getPath('userData'));
    initMangaOffline(app.getPath('userData'));
    initVideoOffline(app.getPath('userData'));

    try {
      await ensureLocalServer();
    } catch (err) {
      const message = err?.message || String(err);
      console.error('[kstream-desktop] local server failed', message);
      if (app.isPackaged) {
        dialog.showErrorBox(
          'kstream failed to start',
          `Could not start the local UI server.\n\n${message}\n\nReinstall the app or restart your computer.`,
        );
        app.quit();
        return;
      }
      defaultStreamUrl = ENV_STREAM_URL || REMOTE_STREAM_URL;
    }
    if (app.isPackaged && !localServer) {
      return;
    }
    migrateStreamUrl();

    setupInterceptors(session.defaultSession, { getStreamHostname });
    attachInstallerDownloadHandler(session.defaultSession, () => {
      isQuitting = true;
    });
    registerIpc();
    registerSetupIpc();

    if (isRunningFromInstallDir()) {
      ensureInstalledBranding();
    }

    if (hasPendingApplyForCurrentVersion()) {
      createUpdateWaitWindow();
    } else if (needsSetup(store)) {
      createSetupWindow();
    } else {
      const startupWindow = app.isPackaged ? createStartupWindow() : null;
      const startupStatus = app.isPackaged
        ? await checkDesktopUpdateAtStartup(5_000)
        : null;
      if (startupStatus?.phase === 'ready') {
        closeStartupWindow(startupWindow);
        await applyDesktopUpdate(() => {
          isQuitting = true;
        }, { userInitiated: true });
        return;
      }
      closeStartupWindow(startupWindow);
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
  if (localServer) {
    localServer.close().catch(() => {});
    localServer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed() && !showingSetup) {
    store.set('windowMaximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized()) {
      const { width, height, x, y } = mainWindow.getBounds();
      store.set('windowBounds', { width, height, x, y });
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (showingSetup || !store.get('closeToTray', true)) {
      app.quit();
    }
  }
});
