'use strict';

const { app, shell } = require('electron');

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

function attachAuthNavigationGuards(webContents) {
  webContents.on('will-navigate', (event, url) => {
    if (!shouldOpenAuthExternally(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
    if (mainWebContents && webContents !== mainWebContents && !webContents.isDestroyed()) {
      webContents.close();
    }
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
