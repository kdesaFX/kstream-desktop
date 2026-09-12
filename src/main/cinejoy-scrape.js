'use strict';

/**
 * Cinejoy scrape in Node (desktop main). Renderer/Electron net.request
 * cannot POST the encrypted /g body; this path already returns playlists.
 */

const SITE = 'https://cinejoy.to';
const API = 'https://api.shegu.st';
const ENC = 'https://enc-dec.app/api';
const FALLBACK_SERVERS = ['Lisbon', 'Nebula', 'Solara'];
const RACE_MS = 20000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const API_HEADERS = {
  Accept: '*/*',
  Origin: SITE,
  Referer: `${SITE}/`,
  'User-Agent': UA,
};

const STREAM_HEADERS = {
  Referer: `${SITE}/`,
  Origin: SITE,
  'User-Agent': UA,
};

function b64UrlToBytes(token) {
  let b64 = String(token).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

function bytesToB64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, redirect: 'follow' });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}

async function scrapeServer(media, server) {
  const show = media.type === 'show';
  const params = [
    `title=${encodeURIComponent(media.title || '')}`,
    `type=${show ? 'series' : 'movie'}`,
    `year=${media.releaseYear || ''}`,
    `imdb=${media.imdbId || ''}`,
    `tmdb=${media.tmdbId || ''}`,
    `server=${encodeURIComponent(server)}`,
  ];
  if (show) {
    params.push(
      `season=${media.season?.number || media.seasonNumber || ''}`,
      `episode=${media.episode?.number || media.episodeNumber || ''}`,
    );
  }
  const sheguUrl = `${API}/?${params.join('&')}`;
  const encUrl = `${ENC}/enc-cinejoy?url=${encodeURIComponent(sheguUrl)}`;
  const enc = await fetchJson(encUrl, { headers: { 'User-Agent': UA } });
  if (enc.status !== 200 || enc.json?.status !== 200 || !enc.json?.result?.data || !enc.json.result.state) {
    return null;
  }

  const payload = b64UrlToBytes(enc.json.result.data);
  const gate = await fetch(`${API}/g`, {
    method: 'POST',
    headers: API_HEADERS,
    body: payload,
    redirect: 'follow',
  });
  if (gate.status < 200 || gate.status >= 400) return null;
  const bytes = Buffer.from(await gate.arrayBuffer());
  if (bytes.length < 8) return null;

  const dec = await fetchJson(`${ENC}/dec-cinejoy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      text: bytesToB64Url(bytes),
      state: enc.json.result.state,
    }),
  });
  const stream = dec.json?.result?.data?.stream?.[0];
  const playlist = stream?.playlist || stream?.url;
  if (!playlist || !/^https?:\/\//i.test(playlist)) return null;

  const captions = [];
  for (const item of stream?.captions || []) {
    const url = item.url || item.file;
    if (url) captions.push({ id: url, url, type: url.endsWith('.vtt') ? 'vtt' : 'srt', language: 'en', hasCorsRestrictions: false });
  }

  const isHls = playlist.includes('.m3u8') || stream?.type === 'hls';
  if (isHls) {
    return {
      id: 'primary',
      type: 'hls',
      playlist,
      captions,
      flags: ['ip-locked'],
      headers: STREAM_HEADERS,
      preferredHeaders: STREAM_HEADERS,
      skipValidation: true,
    };
  }
  return {
    id: 'primary',
    type: 'file',
    qualities: { unknown: { type: 'mp4', url: playlist } },
    captions,
    flags: ['ip-locked'],
    headers: STREAM_HEADERS,
    preferredHeaders: STREAM_HEADERS,
    skipValidation: true,
  };
}

function raceFirst(jobs, ms) {
  const anyHit = Promise.any(
    jobs.map(async (job) => {
      const hit = await job;
      if (!hit) throw new Error('empty');
      return hit;
    }),
  ).catch(() => null);
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
  return Promise.race([anyHit, timeout]);
}

async function scrapeCinejoy(media) {
  if (!media?.tmdbId) return null;
  const listing = await fetchJson(`${API}/servers`, { headers: API_HEADERS });
  const ranked = (listing.json?.servers || [])
    .filter((s) => s.status === 'ok' && s.name)
    .sort((a, b) => Number(!!b['4k']) - Number(!!a['4k']))
    .slice(0, 3)
    .map((s) => s.name);
  const servers = ranked.length ? ranked : FALLBACK_SERVERS;
  return raceFirst(
    servers.map((name) => scrapeServer(media, name)),
    RACE_MS,
  );
}

module.exports = { scrapeCinejoy };
