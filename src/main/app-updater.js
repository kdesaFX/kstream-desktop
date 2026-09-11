'use strict';

const { app, net, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getInstallDir } = require('./install');

const SETUP_URLS = ['https://kdesa.stream/download/kstream-Setup.exe'];

let configured = false;
let getWindow = () => null;
let setQuitting = () => {};
let fallbackPromise = null;

/** @type {{ phase: string, percent: number, version: string | null, error: string | null, setupPath: string | null }} */
let status = {
  phase: 'idle',
  percent: 0,
  version: null,
  error: null,
  setupPath: null,
};

function stateFilePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readPersisted() {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writePersisted(extra) {
  try {
    const prev = readPersisted();
    const next = {
      runningVersion: app.getVersion(),
      phase: status.phase,
      version: status.version,
      setupPath: status.setupPath || null,
      pendingApply: Boolean(extra?.pendingApply ?? prev.pendingApply),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(stateFilePath(), JSON.stringify(next));
  } catch {
    // ignore
  }
}

function publicStatus() {
  const { setupPath: _setupPath, ...payload } = status;
  return payload;
}

function broadcast() {
  const payload = publicStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('kstream:desktop-update', payload);
    }
  }
}

function setStatus(partial) {
  status = { ...status, ...partial };
  writePersisted();
  broadcast();
}

function hydrateFromDisk() {
  const prev = readPersisted();
  const running = app.getVersion();
  if (prev.pendingApply) {
    const applied =
      typeof prev.runningVersion === 'string' &&
      prev.runningVersion !== running;
    writePersisted({ pendingApply: false });
    if (!applied) {
      status.phase = 'idle';
      status.error = null;
    }
  }
  if (prev.setupPath && fs.existsSync(prev.setupPath)) {
    status.setupPath = prev.setupPath;
    status.phase = 'ready';
    status.percent = 100;
    status.version = prev.version || status.version;
    status.error = null;
  }
}

function configureAutoUpdater() {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.verifyUpdateCodeSignature = false;

  autoUpdater.on('checking-for-update', () => {
    if (status.phase === 'ready') return;
    setStatus({ phase: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    setStatus({
      phase: 'downloading',
      percent: status.percent || 0,
      version: info?.version || status.version,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (status.phase === 'ready' || status.phase === 'downloading') return;
    setStatus({ phase: 'idle', percent: 0, error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(
      0,
      Math.min(100, Math.round(Number(progress?.percent) || 0)),
    );
    setStatus({
      phase: 'downloading',
      percent,
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      phase: 'ready',
      percent: 100,
      version: info?.version || status.version,
      error: null,
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[kstream-desktop] updater error', err?.message || err);
    if (status.phase === 'ready') return;
    if (status.phase === 'downloading') {
      void startSilentSetupFallback();
      return;
    }
    setStatus({
      phase: 'idle',
      error: null,
    });
  });
}

function setupDestPath() {
  return path.join(app.getPath('temp'), 'kstream-Setup.exe');
}

function writeWebStreamToFile(webStream, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    writer.on('error', reject);
    const reader = webStream.getReader();
    let received = 0;

    const pump = () => {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            writer.end();
            return;
          }
          received += value.byteLength;
          onBytes(received);
          const chunk = Buffer.from(value);
          if (writer.write(chunk)) {
            pump();
          } else {
            writer.once('drain', pump);
          }
        })
        .catch((err) => {
          writer.destroy();
          reject(err);
        });
    };

    writer.on('finish', resolve);
    pump();
  });
}

async function downloadLatestSetup() {
  const dest = setupDestPath();
  let lastError = new Error('Could not download updater');
  for (const url of SETUP_URLS) {
    try {
      const res = await net.fetch(`${url}?t=${Date.now()}`, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        lastError = new Error(`Could not download updater (${res.status})`);
        continue;
      }
      const total = Number(res.headers.get('content-length') || 0);
      await writeWebStreamToFile(res.body, dest, (received) => {
        const percent =
          total > 0
            ? Math.max(0, Math.min(99, Math.round((received / total) * 100)))
            : Math.min(99, status.percent);
        setStatus({
          phase: 'downloading',
          percent,
          error: null,
        });
      });
      const size = fs.statSync(dest).size;
      if (size < 1_000_000) {
        lastError = new Error('Updater download looks incomplete');
        try {
          fs.unlinkSync(dest);
        } catch {
          // ignore
        }
        continue;
      }
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        // ignore
      }
    }
  }
  throw lastError;
}

function installedExePath() {
  return path.join(getInstallDir(), 'kstream.exe');
}

/** Setup/updater children are often killed with the installer job; this watcher is not. */
function scheduleRelaunchAfterApply() {
  const exe = installedExePath();
  const script = [
    `$exe = ${JSON.stringify(exe)}`,
    'for ($i = 0; $i -lt 40; $i++) {',
    '  Start-Sleep -Seconds 2',
    '  if (-not (Test-Path -LiteralPath $exe)) { continue }',
    '  $running = @(Get-CimInstance Win32_Process -Filter "Name = \'kstream.exe\'" -ErrorAction SilentlyContinue)',
    '  $installed = $running | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $exe.ToLower() }',
    '  if ($installed) { exit 0 }',
    '  if ($running.Count -gt 0) { continue }',
    '  try {',
    '    Start-Process -FilePath $exe',
    '    exit 0',
    '  } catch { }',
    '}',
  ].join('; ');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

function launchSetupAndQuit(exePath) {
  writePersisted({ pendingApply: true });
  setQuitting();
  scheduleRelaunchAfterApply();
  const child = spawn(exePath, ['/S', '/currentuser', '/NCRC'], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });
  child.unref();
  setTimeout(() => app.quit(), 800);
}

async function startSilentSetupFallback() {
  if (fallbackPromise) return fallbackPromise;

  fallbackPromise = (async () => {
    setStatus({
      phase: 'downloading',
      percent: Math.max(status.percent, 1),
      error: null,
    });
    try {
      const dest = await downloadLatestSetup();
      setStatus({
        phase: 'ready',
        percent: 100,
        error: null,
        setupPath: dest,
      });
    } catch (err) {
      console.warn(
        '[kstream-desktop] silent updater download failed',
        err?.message || err,
      );
      setStatus({
        phase: 'error',
        error: 'Could not download the update. Try again later.',
      });
    } finally {
      fallbackPromise = null;
    }
  })();

  return fallbackPromise;
}

function setupBackgroundCheck(windowGetter, quittingSetter) {
  getWindow = windowGetter || getWindow;
  setQuitting = quittingSetter || setQuitting;

  if (!app.isPackaged) {
    console.log('[kstream-desktop] skipping auto-updater in dev');
    return;
  }

  configureAutoUpdater();
  hydrateFromDisk();

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[kstream-desktop] update check failed', err?.message || err);
    });
  };

  setTimeout(check, 12_000);
  setInterval(check, 30 * 60 * 1000);
}

