'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 *
 * Keep this simple: one IPC connection (never probe multiple pipes with the
 * same app id — Discord drops the first session). Prefer real Discord over
 * Vesktop arRPC. Text + optional poster URL; no uploaded asset keys required.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const DISCORD_CLIENT_ID = '1536251834203770941';
const WATCH_URL = 'https://kdesa.stream';
/** Small badge on the poster (Crunchyroll-style). External URL — no portal upload needed. */
const LOGO_IMAGE_URL =
  process.env.KSTREAM_DISCORD_LOGO_URL ||
  'https://kstream-one.vercel.app/apple-touch-icon.png';
/** Optional portal asset key; only used if set (external URL preferred). */
const LOGO_ASSET = (process.env.KSTREAM_DISCORD_ASSET || '').trim();

let ipcPipeSkip = 0;
const realCreateConnection = net.createConnection.bind(net);
net.createConnection = function patchedCreateConnection(target, ...rest) {
  if (
    typeof target === 'string' &&
    target.includes('discord-ipc-') &&
    ipcPipeSkip > 0
  ) {
    target = target.replace(/discord-ipc-(\d+)/, (_, id) => {
      return `discord-ipc-${Number(id) + ipcPipeSkip}`;
    });
  } else if (
    target &&
    typeof target === 'object' &&
    typeof target.path === 'string' &&
    target.path.includes('discord-ipc-') &&
    ipcPipeSkip > 0
  ) {
    target = {
      ...target,
      path: target.path.replace(/discord-ipc-(\d+)/, (_, id) => {
        return `discord-ipc-${Number(id) + ipcPipeSkip}`;
      }),
    };
  }
  return realCreateConnection(target, ...rest);
};

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function normalizePosterUrl(poster) {
  if (!isHttpUrl(poster)) return null;
  return poster
    .trim()
    .replace(
      /image\.tmdb\.org\/t\/p\/(?:original|w\d+)/i,
      'image.tmdb.org/t/p/w500',
    );
}

let rpc = null;
let ready = false;
let connectPromise = null;
let lastPayloadKey = '';
let pendingBody = { idle: true };
let registered = false;
let logPath = null;
let watchdogTimer = null;
let reconnectTimer = null;
let refreshTimer = null;

function setLogPath(userDataPath) {
  try {
    logPath = path.join(userDataPath, 'discord-rpc.log');
  } catch {
    logPath = null;
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log('[kstream-desktop]', ...parts);
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    // ignore
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function destroyClient(reason) {
  ready = false;
  const client = rpc;
  rpc = null;
  if (!client) return;
  log('destroyClient:', reason || '');
  try {
    client.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    client.destroy();
  } catch {
    // ignore
  }
}

function scheduleReconnect(delayMs = 2500) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (ready && rpc) return;
    log('attempting Discord reconnect…');
    lastPayloadKey = '';
    ensureClient()
      .then((client) => {
        if (!client) {
          scheduleReconnect(Math.min(15000, delayMs * 1.5));
          return null;
        }
        return flushPending(true);
      })
      .catch(() => scheduleReconnect(Math.min(15000, delayMs * 1.5)));
  }, delayMs);
}

function attachClientGuards(client) {
  client.on('error', (err) => {
    log('RPC error:', err?.message || String(err));
    ready = false;
    if (rpc === client) rpc = null;
    scheduleReconnect();
  });

  client.on('disconnected', () => {
    log('RPC disconnected');
    ready = false;
    if (rpc === client) rpc = null;
    scheduleReconnect(1500);
  });
}

async function loginOnce() {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  const DiscordRPC = require('discord-rpc');
  if (!registered) {
    try {
      DiscordRPC.register(DISCORD_CLIENT_ID);
      registered = true;
    } catch (regErr) {
      log('register skipped:', regErr?.message || regErr);
    }
  }

  const client = new DiscordRPC.Client({ transport: 'ipc' });
  attachClientGuards(client);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Discord RPC connect timeout'));
    }, 5000);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });

    client.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return client;
}

