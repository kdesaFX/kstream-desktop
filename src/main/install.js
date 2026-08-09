'use strict';

const fs = require('fs');
// Electron patches fs to treat .asar as directories — that breaks recursive copies (ENOTDIR).
const ofs = require('original-fs');
const path = require('path');
const { app, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');

const PRODUCT = 'kstream';
const EXE_NAME = 'kstream.exe';

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait — install path is short-lived and must stay sync-friendly
  }
}

function getLocalAppData() {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }
  // Electron has appData (Roaming), not localAppData — derive Local from it.
  return path.join(app.getPath('appData'), '..', 'Local');
}

function getInstallDir() {
  return path.join(getLocalAppData(), 'Programs', PRODUCT);
}

function getPortableRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  return path.dirname(process.execPath);
}

function getPortableMarkerPath() {
  return path.join(getPortableRoot(), 'kstream-portable.json');
}

function isPackaged() {
  return app.isPackaged;
}

function isRunningFromInstallDir() {
  if (!isPackaged()) return false;
  const installDir = getInstallDir().toLowerCase();
  const exeDir = path.dirname(process.execPath).toLowerCase();
  return exeDir === installDir || exeDir.startsWith(`${installDir}${path.sep}`);
}

function hasPortableMarker() {
  try {
    return ofs.existsSync(getPortableMarkerPath());
  } catch {
    return false;
  }
}

function getAppRoot() {
  // Packaged: .../resources/../ → app directory containing kstream.exe + resources/
  if (isPackaged()) {
    return path.join(process.resourcesPath, '..');
  }
  return path.join(__dirname, '..', '..');
}

function configurePortableUserData() {
  if (!isPackaged()) return false;
  if (isRunningFromInstallDir()) return false;
  if (!hasPortableMarker()) return false;

  const dataDir = path.join(getPortableRoot(), 'kstream-data');
  try {
    ofs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.warn('[kstream-desktop] could not create portable data dir', err);
  }
  app.setPath('userData', dataDir);
  return true;
}

function needsSetup(store) {
  if (isRunningFromInstallDir()) return false;
  if (hasPortableMarker()) return false;
  const mode = store.get('runMode', null);
  if (mode === 'installed' || mode === 'portable') return false;
  return true;
}

function writePortableMarker() {
  const marker = {
    mode: 'portable',
    version: app.getVersion(),
    createdAt: new Date().toISOString(),
  };
  ofs.writeFileSync(getPortableMarkerPath(), JSON.stringify(marker, null, 2), 'utf8');
}

function createShortcuts(exePath, installDir) {
  const desktop = path.join(app.getPath('desktop'), `${PRODUCT}.lnk`);
  const startMenuDir = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  fs.mkdirSync(startMenuDir, { recursive: true });
  const startMenu = path.join(startMenuDir, `${PRODUCT}.lnk`);

  const shortcut = {
    target: exePath,
    cwd: installDir,
    description: 'kstream',
    icon: exePath,
    iconIndex: 0,
  };

  shell.writeShortcutLink(desktop, 'create', shortcut);
  shell.writeShortcutLink(startMenu, 'create', shortcut);
}

