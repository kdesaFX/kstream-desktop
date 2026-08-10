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
let connecting = false;
let lastPayloadKey = '';
let connectPromise = null;

async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    connecting = true;
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const DiscordRPC = require('discord-rpc');
      DiscordRPC.register(DISCORD_CLIENT_ID);
      rpc = new DiscordRPC.Client({ transport: 'ipc' });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Discord RPC connect timeout'));
        }, 8000);

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
      connecting = false;
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

  // Default activity type is Playing (0). Watching (3) shows "Watching kstream".
  const activity = {
    details: title.slice(0, 128),
    state: state.slice(0, 128),
    instance: false,
    type: 3,
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

  // Prefer a short stable URL — long player URLs can break button validation.
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

/**
 * @param {object|null} body
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function updateDiscordPresence(body) {
  try {
    if (!body || body.clear) {
      lastPayloadKey = '';
      if (ready && rpc) {
        await rpc.clearActivity();
        console.log('[kstream-desktop] Discord presence cleared');
      }
      return { success: true };
    }

    const activity = buildActivity(body);
    const key = JSON.stringify({
      d: activity.details,
      s: activity.state,
      p: Boolean(body.isPaused),
      t: activity.startTimestamp || 0,
    });
    if (key === lastPayloadKey) return { success: true };
    lastPayloadKey = key;

    const client = await ensureClient();
    if (!client) {
      lastPayloadKey = '';
      return { success: false, error: 'Discord not available' };
    }

    try {
      await client.setActivity(activity);
    } catch (setErr) {
      // Buttons / assets sometimes rejected — retry bare text presence
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
      } else {
        throw setErr;
      }
    }
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
    return { success: false, error: err?.message || String(err) };
  }
}

/** Warm the Discord IPC connection shortly after launch. */
function startDiscordPresence() {
  setTimeout(() => {
    ensureClient()
      .then(async (client) => {
        if (!client) return;
        // Dev/smoke: prove RPC works even before the player sends metadata
        if (!appIsPackaged()) {
          try {
            await client.setActivity({
              details: 'kstream',
              state: 'Ready to watch',
              instance: false,
              type: 3,
            });
            console.log('[kstream-desktop] Discord idle presence set (dev)');
          } catch (err) {
            console.warn(
              '[kstream-desktop] Discord idle presence failed:',
              err?.message || err,
            );
          }
        }
      })
      .catch(() => {});
  }, 2500);
}

function appIsPackaged() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return Boolean(app?.isPackaged);
  } catch {
    return true;
  }
}

function shutdownDiscordPresence() {
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
