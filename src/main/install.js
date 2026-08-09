'use strict';

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { spawn } = require('child_process');

const PRODUCT = 'kstream';
const EXE_NAME = 'kstream.exe';

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

function getInstalledMarkerPath() {
  return path.join(getInstallDir(), '.kstream-installed');
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
    return fs.existsSync(getPortableMarkerPath());
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
    fs.mkdirSync(dataDir, { recursive: true });
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
  fs.writeFileSync(getPortableMarkerPath(), JSON.stringify(marker, null, 2), 'utf8');
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

function copyAppToInstallDir(installDir) {
  const appRoot = path.resolve(getAppRoot());
  const dest = path.resolve(installDir);

  if (appRoot.toLowerCase() === dest.toLowerCase()) {
    throw new Error('Already running from the install folder.');
  }

  fs.mkdirSync(dest, { recursive: true });

  // Fresh install directory (keep user data elsewhere under AppData)
  for (const entry of fs.readdirSync(dest)) {
    fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  }

  fs.cpSync(appRoot, dest, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src).toLowerCase();
      // Skip noisy / session junk if present in portable unpack dir
      if (base === 'kstream-data') return false;
      if (base === 'kstream-portable.json') return false;
      if (base.endsWith('.log')) return false;
      return true;
    },
  });

  fs.writeFileSync(
    getInstalledMarkerPath(),
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
}

async function installToAppData() {
  if (!isPackaged()) {
    // Dev: pretend install succeeded so welcome can be skipped next time
    return {
      ok: true,
      dev: true,
      installDir: getInstallDir(),
      exePath: process.execPath,
    };
  }

  const installDir = getInstallDir();
  copyAppToInstallDir(installDir);

  const exePath = path.join(installDir, EXE_NAME);
  if (!fs.existsSync(exePath)) {
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