/**
 * Connect to ONE pipe only. Probing multiple pipes with the same application
 * id makes Discord drop the first session — that was killing visible presence.
 */
async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      if (rpc) destroyClient('reconnect');

      for (let skip = 0; skip < 5; skip += 1) {
        ipcPipeSkip = skip;
        try {
          const client = await loginOnce();
          const who = (client.user?.username || '').toString();
          const globalName = (client.user?.global_name || '').toString();
          log('connected as', who || '?', globalName ? `(${globalName})` : '', `ipc=${skip}`);

          if (who.toLowerCase() === 'arrpc') {
            log('skipping arRPC, trying next pipe');
            try {
              client.destroy();
            } catch {
              // ignore
            }
            continue;
          }

          rpc = client;
          ready = true;
          clearReconnectTimer();
          return rpc;
        } catch (err) {
          log(`ipc=${skip} failed:`, err?.message || err);
        }
      }

      log('unavailable: no Discord IPC pipe found');
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

function buildIdleActivity() {
  return {
    type: 3,
    details: 'Browsing',
    state: 'Looking for something to watch',
    instance: false,
    buttons: [{ label: 'Watch now on kstream', url: WATCH_URL }],
  };
}

function formatReleaseLabel(body) {
  const raw =
    typeof body.releaseDate === 'string' ? body.releaseDate.trim() : '';
  if (raw) {
    const [yearStr, monthStr] = raw.slice(0, 10).split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (year && month >= 1 && month <= 12) {
      return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      });
    }
    if (year) return String(year);
  }
  const year = Number(body.releaseYear);
  if (Number.isFinite(year) && year > 0) return String(year);
  return '';
}

function formatClock(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTimeRange(currentSec, durationSec) {
  if (!(durationSec > 0)) return '';
  return `${formatClock(currentSec)}-${formatClock(durationSec)}`;
}

function buildActivityPayload(body) {
  if (body?.idle) return buildIdleActivity();

  const title = (body.title || 'Something').trim();
  const releaseLabel = formatReleaseLabel(body);

  let currentSec =
    typeof body.currentTimeSec === 'number' && body.currentTimeSec >= 0
      ? body.currentTimeSec
      : null;
  const durationSec =
    typeof body.durationSec === 'number' && body.durationSec > 0
      ? body.durationSec
      : 0;

  if (
    currentSec == null &&
    typeof body.startTimestamp === 'number' &&
    !body.isPaused &&
    !body.clearTimestamps
  ) {
    currentSec = Math.max(0, (Date.now() - body.startTimestamp) / 1000);
  }
  if (currentSec == null) currentSec = 0;

  const timeRange = formatTimeRange(currentSec, durationSec);

  // Watching kstream — plain white text only (no Discord timestamp widget):
  // 1) details = title
  // 2) state line 1 = month + year
  // 3) state line 2 = "0:05-20:01" (newline under the date)
  let state = releaseLabel || '';
  if (timeRange) {
    state = state ? `${state}\n${timeRange}` : timeRange;
  }
  if (!state) state = ' ';

  const activity = {
    type: 3,
    details: title.slice(0, 128),
    state: state.slice(0, 128),
    instance: false,
    buttons: [{ label: 'Watch now on kstream', url: WATCH_URL }],
  };

  const poster = normalizePosterUrl(body.poster);
  if (poster) {
    activity.assets = {
      large_image: poster,
      small_image: LOGO_ASSET || LOGO_IMAGE_URL,
      small_text: 'kstream',
    };
  }

  return activity;
}

function activityKey(activity, isPaused) {
  return JSON.stringify({
    d: activity.details,
    s: activity.state,
    y: activity.type || 0,
    p: Boolean(isPaused),
    i: activity.assets?.large_image || '',
  });
}

async function setActivitySafe(client, activity) {
  const pid = process.pid;
  const attempts = [
    activity,
    // without buttons
    (() => {
      const a = { ...activity };
      delete a.buttons;
      return a;
    })(),
    // without assets
    (() => {
      const a = { ...activity };
      delete a.buttons;
      delete a.assets;
      return a;
    })(),
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      await client.request('SET_ACTIVITY', { pid, activity: attempt });
      log(
        'SET_ACTIVITY ok',
        attempt.details,
        '/',
        attempt.state,
        attempt.assets?.large_image ? 'poster' : 'text',
        attempt.buttons ? 'btn' : 'nobtn',
      );
      return true;
    } catch (err) {
      lastErr = err;
      log('SET_ACTIVITY retry:', err?.message || err);
    }
  }
  throw lastErr || new Error('SET_ACTIVITY failed');
}