/** Kill only kstream processes whose exe lives under installDir (never our current process). */
function stopProcessesUnder(dir) {
  if (process.platform !== 'win32') return;
  const target = path.resolve(dir).toLowerCase().replace(/'/g, "''");
  const selfPid = process.pid;
  const script = `
$target = '${target}'
Get-CimInstance Win32_Process -Filter "Name = 'kstream.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $exe = $_.ExecutablePath
  if (-not $exe) { return }
  if ($_.ProcessId -eq ${selfPid}) { return }
  if ($exe.ToLower().StartsWith($target)) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 400
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 20000,
      windowsHide: true,
    });
  } catch (err) {
    console.warn('[kstream-desktop] stopProcessesUnder failed', err.message);
  }
}

function removePathWithRetry(target, attempts = 10) {
  if (!ofs.existsSync(target)) return;
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      ofs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      if (!ofs.existsSync(target)) return;
    } catch (err) {
      lastErr = err;
    }
    sleepSync(250 + i * 100);
  }
  if (ofs.existsSync(target)) {
    throw lastErr || new Error(`Could not remove locked path: ${target}`);
  }
}

function copyAppTree(src, dest) {
  // Dest must not exist so Node creates a full mirror of src.
  if (ofs.existsSync(dest)) {
    removePathWithRetry(dest);
  }
  ofs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (from) => {
      const base = path.basename(from).toLowerCase();
      if (base === 'kstream-data') return false;
      if (base === 'kstream-portable.json') return false;
      if (base.endsWith('.log')) return false;
      return true;
    },
  });
}

function copyAppToInstallDir(installDir) {
  const appRoot = path.resolve(getAppRoot());
  const dest = path.resolve(installDir);
  const staging = `${dest}.staging-${process.pid}`;
  const backup = `${dest}.bak`;

  if (appRoot.toLowerCase() === dest.toLowerCase()) {
    throw new Error('Already running from the install folder.');
  }

  stopProcessesUnder(dest);
  stopProcessesUnder(backup);

  // Clean leftover staging dirs from failed attempts
  try {
    const parent = path.dirname(dest);
    if (ofs.existsSync(parent)) {
      for (const name of ofs.readdirSync(parent)) {
        if (name === 'kstream.staging' || name.startsWith('kstream.staging-')) {
          removePathWithRetry(path.join(parent, name));
        }
      }
    }
  } catch (err) {
    console.warn('[kstream-desktop] staging cleanup', err.message);
  }

  removePathWithRetry(backup);
  copyAppTree(appRoot, staging);

  ofs.writeFileSync(
    path.join(staging, '.kstream-installed'),
    JSON.stringify(
      {
        version: app.getVersion(),
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  if (ofs.existsSync(dest)) {
    stopProcessesUnder(dest);
    sleepSync(300);
    try {
      ofs.renameSync(dest, backup);
    } catch {
      removePathWithRetry(dest);
    }
  }

  try {
    ofs.renameSync(staging, dest);
  } catch {
    copyAppTree(staging, dest);
    removePathWithRetry(staging);
  }

  try {
    removePathWithRetry(backup);
  } catch (err) {
    console.warn('[kstream-desktop] left backup install folder (locked):', backup, err.message);
  }
}

async function installToAppData() {
  if (!isPackaged()) {
    return {
      ok: true,
      dev: true,
      installDir: getInstallDir(),
      exePath: process.execPath,
    };
  }

  const installDir = getInstallDir();
  try {
    copyAppToInstallDir(installDir);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/enospc|no space left/i.test(msg)) {
      throw new Error(
        'not enough free disk space on C: to install. free ~500MB and try again (or choose portable).',
      );
    }
    if (/ebusy|eperm|resource busy|locked/i.test(msg)) {
      throw new Error(
        'install folder is locked by another kstream process. close other kstream windows and try again.',
      );
    }
    if (/enotdir/i.test(msg)) {
      throw new Error(
        'install copy failed (file/folder conflict). close kstream, delete %LOCALAPPDATA%\\Programs\\kstream* and try again.',
      );
    }
    throw err;
  }

  const exePath = path.join(installDir, EXE_NAME);
  if (!ofs.existsSync(exePath)) {
    throw new Error(`Installed executable missing at ${exePath}`);
  }

  createShortcuts(exePath, installDir);

  return { ok: true, installDir, exePath };
}

function launchInstalledAndExit(exePath) {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exePath),
  });
  child.unref();
  app.exit(0);
}

function getSetupInfo() {
  return {
    version: app.getVersion(),
    installDir: getInstallDir(),
    portableRoot: getPortableRoot(),
    packaged: isPackaged(),
    logoPath: path.join(getAppRoot(), 'logo.png'),
  };
}

module.exports = {
  PRODUCT,
  configurePortableUserData,
  needsSetup,
  writePortableMarker,
  installToAppData,
  launchInstalledAndExit,
  getSetupInfo,
  getInstallDir,
  isRunningFromInstallDir,
  hasPortableMarker,
};
