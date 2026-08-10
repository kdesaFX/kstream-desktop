'use strict';

/**
 * Discord Rich Presence for kstream desktop.
 * Client Application ID from Discord Developer Portal.
 */
const DISCORD_CLIENT_ID = '1536251834203770941';

/** Fallback art asset key — upload as Rich Presence asset named "kstream". */
const LOGO_ASSET = 'kstream';

let rpc = null;
let ready = false;
let connecting = false;
let lastPayloadKey = '';

async function ensureClient() {
  if (ready && rpc) return rpc;
  if (connecting) {
    // Wait briefly for in-flight login
    for (let i = 0; i < 20 && connecting; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    if (ready && rpc) return rpc;
  }

  connecting = true;
  try {
    // Lazy require so missing Discord / package doesn't break app boot
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
    rpc = null;
    console.warn(
      '[kstream-desktop] Discord RPC unavailable (is Discord open?):',
      err?.message || err,
    );
    return null;
  } finally {
    connecting = false;
  }
}

function buildActivity(body) {
  const title = (body.title || 'Something').trim();
  const episodeTitle = (body.episodeTitle || '').trim();
  const seasonNumber = body.seasonNumber;
  const episodeNumber = body.episodeNumber;
  const isShow =
    Number.isFinite(seasonNumber) &&
    Number.isFinite(episodeNumber) &&
    seasonNumber > 0 &&
    episodeNumber > 0;

  const details = title;
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

  // Discord classic RPC only accepts uploaded Rich Presence asset keys
  // (not arbitrary URLs). Upload an asset named "kstream" in the portal.
  const activity = {
    details: details.slice(0, 128),
    state: state.slice(0, 128),
    largeImageKey: LOGO_ASSET,
    largeImageText: title.slice(0, 128),
    smallImageKey: LOGO_ASSET,
    smallImageText: body.isPaused ? 'Paused' : 'Playing',
    instance: false,
    type: 3, // WATCHING
  };

  if (!body.isPaused && typeof body.startTimestamp === 'number') {
    activity.startTimestamp = body.startTimestamp;
  }

  const watchUrl =
    typeof body.url === 'string' && body.url.startsWith('http')
      ? body.url
      : 'https://kstream-one.vercel.app';

  activity.buttons = [
    {
      label: 'Watch on kstream',
      url: watchUrl.slice(0, 512),
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
      }
      return { success: true };
    }

    const activity = buildActivity(body);
    const key = JSON.stringify({
      d: activity.details,
      s: activity.state,
      p: body.isPaused,
      t: activity.startTimestamp || 0,
    });
    if (key === lastPayloadKey) return { success: true };
    lastPayloadKey = key;

    const client = await ensureClient();
    if (!client) {
      return { success: false, error: 'Discord not available' };
    }

    await client.setActivity(activity);
    return { success: true };
  } catch (err) {
    console.warn('[kstream-desktop] Discord presence update failed:', err?.message || err);
    // Force reconnect next time
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
  shutdownDiscordPresence,
};