async function applyActivity(activity) {
  const client = await ensureClient();
  if (!client) return false;
  await setActivitySafe(client, activity);
  return true;
}

async function flushPending(force = false) {
  const body = pendingBody || { idle: true };
  if (force) lastPayloadKey = '';
  return updateDiscordPresence(body);
}

let presenceTail = Promise.resolve();

async function applyPendingPresence() {
  const body = pendingBody || { idle: true };
  const activity = buildActivityPayload(body);
  const key = activityKey(activity, body.isPaused);
  if (key === lastPayloadKey && ready && rpc) {
    return { success: true };
  }

  const statePreview = String(activity.state || '').replace(/\n/g, ' | ');
  log(
    'setting presence:',
    activity.details,
    '/',
    statePreview,
    `type=${activity.type}`,
    body.isPaused ? 'paused' : 'playing',
  );
  const ok = await applyActivity(activity);
  if (!ok) {
    scheduleReconnect();
    return { success: false, error: 'Discord RPC not available' };
  }

  lastPayloadKey = key;
  return { success: true };
}

function updateDiscordPresence(body) {
  try {
    // Old website builds send { clear: true } and used to wipe status.
    if (body && body.clear && !body.idle) {
      log('ignoring clear from web — keeping idle browsing');
      body = { idle: true };
    }
    if (!body || body.idle) body = { idle: true };

    pendingBody = body;

    // Serialize SET_ACTIVITY so an early "Paused" can't finish after "Watching"
    const run = presenceTail.then(() => applyPendingPresence());
    presenceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((err) => {
      log('presence update failed:', err?.message || err);
      destroyClient('setActivity-failed');
      lastPayloadKey = '';
      scheduleReconnect();
      return { success: false, error: err?.message || String(err) };
    });
  } catch (err) {
    log('presence update failed:', err?.message || err);
    destroyClient('setActivity-failed');
    lastPayloadKey = '';
    scheduleReconnect();
    return Promise.resolve({
      success: false,
      error: err?.message || String(err),
    });
  }
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (ready && rpc) return;
    scheduleReconnect(500);
  }, 8000);

  // Re-assert presence periodically so Discord restarts / clears recover
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      if (!ready || !rpc || !pendingBody) return;
      lastPayloadKey = '';
      flushPending(true).catch(() => {});
    }, 20000);
  }
}

function startDiscordPresence(userDataPath) {
  if (userDataPath) setLogPath(userDataPath);
  startWatchdog();
  setTimeout(() => {
    updateDiscordPresence({ idle: true }).catch(() => {});
  }, 1200);
}

function shutdownDiscordPresence() {
  clearReconnectTimer();
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  pendingBody = null;
  lastPayloadKey = '';
  if (ready && rpc) {
    try {
      rpc.request('SET_ACTIVITY', { pid: process.pid }).catch(() => {});
    } catch {
      // ignore
    }
  }
  destroyClient('shutdown');
}

module.exports = {
  DISCORD_CLIENT_ID,
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
  setLogPath,
};
