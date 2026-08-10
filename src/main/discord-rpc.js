'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 * Uses raw SET_ACTIVITY so Watching (type 3) is actually sent —
 * discord-rpc's setActivity() drops the type field.
 */
const fs = require('fs');
const path = require('path');

const DISCORD_CLIENT_ID = '1536251834203770941';
const LOGO_ASSET = process.env.KSTREAM_DISCORD_ASSET || '';

let rpc = null;
let ready = false;
let connectPromise = null;
let lastPayloadKey = '';
let pendingBody = null;
let registered = false;
let logPath = null;

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

function attachClientGuards(client) {
  client.on('error', (err) => {
    log('RPC error (kept):', err?.message || String(err));
  });

  client.on('disconnected', () => {
    log('RPC disconnected');
    ready = false;
    if (rpc === client) rpc = null;
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

function buildActivityPayload(body) {
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

  // Discord Activity object — include type explicitly (Watching = 3)
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

  return activity;
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

/**
 * Bypass discord-rpc setActivity() which silently drops `type`.
 */
async function applyActivity(activity) {
  const client = await ensureClient();
  if (!client) return false;

  const pid = process.pid;
  const result = await client.request('SET_ACTIVITY', {
    pid,
    activity,
  });
  log('SET_ACTIVITY ok pid=', String(pid), 'type=', String(activity.type));
  return result !== undefined || true;
}

/**
 * @param {object|null} body
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function updateDiscordPresence(body) {
  try {
    if (!body || body.clear) {
      pendingBody = null;
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

    pendingBody = body;
    const activity = buildActivityPayload(body);
    const key = activityKey(activity, body.isPaused);
    if (key === lastPayloadKey && ready && rpc) {
      return { success: true };
    }

    log('setting presence:', activity.details, '/', activity.state);
    const ok = await applyActivity(activity);
    if (!ok) {
      return { success: false, error: 'Discord RPC not available' };
    }

    lastPayloadKey = key;
    log('presence set ok');
    return { success: true };
  } catch (err) {
    log('presence update failed:', err?.message || err);
    destroyClient('setActivity-failed');
    lastPayloadKey = '';
    try {
      const activity = buildActivityPayload(body);
      const ok = await applyActivity(activity);
      if (ok) {
        lastPayloadKey = activityKey(activity, body.isPaused);
        log('presence set ok after retry');
        return { success: true };
      }
    } catch (retryErr) {
      log('retry failed:', retryErr?.message || retryErr);
    }
    return { success: false, error: err?.message || String(err) };
  }
}

function startDiscordPresence(userDataPath) {
  if (userDataPath) setLogPath(userDataPath);
}

function shutdownDiscordPresence() {
  pendingBody = null;
  lastPayloadKey = '';
  destroyClient('shutdown');
}

module.exports = {
  DISCORD_CLIENT_ID,
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
  setLogPath,
};
