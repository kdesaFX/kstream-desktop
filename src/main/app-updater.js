'use strict';

const { app, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SETUP_URL =
  'https://github.com/kdesaFX/kstream-desktop/releases/latest/download/kstream-Setup.exe';

let configured = false;
let pendingDownload = null;

function configureAutoUpdater() {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Unsigned and Azure-signed builds both need to apply updates.
  autoUpdater.autoRunAppAfterInstall = true;

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

async function downloadLatestSetup() {
  const dest = path.join(app.getPath('temp'), 'kstream-Setup.exe');
  const res = await net.fetch(SETUP_URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Could not download updater (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) {
    throw new Error('Updater download looks incomplete');
  }
  fs.writeFileSync(dest, buf);
  return dest;
}

function launchSetupAndQuit(exePath, setQuitting) {
  setQuitting();
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  app.quit();
}

/**
 * User clicked Update in the web UI.
 * Prefer electron-updater (NSIS). Portable / missing latest.yml falls back
 * to downloading kstream-Setup.exe and launching it.
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
};
