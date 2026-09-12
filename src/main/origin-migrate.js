'use strict';

const http = require('http');
const { BrowserWindow } = require('electron');

const DUMP_JS = `(() => {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      out[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return out;
})()`;

function isLocalOrigin(url) {
  try {
    const u = new URL(url);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

function listenDummy(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body></body></html>');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function dumpOriginLocalStorage(origin) {
  let dummy = null;
  let win = null;
  try {
    const parsed = new URL(origin);
    if (isLocalOrigin(origin)) {
      try {
        dummy = await listenDummy(Number(parsed.port) || 80);
      } catch {
        // Old port still in use — skip dummy; loadURL may still work.
      }
    }
    win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    await win.loadURL(parsed.origin + '/', { extraHeaders: 'pragma: no-cache\n' });
    const dump = await win.webContents.executeJavaScript(DUMP_JS, true);
    return dump && typeof dump === 'object' ? dump : {};
  } catch (err) {
    console.warn('[kstream-desktop] storage dump failed', origin, err?.message || err);
    return {};
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (dummy) {
      await new Promise((resolve) => dummy.close(() => resolve()));
    }
  }
}

async function injectLocalStorage(win, dump) {
  if (!win || win.isDestroyed() || !dump || typeof dump !== 'object') return 0;
  const payload = JSON.stringify(dump);
  const wrote = await win.webContents.executeJavaScript(
    `(() => {
      const data = ${payload};
      let n = 0;
      for (const [key, value] of Object.entries(data)) {
        if (typeof key !== 'string' || typeof value !== 'string') continue;
        if (localStorage.getItem(key) !== null) continue;
        localStorage.setItem(key, value);
        n += 1;
      }
      return n;
    })()`,
    true,
  );
  return Number(wrote) || 0;
}

/**
 * Copy guest localStorage (settings, continue watching, theme) from previous
 * origins onto the current UI origin. Chromium keys storage by origin, so a
 * new 127.0.0.1 port looks like a blank profile after an update.
 */
async function migrateGuestLocalStorage(win, fromOrigins, currentOrigin) {
  if (!win || win.isDestroyed()) return 0;
  const seen = new Set();
  let merged = {};
  for (const raw of fromOrigins || []) {
    if (!raw || typeof raw !== 'string') continue;
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    if (!origin || origin === currentOrigin || seen.has(origin)) continue;
    seen.add(origin);
    const dump = await dumpOriginLocalStorage(origin);
    merged = { ...dump, ...merged };
  }
  const keys = Object.keys(merged);
  if (!keys.length) return 0;
  return injectLocalStorage(win, merged);
}

module.exports = {
  migrateGuestLocalStorage,
};
