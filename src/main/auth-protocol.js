'use strict';

const { app, shell, BrowserWindow } = require('electron');

const AUTH_PROTOCOL = 'kstream';
const AUTH_CALLBACK_PREFIX = `${AUTH_PROTOCOL}://auth/callback`;

const EXTERNAL_AUTH_HOSTS = [
  'accounts.google.com',
  'google.com',
  'discord.com',
  'discordapp.com',
  'supabase.co',
];

/** @type {string | null} */
let pendingAuthCallbackUrl = null;

/** @type {import('electron').WebContents | null} */
let mainWebContents = null;

function setMainWebContents(webContents) {
  mainWebContents = webContents;
}

function isAuthCallbackUrl(url) {
  return typeof url === 'string' && url.startsWith(AUTH_CALLBACK_PREFIX);
}

function extractProtocolUrl(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${AUTH_PROTOCOL}://`)) || null;
}

function shouldOpenAuthExternally(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EXTERNAL_AUTH_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

function registerAuthProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
        require('path').resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
  }
}

/**
 * @param {import('electron').BrowserWindow | null} mainWindow
 */
function deliverAuthCallback(mainWindow, url) {
  if (!isAuthCallbackUrl(url)) return;
  console.log('[kstream-desktop] OAuth callback received');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kstream:auth-callback', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    pendingAuthCallbackUrl = null;
    return;
  }
  pendingAuthCallbackUrl = url;
}

function flushPendingAuthCallback(mainWindow) {
  if (!pendingAuthCallbackUrl || !mainWindow || mainWindow.isDestroyed()) return;
  deliverAuthCallback(mainWindow, pendingAuthCallbackUrl);
}

function captureStartupAuthCallback(argv) {
  const url = extractProtocolUrl(argv);
  if (url) pendingAuthCallbackUrl = url;
}

function closeOAuthChildWindow(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  if (mainWebContents && webContents.id === mainWebContents.id) return;
  try {
    const child = BrowserWindow.fromWebContents(webContents);
    if (child && !child.isDestroyed()) child.close();
  } catch {
    // ignore
  }
}

function routeOAuthExternally(event, url, webContents) {
  if (!shouldOpenAuthExternally(url)) return false;
  if (event?.preventDefault) event.preventDefault();
  void shell.openExternal(url);
  closeOAuthChildWindow(webContents);
  return true;
}

function attachAuthNavigationGuards(webContents) {
  webContents.on('will-navigate', (event, url) => {
    routeOAuthExternally(event, url, webContents);
  });

  // Supabase → Google/Discord often redirects in-place; will-navigate alone
  // misses that hop and leaves OAuth trapped inside an Electron window.
  webContents.on('will-redirect', (event, url) => {
    routeOAuthExternally(event, url, webContents);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenAuthExternally(url) || !url.startsWith('http')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function installGlobalAuthGuards() {
  app.on('web-contents-created', (_event, webContents) => {
    attachAuthNavigationGuards(webContents);
  });
}

module.exports = {
  AUTH_CALLBACK_PREFIX,
  registerAuthProtocol,
  captureStartupAuthCallback,
  extractProtocolUrl,
  deliverAuthCallback,
  flushPendingAuthCallback,
  attachAuthNavigationGuards,
  installGlobalAuthGuards,
  setMainWebContents,
  isAuthCallbackUrl,
};
