'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 * Uses raw SET_ACTIVITY so Watching (type 3) is actually sent —
 * discord-rpc's setActivity() drops the type field.
 *
 * Buttons: Discord only shows them to OTHER users, never on your own profile.
 */
const fs = require('fs');
const path = require('path');

const DISCORD_CLIENT_ID = '1536251834203770941';
const LOGO_ASSET = process.env.KSTREAM_DISCORD_ASSET || '';
const WATCH_URL = 'https://kdesa.stream';

const PRESENCE_BUTTONS = [
  {
    label: 'Watch on kstream',
    url: WATCH_URL,
  },
];

function withButtons(activity) {
  return {
    ...activity,
    buttons: PRESENCE_BUTTONS,
  };
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
    log('RPC disconnected (Discord likely restarted)');
    ready = false;
    if (rpc === client) rpc = null;
    scheduleReconnect(1500);
  });
}

async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
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

      if (rpc) destroyClient('reconnect');
      rpc = new DiscordRPC.Client({ transport: 'ipc' });
      attachClientGuards(rpc);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Discord RPC connect timeout'));
        }, 6000);

        rpc.once('ready', () => {
          clearTimeout(timer);
          ready = true;
          clearReconnectTimer();
          const who = rpc?.user?.username || rpc?.user?.id || 'unknown';
          log('connected as', who);
          resolve();
        });

        rpc.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      return rpc;
    } catch (err) {
      ready = false;
      destroyClient('connect-failed');
      log('unavailable:', err?.message || err);
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

function buildIdleActivity() {
  return withButtons({
    type: 3,
    details: 'Browsing',
    state: 'Looking for something to watch',
    instance: false,
  });
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

  let state;
  if (isShow) {
    const epBit = `S${seasonNumber} E${episodeNumber}`;
    state = episodeTitle ? `${epBit}: ${episodeTitle}` : epBit;
  } else {
    state = body.isPaused ? 'Paused' : 'Watching';
  }
  if (body.isPaused && isShow) state = `${state} · Paused`;

  const activity = {
    type: 3,
    details: title.slice(0, 128),
    state: state.slice(0, 128),
    instance: false,
  };

  if (!body.isPaused && typeof body.startTimestamp === 'number') {
    activity.timestamps = {
      start: Math.round(body.startTimestamp),
    };
  }

  if (LOGO_ASSET) {
    activity.assets = {
      large_image: LOGO_ASSET,
      large_text: title.slice(0, 128),
    };
  }

  return withButtons(activity);
}

function activityKey(activity, isPaused) {
  return JSON.stringify({
    d: activity.details,
    s: activity.state,
    p: Boolean(isPaused),
    t: activity.timestamps?.start
      ? Math.floor(activity.timestamps.start / 15000)
      : 0,
  });
}

async function applyActivity(activity) {
  const client = await ensureClient();
  if (!client) return false;

  const pid = process.pid;
  try {
    await client.request('SET_ACTIVITY', {
      pid,
      activity,
    });
    log('SET_ACTIVITY ok pid=', String(pid), 'type=', String(activity.type));
    return true;
  } catch (err) {
    if (activity.buttons) {
      const { buttons, ...bare } = activity;
      log(
        'SET_ACTIVITY with buttons failed, retrying bare:',
        err?.message || err,
      );
      await client.request('SET_ACTIVITY', { pid, activity: bare });
      log('SET_ACTIVITY ok (no buttons)');
      return true;
    }
    throw err;
  }
}

async function flushPending(force = false) {
  const body = pendingBody || { idle: true };
  if (force) lastPayloadKey = '';
  return updateDiscordPresence(body);
}

/**
 * @param {object|null} body
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function updateDiscordPresence(body) {
  try {
    if (body && body.clear && !body.idle) {
      pendingBody = { idle: true };
      lastPayloadKey = '';
      if (ready && rpc) {
        try {
          await rpc.request('SET_ACTIVITY', { pid: process.pid });
          log('presence cleared');
        } catch (err) {
          log('clear failed:', err?.message || err);
        }
      }
      return { success: true };
    }

    if (!body || body.idle) {
      body = { idle: true };
    }

    pendingBody = body;
    const activity = buildActivityPayload(body);
    const key = activityKey(activity, body.isPaused);
    if (key === lastPayloadKey && ready && rpc) {
      return { success: true };
    }

    log('setting presence:', activity.details, '/', activity.state);
    const ok = await applyActivity(activity);
    if (!ok) {
      scheduleReconnect();
      return { success: false, error: 'Discord RPC not available' };
    }

    lastPayloadKey = key;
    log('presence set ok');
    return { success: true };
  } catch (err) {
    log('presence update failed:', err?.message || err);
    destroyClient('setActivity-failed');
    lastPayloadKey = '';
    scheduleReconnect();
    return { success: false, error: err?.message || String(err) };
  }
}

function startWatchdog() {
  if (watchdogTimer) return;
  // If Discord was restarted while kstream stayed open, reconnect + re-apply
  watchdogTimer = setInterval(() => {
    if (ready && rpc) return;
    scheduleReconnect(500);
  }, 8000);
}

function startDiscordPresence(userDataPath) {
  if (userDataPath) setLogPath(userDataPath);
  startWatchdog();
  setTimeout(() => {
    updateDiscordPresence({ idle: true }).catch(() => {});
  }, 1500);
}

function shutdownDiscordPresence() {
  clearReconnectTimer();
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
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
