'use strict';

const { app, net, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getInstallDir } = require('./install');

const SETUP_URLS = [
  'https://github.com/kdesaFX/kstream-desktop/releases/latest/download/kstream-Setup.exe',
  'https://kdesa.stream/download/kstream-Setup.exe',
];

let configured = false;
let manualCheck = false;
let getWindow = () => null;
let setQuitting = () => {};
let fallbackPromise = null;
let startupCheckPromise = null;
const launchedAfterUpdateFailure = process.argv.includes(
  '--kstream-update-failed',
);

/** @type {{ phase: string, percent: number, version: string | null, error: string | null, setupPath: string | null }} */
let status = {
  phase: launchedAfterUpdateFailure ? 'error' : 'idle',
  percent: 0,
  version: null,
  error: launchedAfterUpdateFailure
    ? 'The update could not be installed. You are running the previous version.'
    : null,
  setupPath: null,
};

function stateFilePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function hasPendingApplyForCurrentVersion() {
  if (launchedAfterUpdateFailure) {
    writePersisted({ pendingApply: false });
    return false;
  }
  const prev = readPersisted();
  const age = Date.now() - Number(prev.updatedAt || 0);
  const stale = !Number.isFinite(age) || age > 10 * 60 * 1000;
  // A same-version marker means the installer did not complete. Let normal
  // startup recover the downloaded setup instead of trapping the app in a
  // window that quits after ten seconds.
  if (prev.pendingApply && (stale || prev.runningVersion === app.getVersion())) {
    writePersisted({ pendingApply: false });
    return false;
  }
  return Boolean(prev.pendingApply) && prev.runningVersion === app.getVersion();
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
    const hasTargetVersion = Object.prototype.hasOwnProperty.call(
      extra || {},
      'targetVersion',
    );
    const next = {
      runningVersion: app.getVersion(),
      phase: status.phase,
      version: status.version,
      setupPath: status.setupPath || null,
      pendingApply: Boolean(extra?.pendingApply ?? prev.pendingApply),
      targetVersion: hasTargetVersion
        ? extra.targetVersion
        : prev.targetVersion || status.version || null,
      updatedAt: Date.now(),
    };
    const statePath = stateFilePath();
    const tempPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next));
    try {
      fs.renameSync(tempPath, statePath);
    } catch {
      // Windows cannot replace an open destination with rename(). Keep the
      // state durable even when another updater read has the file open.
      removeFile(statePath);
      fs.renameSync(tempPath, statePath);
    }
  } catch {
    // ignore
  }
}

