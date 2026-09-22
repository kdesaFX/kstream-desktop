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
  let bin = 'ffmpeg';
  try {
    bin = require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    /* fall through to PATH */
  }
  if (bin.includes(`${path.sep}app.asar${path.sep}`)) {
    bin = bin.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
  }
  if (bin !== 'ffmpeg' && !fs.existsSync(bin)) {
    const err = new Error(
      'ffmpeg is missing from this desktop build. Update kstream to download HLS offline.',
    );
    err.code = 'ENOENT';
    throw err;
  }
  return bin;
}

function parseClockToSeconds(clock) {
  const parts = String(clock).trim().split(':');
  if (parts.length < 2) return 0;
  const sec = Number(parts.pop());
  const min = Number(parts.pop() || 0);
  const hr = Number(parts.pop() || 0);
  if (![hr, min, sec].every((n) => Number.isFinite(n))) return 0;
  return hr * 3600 + min * 60 + sec;
}

function updateDownloadProgress(id, ratio) {
  const current = readMeta(id);
  if (!current || current.status !== 'downloading') return;
  const next = Math.max(0, Math.min(0.99, Number(ratio) || 0));
  if (Math.abs((current.progress || 0) - next) < 0.01) return;
  writeMeta(id, { ...current, progress: next });
}

function initVideoOffline(userDataPath) {
  libraryRoot = path.join(userDataPath, 'video-library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  recoverInterruptedDownloads();
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
  const target = metaPath(id);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2));
  fs.renameSync(temp, target);
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

function recoverInterruptedDownloads() {
  if (!libraryRoot || !fs.existsSync(libraryRoot)) return;
  for (const entry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readMeta(entry.name);
    if (!meta || meta.status !== 'downloading') continue;
    writeMeta(entry.name, {
      ...meta,
      status: 'error',
      error: 'Download interrupted. Try again.',
    });
    try {
      fs.rmSync(path.join(downloadDir(entry.name), 'video.mp4.part'), {
        force: true,
      });
    } catch {
      // Ignore stale temporary files that are already gone.
    }
  }
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

function runFfmpegAttempt(id, url, headers, outputPath) {
  return new Promise((resolve, reject) => {
    let ffmpegBin;
    try {
      ffmpegBin = resolveFfmpegPath();
    } catch (err) {
      reject(err);
      return;
    }

    const tempPath = `${outputPath}.part`;
    try {
      fs.rmSync(tempPath, { force: true });
      fs.rmSync(outputPath, { force: true });
    } catch {
      // The process below will report a useful write failure if cleanup is blocked.
    }

    const args = [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-progress',
      'pipe:1',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      '10',
    ];
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
      tempPath,
    );

    const proc = spawn(ffmpegBin, args, { windowsHide: true });
    activeDownloads.set(id, { process: proc, meta: readMeta(id) });

    let stderr = '';
    let durationSec = 0;
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!durationSec) {
        const match = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
        if (match) durationSec = parseClockToSeconds(match[1]);
      }
    });
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const timeMatch = text.match(/out_time_ms=(\d+)/);
      if (timeMatch && durationSec > 0) {
        const played = Number(timeMatch[1]) / 1_000_000;
        updateDownloadProgress(id, played / durationSec);
      }
    });

    proc.on('error', (err) => {
      activeDownloads.delete(id);
      if (err && err.code === 'ENOENT') {
        reject(
          new Error(
            'ffmpeg is missing from this desktop build. Update kstream to download HLS offline.',
          ),
        );
        return;
      }
      reject(err);
    });

    proc.on('close', (code) => {
      activeDownloads.delete(id);
      if (code === 0 && isValidVideoFile(tempPath)) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function isValidVideoFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1024) return false;
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return header.includes(Buffer.from('ftyp')) || header.includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runFfmpegDownload(id, url, headers, outputPath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runFfmpegAttempt(id, url, headers, outputPath);
      fs.renameSync(`${outputPath}.part`, outputPath);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      try {
        fs.rmSync(`${outputPath}.part`, { force: true });
      } catch {
        // Ignore cleanup failures; the next attempt will try again.
      }
      if (attempt < 2) await waitForRetry(1000 * (attempt + 1));
    }
  }
  throw lastError || new Error('HLS download failed');
}

function formatDownloadError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT|ffmpeg is missing/i.test(message)) {
    return 'ffmpeg is missing from this desktop build. Update kstream and try again.';
  }
  if (/timed out|timeout|connection|network|tcp:|HTTP 5\d\d/i.test(message)) {
    return 'The source host could not be reached. Try again or choose another source.';
  }
  if (/invalid data|moov atom not found|could not write|exited with code/i.test(message)) {
    return 'The source returned an incomplete or invalid video. Try again or choose another source.';
  }
  return message.slice(0, 1000);
}

function downloadDirectFile(id, url, headers, outputPath) {
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

    const tempPath = `${outputPath}.part`;
    const writer = fs.createWriteStream(tempPath);
    const req = lib.request(reqUrl, { method: 'GET', headers, timeout: 120_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        writer.close();
        fs.rmSync(tempPath, { force: true });
        downloadDirectFile(id, new URL(res.headers.location, reqUrl).toString(), headers, outputPath)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode || 'error'}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) updateDownloadProgress(id, received / total);
      });
      res.pipe(writer);
      writer.once('finish', () => {
        fs.rename(tempPath, outputPath, (err) => (err ? reject(err) : resolve()));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    writer.on('error', reject);
    req.end();
  });
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
      if (!isValidVideoFile(output)) {
        throw new Error('Downloaded media is incomplete or invalid');
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
        error: formatDownloadError(err),
      };
      writeMeta(id, next);
      try {
        fs.rmSync(output, { force: true });
        fs.rmSync(`${output}.part`, { force: true });
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
  if (!isValidVideoFile(videoPath(id))) return null;
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
  if (!isValidVideoFile(filePath)) {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match) {
      const start = Number(match[1]);
      if (!Number.isSafeInteger(start) || start >= stat.size) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          ...corsHeaders(),
        });
        res.end();
        return;
      }
      const end = Math.min(
        match[2] ? Number(match[2]) : stat.size - 1,
        stat.size - 1,
      );
      if (!Number.isSafeInteger(end) || end < start) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          ...corsHeaders(),
        });
        res.end();
        return;
      }
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
