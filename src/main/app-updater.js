'use strict';

const { app, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SETUP_URLS = [
  'https://kdesa.stream/download/kstream-Setup.exe',
  'https://github.com/kdesaFX/kstream-desktop/releases/latest/download/kstream-Setup.exe',
];

let configured = false;
let pendingDownload = null;

function configureAutoUpdater() {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.verifyUpdateCodeSignature = false;

  autoUpdater.on('error', (err) => {
    console.warn('[kstream-desktop] updater error', err?.message || err);
  });
}

function setupBackgroundCheck() {
  if (!app.isPackaged) {
    console.log('[kstream-desktop] skipping auto-updater in dev');
    return;
  }

  configureAutoUpdater();

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[kstream-desktop] update check failed', err?.message || err);
    });
  }, 15000);
}

function waitForEvent(eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      autoUpdater.removeListener(eventName, onEvent);
      autoUpdater.removeListener('error', onError);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      autoUpdater.removeListener(eventName, onEvent);
      autoUpdater.removeListener('error', onError);
    };

    function onEvent(info) {
      cleanup();
      resolve(info);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    autoUpdater.once(eventName, onEvent);
    autoUpdater.once('error', onError);
  });
}

function setupDestPath() {
  return path.join(app.getPath('temp'), 'kstream-Setup.exe');
}

async function downloadLatestSetup() {
  const dest = setupDestPath();
  let lastError = new Error('Could not download updater');
  for (const url of SETUP_URLS) {
    try {
      const res = await net.fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        lastError = new Error(`Could not download updater (${res.status})`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) {
        lastError = new Error('Updater download looks incomplete');
        continue;
      }
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}

function launchSetupAndQuit(exePath, setQuitting) {
  setQuitting();
  const child = spawn(exePath, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  app.quit();
}

function isKstreamSetupDownload(filename, url) {
  const name = String(filename || '').toLowerCase();
  const href = String(url || '').toLowerCase();
  return name.includes('kstream-setup') || href.includes('kstream-setup.exe');
}

function attachInstallerDownloadHandler(sess, setQuitting) {
  if (!sess || sess.__kstreamSetupDownloadHook) return;
  sess.__kstreamSetupDownloadHook = true;
  sess.on('will-download', (_event, item) => {
    if (!isKstreamSetupDownload(item.getFilename(), item.getURL())) return;
    const dest = setupDestPath();
    item.setSavePath(dest);
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        launchSetupAndQuit(dest, setQuitting);
      }
    });
  });
}

/**
 * User clicked Update in the web UI.
 * Prefer electron-updater (NSIS). Portable / missing latest.yml falls back
 * to downloading kstream-Setup.exe and launching it silently.
 */
async function installDesktopUpdate(setQuitting) {
  if (!app.isPackaged) {
    return { ok: false, error: 'dev' };
  }

  if (pendingDownload) return pendingDownload;

  pendingDownload = (async () => {
    configureAutoUpdater();
    try {
      const downloaded = waitForEvent('update-downloaded', 10 * 60 * 1000);
      await autoUpdater.checkForUpdates();
      await autoUpdater.downloadUpdate();
      await downloaded;
      setQuitting();
      autoUpdater.quitAndInstall(false, true);
      return { ok: true, via: 'electron-updater' };
    } catch (err) {
      console.warn(
        '[kstream-desktop] in-app updater unavailable, launching installer',
        err?.message || err,
      );
      const setup = await downloadLatestSetup();
      launchSetupAndQuit(setup, setQuitting);
      return { ok: true, via: 'installer' };
    } finally {
      pendingDownload = null;
    }
  })();

  return pendingDownload;
}

module.exports = {
  setupBackgroundCheck,
  installDesktopUpdate,
  attachInstallerDownloadHandler,
  isKstreamSetupDownload,
};
