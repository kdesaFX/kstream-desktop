'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 * Client Application ID from Discord Developer Portal.
 */
const DISCORD_CLIENT_ID = '1536251834203770941';

/**
 * Optional Rich Presence art asset key (Discord Developer Portal → Art Assets).
 * Leave unset until an asset named "kstream" is uploaded — invalid keys can
 * cause setActivity to fail silently.
 */
const LOGO_ASSET = process.env.KSTREAM_DISCORD_ASSET || '';

let rpc = null;
let ready = false;
let connectPromise = null;
let lastPayloadKey = '';
let pendingBody = null;
let retryTimer = null;

function clearRetryTimer() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const DiscordRPC = require('discord-rpc');
      DiscordRPC.register(DISCORD_CLIENT_ID);
      rpc = new DiscordRPC.Client({ transport: 'ipc' });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Discord RPC connect timeout'));
        }, 5000);

        rpc.once('ready', () => {
          clearTimeout(timer);
          ready = true;
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
      try {
        if (rpc) rpc.destroy();
      } catch {
        // ignore
      }
      rpc = null;
      console.warn(
        '[kstream-desktop] Discord RPC unavailable (is Discord open?):',
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
    // Bucket elapsed so tiny clock drift does not spam Discord
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
        await rpc.clearActivity();
        console.log('[kstream-desktop] Discord presence cleared');
      }
      return { success: true };
    }

    pendingBody = body;
    const activity = buildActivity(body);
    const key = activityKey(activity, body.isPaused);
    if (key === lastPayloadKey && ready) {
      return { success: true };
    }

    const ok = await applyActivity(activity);
    if (!ok) {
      // Keep pendingBody; connection retry will flush it
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
    ready = false;
    try {
      if (rpc) rpc.destroy();
    } catch {
      // ignore
    }
    rpc = null;
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

function scheduleConnectRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (ready && rpc) {
      clearRetryTimer();
      return;
    }
    ensureClient()
      .then((client) => {
        if (client) return flushPending();
        return null;
      })
      .catch(() => {});
  }, 3000);
}

/** Connect to Discord as soon as the app is ready; retry until it works. */
function startDiscordPresence() {
  ensureClient()
    .then((client) => {
      if (!client) scheduleConnectRetry();
    })
    .catch(() => scheduleConnectRetry());
}

function shutdownDiscordPresence() {
  clearRetryTimer();
  pendingBody = null;
  lastPayloadKey = '';
  ready = false;
  try {
    if (rpc) {
      rpc.clearActivity().catch(() => {});
      rpc.destroy();
    }
  } catch {
    // ignore
  }
  rpc = null;
}

module.exports = {
  DISCORD_CLIENT_ID,
  updateDiscordPresence,
  startDiscordPresence,
  shutdownDiscordPresence,
};
