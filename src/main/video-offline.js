'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

let libraryRoot = null;
/** @type {Map<string, { process: import('child_process').ChildProcess, meta: object }>} */
const activeDownloads = new Map();

function resolveFfmpegPath() {
  try {
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return 'ffmpeg';
  }
}

function initVideoOffline(userDataPath) {
  libraryRoot = path.join(userDataPath, 'video-library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  console.log('[kstream-desktop] Video offline library at', libraryRoot);
}

function downloadDir(id) {
  return path.join(libraryRoot, id);
}

function metaPath(id) {
  return path.join(downloadDir(id), 'meta.json');
}

function videoPath(id) {
  return path.join(downloadDir(id), 'video.mp4');
}

function readMeta(id) {
  const file = metaPath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(id, meta) {
  fs.mkdirSync(downloadDir(id), { recursive: true });
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
}

function listDownloads() {
  if (!libraryRoot || !fs.existsSync(libraryRoot)) return [];
  return fs
    .readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readMeta(entry.name))
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || b.startedAt || 0) - (a.savedAt || a.startedAt || 0));
}

function fetchBuffer(url, headers = {}, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    let lib;
    let reqUrl;
    try {
      reqUrl = new URL(url);
      lib = reqUrl.protocol === 'https:' ? https : http;
    } catch (err) {
      reject(err);
      return;
    }

    const req = lib.request(
      reqUrl,
      { method: 'GET', headers, timeout },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchBuffer(res.headers.location, headers, timeout).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 'error'}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Download timed out'));
    });
    req.end();
  });
}

function buildHeaderArg(headers) {
  if (!headers || !Object.keys(headers).length) return null;
  return (
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n') + '\r\n'
  );
}

function isHlsUrl(url) {
  return /\.m3u8(\?|$)/i.test(url) || url.includes('m3u8');
}

function runFfmpegDownload(id, url, headers, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats'];
    const headerArg = buildHeaderArg(headers);
    if (headerArg) args.push('-headers', headerArg);
    args.push(
      '-i',
      url,
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    );

    const proc = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    activeDownloads.set(id, { process: proc, meta: readMeta(id) });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      activeDownloads.delete(id);
      reject(err);
    });

    proc.on('close', (code) => {
      activeDownloads.delete(id);
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function downloadDirectFile(id, url, headers, outputPath) {
  const buf = await fetchBuffer(url, headers);
  fs.writeFileSync(outputPath, buf);
}

async function startVideoDownload(body) {
  if (!libraryRoot) throw new Error('Video offline library is not ready');

  const url = body?.url;
  const title = String(body?.title || 'Download').trim();
  if (!url) throw new Error('Missing stream URL');

  const id = crypto.randomBytes(8).toString('hex');
  const output = videoPath(id);
  const headers = body?.headers && typeof body.headers === 'object' ? body.headers : {};
  const meta = {
    id,
    title,
    poster: body?.poster || null,
    mediaType: body?.type || body?.mediaType || 'movie',
    seasonNumber: body?.seasonNumber ?? null,
    episodeNumber: body?.episodeNumber ?? null,
    sourceType: isHlsUrl(url) ? 'hls' : 'file',
    status: 'downloading',
    progress: 0,
    error: null,
    startedAt: Date.now(),
    savedAt: null,
    playbackUrl: null,
  };
  writeMeta(id, meta);

  void (async () => {
    try {
      if (meta.sourceType === 'hls') {
        await runFfmpegDownload(id, url, headers, output);
      } else {
        await downloadDirectFile(id, url, headers, output);
      }
      const stat = fs.statSync(output);
      const next = {
        ...readMeta(id),
        status: 'ready',
        progress: 1,
        savedAt: Date.now(),
        fileSize: stat.size,
        error: null,
      };
      writeMeta(id, next);
    } catch (err) {
      const next = {
        ...readMeta(id),
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      writeMeta(id, next);
      try {
        if (fs.existsSync(output)) fs.unlinkSync(output);
      } catch {
        /* ignore */
      }
    }
  })();

  return { ok: true, id };
}

function getPlaybackUrl(id, origin) {
  const meta = readMeta(id);
  if (!meta || meta.status !== 'ready') return null;
  if (!fs.existsSync(videoPath(id))) return null;
  return `${origin}/api/offline-video/${id}/video.mp4`;
}

function serveOfflineVideo(req, res, requestUrl) {
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'offline-video') {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }

  const id = parts[2];
  const file = parts[3];
  if (!id || file !== 'video.mp4' || id.includes('..')) {
    sendJson(res, { error: 'Forbidden' }, 403);
    return;
  }

  const filePath = videoPath(id);
  if (!fs.existsSync(filePath)) {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        ...corsHeaders(),
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    ...corsHeaders(),
  });
  fs.createReadStream(filePath).pipe(res);
}

function deleteDownload(id) {
  const active = activeDownloads.get(id);
  if (active?.process && !active.process.killed) {
    active.process.kill('SIGTERM');
    activeDownloads.delete(id);
  }
  const dir = downloadDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: true };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

module.exports = {
  initVideoOffline,
  startVideoDownload,
  listDownloads,
  readMeta,
  getPlaybackUrl,
  serveOfflineVideo,
  deleteDownload,
};
