'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 * Connects lazily only while watching — never on the home screen.
 */
const DISCORD_CLIENT_ID = '1536251834203770941';

/**
 * Optional Rich Presence art asset key (Discord Developer Portal → Art Assets).
 * Leave unset until an asset named "kstream" is uploaded.
 */
const LOGO_ASSET = process.env.KSTREAM_DISCORD_ASSET || '';

const MAX_CONNECT_ATTEMPTS = 8;

let rpc = null;
let ready = false;
let connectPromise = null;
let lastPayloadKey = '';
let pendingBody = null;
let retryTimer = null;
let connectAttempts = 0;
let registered = false;
let idleDisconnectTimer = null;

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function clearIdleDisconnect() {
  if (idleDisconnectTimer) {
    clearTimeout(idleDisconnectTimer);
    idleDisconnectTimer = null;
  }
}

function destroyClient() {
  clearRetryTimer();
  ready = false;
  const client = rpc;
  rpc = null;
  if (!client) return;
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
    console.warn(
      '[kstream-desktop] Discord RPC error (ignored):',
      err?.message || err,
    );
    ready = false;
    try {
      client.destroy();
    } catch {
      // ignore
    }
    if (rpc === client) rpc = null;
  });

  client.on('disconnected', () => {
    console.warn('[kstream-desktop] Discord RPC disconnected');
    ready = false;
    if (rpc === client) rpc = null;
  });
}

async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
    return null;
  }

  connectPromise = (async () => {
    connectAttempts += 1;
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const DiscordRPC = require('discord-rpc');
      if (!registered) {
        try {
          DiscordRPC.register(DISCORD_CLIENT_ID);
          registered = true;
        } catch (regErr) {
          console.warn(
            '[kstream-desktop] Discord register skipped:',
            regErr?.message || regErr,
          );
        }
      }

      destroyClient();
      rpc = new DiscordRPC.Client({ transport: 'ipc' });
      attachClientGuards(rpc);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Discord RPC connect timeout'));
        }, 4000);

        rpc.once('ready', () => {
          clearTimeout(timer);
          ready = true;
          connectAttempts = 0;
          console.log('[kstream-desktop] Discord Rich Presence connected');
          resolve();
        });

        rpc.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      clearRetryTimer();
      return rpc;
    } catch (err) {
      ready = false;
      destroyClient();
      console.warn(
        '[kstream-desktop] Discord RPC unavailable:',
        err?.message || err,
      );
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

function buildActivity(body) {
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

  if (body.isPaused && isShow) {
    state = `${state} · Paused`;
  }

  const activity = {
    details: title.slice(0, 128),
    state: state.slice(0, 128),
    instance: false,
    type: 3, // WATCHING
  };

  if (LOGO_ASSET) {
    activity.largeImageKey = LOGO_ASSET;
    activity.largeImageText = title.slice(0, 128);
    activity.smallImageKey = LOGO_ASSET;
    activity.smallImageText = body.isPaused ? 'Paused' : 'Playing';
  }

  if (!body.isPaused && typeof body.startTimestamp === 'number') {
    activity.startTimestamp = body.startTimestamp;
  }

  let watchUrl = 'https://kstream-one.vercel.app';
  if (typeof body.url === 'string' && body.url.startsWith('http')) {
    try {
      const parsed = new URL(body.url);
      watchUrl = `${parsed.origin}${parsed.pathname}`.slice(0, 512);
    } catch {
      // keep default
    }
  }

  activity.buttons = [
    {
      label: 'Watch on kstream',
      url: watchUrl,
    },
  ];

  return activity;
}

function activityKey(activity, isPaused) {
  return JSON.stringify({
    d: activity.details,
    s: activity.state,
    p: Boolean(isPaused),
    t: activity.startTimestamp
      ? Math.floor(activity.startTimestamp / 15000)
      : 0,
  });
}

async function applyActivity(activity) {
  const client = await ensureClient();
  if (!client) return false;

  try {
    await client.setActivity(activity);
    return true;
  } catch (setErr) {
    if (activity.buttons || activity.largeImageKey) {
      const fallback = {
        details: activity.details,
        state: activity.state,
        instance: false,
        type: 3,
      };
      if (activity.startTimestamp) {
        fallback.startTimestamp = activity.startTimestamp;
      }
      console.warn(
        '[kstream-desktop] setActivity failed, retrying without buttons/assets:',
        setErr?.message || setErr,
      );
      await client.setActivity(fallback);
      return true;
    }
    throw setErr;
  }
}

function scheduleConnectRetry() {
  if (retryTimer || connectAttempts >= MAX_CONNECT_ATTEMPTS) return;
  const delay = Math.min(30000, 2000 * 2 ** Math.min(connectAttempts, 4));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (ready && rpc) return;
    if (!pendingBody) return;
    ensureClient()
      .then((client) => {
        if (client) return flushPending();
        scheduleConnectRetry();
        return null;
      })
      .catch(() => scheduleConnectRetry());
  }, delay);
}

function scheduleIdleDisconnect() {
  clearIdleDisconnect();
  // Drop Discord IPC after leaving the player so home screen stays quiet
  idleDisconnectTimer = setTimeout(() => {
    idleDisconnectTimer = null;
    if (pendingBody) return;
    destroyClient();
    console.log('[kstream-desktop] Discord RPC idle disconnect');
  }, 15000);
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
      clearRetryTimer();
      if (ready && rpc) {
        try {
          await rpc.clearActivity();
        } catch {
          // ignore
        }
        console.log('[kstream-desktop] Discord presence cleared');
      }
      scheduleIdleDisconnect();
      return { success: true };
    }

    clearIdleDisconnect();
    pendingBody = body;
    // Fresh content can retry connecting again
    if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
      connectAttempts = Math.max(0, MAX_CONNECT_ATTEMPTS - 2);
    }

    const activity = buildActivity(body);
    const key = activityKey(activity, body.isPaused);
    if (key === lastPayloadKey && ready) {
      return { success: true };
    }

    const ok = await applyActivity(activity);
    if (!ok) {
      scheduleConnectRetry();
      return { success: false, error: 'Discord not available' };
    }

    lastPayloadKey = key;
    console.log(
      '[kstream-desktop] Discord presence set:',
      activity.details,
      '/',
      activity.state,
    );
    return { success: true };
  } catch (err) {
    console.warn(
      '[kstream-desktop] Discord presence update failed:',
      err?.message || err,
    );
    destroyClient();
    lastPayloadKey = '';
    scheduleConnectRetry();
    return { success: false, error: err?.message || String(err) };
  }
}

async function flushPending() {
  if (!pendingBody) return;
  const body = pendingBody;
  lastPayloadKey = '';
  await updateDiscordPresence(body);
}

/**
 * No-op at boot on purpose. Discord only connects when the player sends metadata.
 * Kept so main.js can call it safely.
 */
function startDiscordPresence() {
  // intentionally empty — lazy connect via updateDiscordPresence
}

function shutdownDiscordPresence() {
  clearRetryTimer();
  clearIdleDisconnect();
  pendingBody = null;
  lastPayloadKey = '';
  destroyClient();
}

module.exports = {
  DISCORD_CLIENT_ID,
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
};
