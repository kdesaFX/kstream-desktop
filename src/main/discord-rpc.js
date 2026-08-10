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

function buildActivityPayload(body) {
  if (body?.idle) return buildIdleActivity();

  const title = (body.title || 'Something').trim();
  const episodeTitle = (body.episodeTitle || '').trim();
  const seasonNumber = Number(body.seasonNumber);
  const episodeNumber = Number(body.episodeNumber);
  const isShow =
    Number.isFinite(seasonNumber) &&
    Number.isFinite(episodeNumber) &&
    seasonNumber > 0 &&
    episodeNumber > 0;
  const isPaused = Boolean(body.isPaused);

  let state;
  if (isShow) {
    const seasonLine = `Season ${seasonNumber}, Episode ${episodeNumber}`;
    state = episodeTitle
      ? `${episodeTitle.slice(0, 80)} — ${seasonLine}`.slice(0, 128)
      : seasonLine;
  } else {
    state = 'Watching';
  }

  // Resolve playback window (needed playing AND paused — paused freezes the bar)
  let start =
    typeof body.startTimestamp === 'number'
      ? Math.round(body.startTimestamp)
      : null;
  let end =
    typeof body.endTimestamp === 'number'
      ? Math.round(body.endTimestamp)
      : null;
  const durationMs =
    typeof body.durationSec === 'number' && body.durationSec > 0
      ? Math.round(body.durationSec * 1000)
      : start != null && end != null && end > start
        ? end - start
        : 0;

  if (durationMs > 0) {
    if (start == null) start = Date.now();
    if (end == null || end <= start) end = start + durationMs;
  }

  // Spotify-style bar only renders for Listening (type 2) with BOTH timestamps.
  const hasProgressBar = start != null && end != null && end > start;

  const activity = {
    type: hasProgressBar ? 2 : 3,
    details: title.slice(0, 128),
    state: String(state).slice(0, 128),
    instance: false,
    buttons: [{ label: 'Watch now on kstream', url: WATCH_URL }],
  };

  if (hasProgressBar) {
    activity.timestamps = { start, end };
  } else if (!isPaused && start != null) {
    activity.timestamps = { start };
  } else if (!isPaused) {
    activity.timestamps = { start: Date.now() };
  }

  // Poster large + kstream logo small (Crunchyroll layout)
  const poster = normalizePosterUrl(body.poster);
  if (poster) {
    activity.assets = {
      large_image: poster,
      large_text: (episodeTitle || title).slice(0, 128),
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
    t: activity.timestamps?.start
      ? Math.floor(activity.timestamps.start / 15000)
      : 0,
    e: activity.timestamps?.end
      ? Math.floor(activity.timestamps.end / 15000)
      : 0,
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

    const ts = activity.timestamps;
    log(
      'setting presence:',
      activity.details,
      '/',
      activity.state,
      `type=${activity.type}`,
      ts?.start && ts?.end
        ? `bar ${Math.round((Date.now() - ts.start) / 1000)}s/${Math.round((ts.end - ts.start) / 1000)}s`
        : ts?.start
          ? 'elapsed-only'
          : 'no-timer',
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