function getDesktopUpdateStatus() {
  return publicStatus();
}

async function checkDesktopUpdate() {
  if (!app.isPackaged) {
    return { ...publicStatus(), phase: 'idle', error: 'dev' };
  }
  configureAutoUpdater();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[kstream-desktop] update check failed', err?.message || err);
    await startSilentSetupFallback();
  }
  return publicStatus();
}

async function applyDesktopUpdate(quittingSetter) {
  if (quittingSetter) setQuitting = quittingSetter;
  if (!app.isPackaged) {
    return { ok: false, error: 'dev' };
  }

  // Never quitAndInstall — that opens the NSIS wizard. Always run Setup silently.
  if (!status.setupPath || !fs.existsSync(status.setupPath)) {
    await startSilentSetupFallback();
  }

  if (status.setupPath && fs.existsSync(status.setupPath)) {
    launchSetupAndQuit(status.setupPath);
    return { ok: true, via: 'installer' };
  }

  return { ok: false, error: status.error || 'not-ready' };
}

function isKstreamSetupDownload(filename, url) {
  const name = String(filename || '').toLowerCase();
  const href = String(url || '').toLowerCase();
  return name.includes('kstream-setup') || href.includes('kstream-setup.exe');
}

function attachInstallerDownloadHandler(sess, quittingSetter) {
  if (quittingSetter) setQuitting = quittingSetter;
  if (!sess || sess.__kstreamSetupDownloadHook) return;
  sess.__kstreamSetupDownloadHook = true;
  sess.on('will-download', (_event, item) => {
    if (!isKstreamSetupDownload(item.getFilename(), item.getURL())) return;
    const dest = setupDestPath();
    item.setSavePath(dest);
    setStatus({ phase: 'downloading', percent: 1, error: null });
    item.on('updated', (_e, state) => {
      if (state !== 'progressing') return;
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      const percent =
        total > 0
          ? Math.max(1, Math.min(99, Math.round((received / total) * 100)))
          : status.percent;
      setStatus({ phase: 'downloading', percent, error: null });
    });
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        setStatus({
          phase: 'ready',
          percent: 100,
          error: null,
          setupPath: dest,
        });
      } else {
        setStatus({
          phase: 'error',
          error: 'Could not download the update. Try again later.',
        });
      }
    });
  });
}

module.exports = {
  setupBackgroundCheck,
  checkDesktopUpdate,
  applyDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate: applyDesktopUpdate,
  attachInstallerDownloadHandler,
  isKstreamSetupDownload,
};
