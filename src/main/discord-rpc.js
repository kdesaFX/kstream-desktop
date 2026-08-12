'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 *
 * Keep this simple: one IPC connection (never probe multiple pipes with the
 * same app id — Discord drops the first session). Prefer real Discord over
 * Vesktop arRPC, but fall back to arRPC if it's all we have.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const DISCORD_CLIENT_ID = '1536251834203770941';
const WATCH_URL = 'https://kdesa.stream';
/** Small badge on the poster (Crunchyroll-style). External URL — no portal upload needed. */
const LOGO_IMAGE_URL =
  process.env.KSTREAM_DISCORD_LOGO_URL ||
  'https://kdesa.stream/apple-touch-icon.png';
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
/** One session clock for Discord's elapsed timer (browsing → watching). */
let sessionStartedAt = null;

function ensureSessionStart() {
  if (!sessionStartedAt) sessionStartedAt = Date.now();
  return sessionStartedAt;
}

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
    }, 12000);

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
 * Prefer real Discord. Fall back to Vesktop arRPC if that's the only pipe
 * answering — better than no presence at all.
 *
 * IMPORTANT: never hold two IPC sessions with the same Client ID at once
 * (that makes Discord drop the activity). Destroy arRPC before probing others.
 */
async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      if (rpc) destroyClient('reconnect');

      let sawArrpc = false;

      // Try non-zero pipes first (official Discord), then ipc-0 (often Vesktop)
      const order = [1, 2, 3, 4, 0];

      for (const skip of order) {
        ipcPipeSkip = skip;
        try {
          const client = await loginOnce();
          const who = (client.user?.username || '').toString();
          const globalName = (client.user?.global_name || '').toString();
          log(
            'connected as',
            who || '?',
            globalName ? `(${globalName})` : '',
            `ipc=${skip}`,
          );

          if (who.toLowerCase() === 'arrpc') {
            sawArrpc = true;
            log('skipping arRPC (will fall back if Discord missing)');
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

      if (sawArrpc) {
        ipcPipeSkip = 0;
        try {
          const client = await loginOnce();
          log('using arRPC fallback (official Discord IPC unavailable)');
          rpc = client;
          ready = true;
          clearReconnectTimer();
          return rpc;
        } catch (err) {
          log('arRPC fallback failed:', err?.message || err);
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

/**
 * Use Playing (0), not Watching (3). Discord's profile lists detected games
 * (Valorant, etc.) above Watching/Listening cards no matter how new they are.
 * Playing puts kstream in the same bucket so a created_at re-stamp can sit on top.
 */
const ACTIVITY_TYPE_PLAYING = 0;

function buildIdleActivity() {
  return {
    type: ACTIVITY_TYPE_PLAYING,
    details: 'Browsing',
    state: 'Looking for something to watch',
    instance: false,
    timestamps: { start: ensureSessionStart() },
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

function formatEpisodeLabel(body) {
  const season = Number(body.seasonNumber);
  const episode = Number(body.episodeNumber);
  if (
    !Number.isFinite(season) ||
    !Number.isFinite(episode) ||
    season <= 0 ||
    episode <= 0
  ) {
    return '';
  }
  return `S${Math.floor(season)}EP${Math.floor(episode)}`;
}

function buildActivityPayload(body) {
  if (body?.idle) return buildIdleActivity();

  const title = (body.title || 'Something').trim();
  const episodeLabel = formatEpisodeLabel(body);
  // Shows → S3EP9; movies → July 2026. Keep one session start so the
  // Discord elapsed timer does not reset when leaving idle browsing.
  const state = episodeLabel || formatReleaseLabel(body) || ' ';

  const activity = {
    type: ACTIVITY_TYPE_PLAYING,
    details: title.slice(0, 128),
    state: String(state).slice(0, 128),
    instance: false,
    timestamps: { start: ensureSessionStart() },
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
  // Always send a real start time (never null — that hid the card). Reuse
  // one session clock so browsing → watching does not reset Discord's timer.
  const base = {
    ...activity,
    timestamps: { start: ensureSessionStart() },
  };

  const attempts = [
    base,
    (() => {
      const a = { ...base };
      delete a.buttons;
      return a;
    })(),
    (() => {
      const a = { ...base };
      delete a.buttons;
      if (a.assets) {
        a.assets = {
          large_image: a.assets.large_image,
          large_text: a.assets.large_text,
        };
      }
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

/**
 * Discord sorts profile activities by created_at (newest first). Games like
 * Valorant get a fresh created_at when they launch and jump above kstream.
 * In-place SET_ACTIVITY does not bump that timestamp — clear then re-set does.
 */
async function clearActivity(client) {
  try {
    await client.request('SET_ACTIVITY', { pid: process.pid });
  } catch (err) {
    log('clear activity:', err?.message || err);
  }
}

async function rebroadcastPresence() {
  const client = rpc;
  if (!client || !ready || !pendingBody) return;
  await clearActivity(client);
  // Let Discord drop the old activity so the next set gets a new created_at.
  await new Promise((resolve) => setTimeout(resolve, 75));
  if (rpc !== client || !ready) return;
  lastPayloadKey = '';
  await applyPendingPresence();
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

  log(
    'setting presence:',
    activity.details,
    '/',
    activity.state,
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

  if (!refreshTimer) {
    // Re-stamp often enough that a game launched after kstream cannot stay on top.
    refreshTimer = setInterval(() => {
      if (!ready || !rpc || !pendingBody) return;
      presenceTail = presenceTail
        .then(() => rebroadcastPresence())
        .then(
          () => undefined,
          () => undefined,
        );
    }, 5000);
  }
}

function startDiscordPresence(userDataPath) {
  if (userDataPath) setLogPath(userDataPath);
  ensureSessionStart();
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
  sessionStartedAt = null;
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