function publicStatus() {
  const { setupPath: _setupPath, ...payload } = status;
  return { ...payload, runningVersion: app.getVersion() };
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

function sameAppVersion(a, b) {
  const left = String(a || '')
    .trim()
    .replace(/^v/i, '');
  const right = String(b || '')
    .trim()
    .replace(/^v/i, '');
  return Boolean(left) && left === right;
}

function isNewerVersion(candidate, current) {
  const next = String(candidate || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const installed = String(current || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (
    next.length < 1 ||
    installed.length < 1 ||
    next.some((part) => !Number.isFinite(part)) ||
    installed.some((part) => !Number.isFinite(part))
  ) {
    return false;
  }
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index += 1) {
    const left = next[index] || 0;
    const right = installed[index] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

function discardStaleSetup(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function hydrateFromDisk() {
  const prev = readPersisted();
  const running = app.getVersion();
  const age = Date.now() - Number(prev.updatedAt || 0);
  const stale = !Number.isFinite(age) || age > 10 * 60 * 1000;
  const applied =
    Boolean(prev.pendingApply) &&
    typeof prev.runningVersion === 'string' &&
    prev.runningVersion !== running;
  const alreadyOnTarget = sameAppVersion(prev.version, running);

  if (applied || alreadyOnTarget) {
    discardStaleSetup(prev.setupPath);
    status = {
      phase: 'idle',
      percent: 0,
      version: null,
      error: null,
      setupPath: null,
    };
    writePersisted({ pendingApply: false });
    return false;
  }

  if (prev.pendingApply && prev.runningVersion === running) {
    if (stale) {
      discardStaleSetup(prev.setupPath);
      status = {
        phase: 'idle',
        percent: 0,
        version: null,
        error: null,
        setupPath: null,
      };
      writePersisted({ pendingApply: false });
      return false;
    }
    const canRecover =
      prev.setupPath &&
      fs.existsSync(prev.setupPath) &&
      prev.version &&
      isNewerVersion(prev.version, running);
    status = {
      phase: canRecover ? 'ready' : 'error',
      percent: canRecover ? 100 : 0,
      version: canRecover ? prev.version : null,
      error: canRecover
        ? 'The previous update did not finish. You can retry it from the app.'
        : 'The previous update did not finish. Please check for updates again.',
      setupPath: canRecover ? prev.setupPath : null,
    };
    writePersisted({ pendingApply: false });
    return true;
  }

  if (stale) {
    discardStaleSetup(prev.setupPath);
    status = {
      phase: 'idle',
      percent: 0,
      version: null,
      error: null,
      setupPath: null,
    };
    writePersisted({ pendingApply: false });
    return false;
  }

  if (
    prev.setupPath &&
    fs.existsSync(prev.setupPath) &&
    prev.version &&
    !sameAppVersion(prev.version, running)
  ) {
    status.setupPath = prev.setupPath;
    status.phase = 'ready';
    status.percent = 100;
    status.version = prev.version;
    status.error = null;
  }
  return false;
}

function configureAutoUpdater() {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // The detached supervisor owns installation and relaunch. Electron's own
  // relaunch would race it and can leave the app closed after a failed apply.
  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.verifyUpdateCodeSignature = false;

  autoUpdater.on('checking-for-update', () => {
    setStatus({ phase: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    setStatus({
      phase: manualCheck ? 'ready' : 'downloading',
      percent: manualCheck ? 100 : status.percent || 0,
      version: info?.version || status.version,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (status.phase === 'ready' && isNewerVersion(status.version, app.getVersion())) {
      return;
    }
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
    const next = info?.version || status.version;
    if (sameAppVersion(next, app.getVersion())) {
      setStatus({
        phase: 'idle',
        percent: 0,
        error: null,
        setupPath: null,
      });
      return;
    }
    setStatus({
      phase: 'ready',
      percent: 100,
      version: next,
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

function setupPartPath() {
  return `${setupDestPath()}.part`;
}

function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
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
  const part = setupPartPath();
  let lastError = new Error('Could not download updater');
  for (const url of SETUP_URLS) {
    try {
      removeFile(part);
      const res = await net.fetch(`${url}?t=${Date.now()}`, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        lastError = new Error(`Could not download updater (${res.status})`);
        continue;
      }
      const total = Number(res.headers.get('content-length') || 0);
      await writeWebStreamToFile(res.body, part, (received) => {
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
      const size = fs.statSync(part).size;
      if (size < 1_000_000) {
        lastError = new Error('Updater download looks incomplete');
        removeFile(part);
        continue;
      }
      const header = Buffer.alloc(2);
      const reader = fs.openSync(part, 'r');
      fs.readSync(reader, header, 0, 2, 0);
      fs.closeSync(reader);
      if (header.toString('ascii') !== 'MZ') {
        lastError = new Error('Updater download is not a Windows installer');
        removeFile(part);
        continue;
      }
      removeFile(dest);
      fs.renameSync(part, dest);
      return dest;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      removeFile(part);
    }
  }
  throw lastError;
}

function installedExePath() {
  return path.join(getInstallDir(), 'kstream.exe');
}

/** Run the installer outside Electron and verify a replacement process starts. */
function scheduleRelaunchAfterApply(setupPath, targetVersion) {
  const installed = installedExePath();
  const exe = fs.existsSync(installed) ? installed : process.execPath;
  const logPath = path.join(app.getPath('userData'), 'update-supervisor.log');
  const script = [
    `$setup = ${JSON.stringify(setupPath)}`,
    `$exe = ${JSON.stringify(exe)}`,
    `$target = ${JSON.stringify(String(targetVersion || ''))}`,
    `$log = ${JSON.stringify(logPath)}`,
    `$parentPid = ${process.pid}`,
    'function Log($message) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " " + $message) }',
    'function Relaunch($failed) { if (Test-Path -LiteralPath $exe) { $args = @(); if ($failed) { $args = @("--kstream-update-failed") }; try { $child = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory (Split-Path -Parent $exe) -PassThru -ErrorAction Stop; Start-Sleep -Seconds 2; if (Get-Process -Id $child.Id -ErrorAction SilentlyContinue) { return $true }; Log "relaunch exited immediately" } catch { Log ("relaunch failed: " + $_.Exception.Message) } }; return $false }',
    'Log "supervisor started"',
    'for ($i = 0; $i -lt 60; $i++) { if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }',
    'try { $installer = Start-Process -FilePath $setup -ArgumentList @("/S", "/currentuser", "/NCRC") -PassThru -WindowStyle Hidden -ErrorAction Stop } catch { Log ("installer start failed: " + $_.Exception.Message); Relaunch $true; exit 1 }',
    '$installer.WaitForExit()',
    'if ($installer.ExitCode -ne 0) { Log ("installer exited with " + $installer.ExitCode); Relaunch $true; exit 1 }',
    'if (-not (Test-Path -LiteralPath $exe)) { Log "installed executable is missing"; Relaunch $true; exit 1 }',
    '$actual = ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -replace "\\.0$", "")',
    '$expected = ($target -replace "^v", "" -replace "\\.0$", "")',
    'if ($expected -and $actual -and $actual -ne $expected) { Log ("version mismatch: expected " + $expected + ", got " + $actual); Relaunch $true; exit 1 }',
    'for ($i = 0; $i -lt 30; $i++) { try { if (Relaunch $false) { Log "relaunch started"; exit 0 } } catch { Log ("relaunch retry failed: " + $_.Exception.Message) }; Start-Sleep -Seconds 1 }',
    'Log "relaunch could not be started"; Relaunch $true; exit 1',
  ].join('; ');
  return spawn(
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
}

function launchSetupAndQuit(exePath) {
  writePersisted({ pendingApply: true, targetVersion: status.version });
  const supervisor = scheduleRelaunchAfterApply(exePath, status.version);
  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      writePersisted({ pendingApply: false });
      setStatus({
        phase: 'error',
        error: 'Could not start the update. Try again or install it manually.',
      });
      console.warn(
        '[kstream-desktop] updater supervisor failed',
        err?.message || err,
      );
      resolve(false);
    };
    supervisor.once('error', fail);
    supervisor.once('exit', (code) => {
      if (!spawned || (code !== null && code !== 0)) {
        fail(new Error(`updater supervisor exited with ${code}`));
      }
    });
    supervisor.once('spawn', () => {
      if (settled) return;
      spawned = true;
      settled = true;
      supervisor.unref();
      setQuitting();
      setTimeout(() => app.quit(), 800);
      resolve(true);
    });
  });
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

function setupBackgroundCheck(windowGetter, quittingSetter, options = {}) {
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

  if (!options.skipInitialCheck) {
    setTimeout(check, 12_000);
  }
  setInterval(check, 30 * 60 * 1000);
}

function getDesktopUpdateStatus() {
  return publicStatus();
}

async function checkDesktopUpdate(options = {}) {
  if (!app.isPackaged) {
    return { ...publicStatus(), phase: 'idle', error: 'dev' };
  }
  configureAutoUpdater();
  const previousAutoDownload = autoUpdater.autoDownload;
  manualCheck = options.manual === true;
  if (manualCheck) autoUpdater.autoDownload = false;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[kstream-desktop] update check failed', err?.message || err);
    await startSilentSetupFallback();
  } finally {
    manualCheck = false;
    autoUpdater.autoDownload = previousAutoDownload;
  }
  return publicStatus();
}

/** Check before the main window opens, but never block startup indefinitely. */
async function checkDesktopUpdateAtStartup(timeoutMs = 90_000) {
  if (!app.isPackaged) return { ...publicStatus(), phase: 'idle', error: 'dev' };
  // A failed supervisor relaunches the previous build with this marker. Do
  // not immediately retry the same update and trap the user in a loop.
  if (launchedAfterUpdateFailure) return publicStatus();
  if (startupCheckPromise) return startupCheckPromise;

  configureAutoUpdater();
  const recoveredInterruptedApply = hydrateFromDisk();
  if (recoveredInterruptedApply) {
    return {
      ...publicStatus(),
      phase: 'recovery',
      recovery: true,
    };
  }

  startupCheckPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-not-available', finish);
      autoUpdater.removeListener('update-downloaded', finish);
      autoUpdater.removeListener('error', finish);
      resolve(publicStatus());
    };
    const timer = setTimeout(finish, timeoutMs);
    autoUpdater.once('update-not-available', finish);
    autoUpdater.once('update-downloaded', finish);
    autoUpdater.once('error', finish);
    autoUpdater.checkForUpdates().catch(finish);
  }).finally(() => {
    startupCheckPromise = null;
  });

  return startupCheckPromise;
}

async function applyDesktopUpdate(quittingSetter, options = {}) {
  if (quittingSetter) setQuitting = quittingSetter;
  if (!app.isPackaged) {
    return { ok: false, error: 'dev' };
  }
  if (!options.userInitiated) {
    return { ok: false, error: 'user-action-required' };
  }

  // Never quitAndInstall — that opens the NSIS wizard. Always run Setup silently.
  if (!status.setupPath || !fs.existsSync(status.setupPath)) {
    await startSilentSetupFallback();
  }

  if (status.setupPath && fs.existsSync(status.setupPath)) {
    const launched = await launchSetupAndQuit(status.setupPath);
    return launched
      ? { ok: true, via: 'installer' }
      : { ok: false, error: status.error || 'installer-start-failed' };
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
    const part = setupPartPath();
    removeFile(part);
    item.setSavePath(part);
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
        try {
          const size = fs.statSync(part).size;
          const header = Buffer.alloc(2);
          const reader = fs.openSync(part, 'r');
          fs.readSync(reader, header, 0, 2, 0);
          fs.closeSync(reader);
          if (size < 1_000_000 || header.toString('ascii') !== 'MZ') {
            throw new Error('invalid installer download');
          }
          removeFile(dest);
          fs.renameSync(part, dest);
          setStatus({
            phase: 'ready',
            percent: 100,
            error: null,
            setupPath: dest,
          });
        } catch (err) {
          removeFile(part);
          setStatus({
            phase: 'error',
            error: 'The downloaded update is invalid. Try again later.',
          });
        }
      } else {
        removeFile(part);
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
  hasPendingApplyForCurrentVersion,
  checkDesktopUpdate,
  checkDesktopUpdateAtStartup,
  applyDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate: applyDesktopUpdate,
  attachInstallerDownloadHandler,
  isKstreamSetupDownload,
};
