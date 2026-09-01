'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

let libraryRoot = null;

function initMangaOffline(userDataPath) {
  libraryRoot = path.join(userDataPath, 'manga-library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  console.log('[kstream-desktop] Manga offline library at', libraryRoot);
}

function chapterKey(chapterId) {
  return crypto.createHash('sha256').update(String(chapterId)).digest('hex').slice(0, 32);
}

function chapterDir(chapterId) {
  return path.join(libraryRoot, chapterKey(chapterId));
}

function fetchBuffer(url, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    let lib;
    try {
      lib = new URL(url).protocol === 'https:' ? https : http;
    } catch (err) {
      reject(err);
      return;
    }
    const req = lib.get(url, { timeout }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        fetchBuffer(res.headers.location, timeout).then(resolve, reject);
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
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Download timed out'));
    });
  });
}

function extFromUrl(url) {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').pop() || '';
    const ext = path.extname(base).toLowerCase();
    if (['.png', '.webp', '.gif', '.jpeg', '.jpg'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
    const dest = parsed.searchParams.get('destination');
    if (dest) return extFromUrl(dest);
  } catch {
    /* ignore */
  }
  return '.jpg';
}

async function downloadMangaChapter(body) {
  if (!libraryRoot) throw new Error('Manga offline library is not ready');
  const chapterId = body?.chapterId;
  const pages = body?.pages;
  if (!chapterId || !Array.isArray(pages) || pages.length === 0) {
    throw new Error('Missing chapter pages');
  }

  const dir = chapterDir(chapterId);
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  for (let i = 0; i < pages.length; i++) {
    const pageUrl = pages[i];
    if (!pageUrl) continue;
    const buf = await fetchBuffer(pageUrl);
    const name = `${String(i).padStart(4, '0')}${extFromUrl(pageUrl)}`;
    fs.writeFileSync(path.join(dir, name), buf);
    saved.push(name);
  }

  if (!saved.length) throw new Error('No pages were saved');

  const meta = {
    chapterId,
    mangaId: body.mangaId || null,
    title: body.title || null,
    chapterLabel: body.chapterLabel || null,
    pages: saved,
    savedAt: Date.now(),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

  return { ok: true, pageCount: saved.length };
}

function getOfflineChapterPages(chapterId, origin) {
  if (!libraryRoot || !chapterId || !origin) return null;
  const dir = chapterDir(chapterId);
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(meta.pages) || !meta.pages.length) return null;
  const key = chapterKey(chapterId);
  return meta.pages.map((name) => `${origin}/api/manga-offline/${key}/${name}`);
}

function hasOfflineChapter(chapterId) {
  if (!libraryRoot || !chapterId) return false;
  return fs.existsSync(path.join(chapterDir(chapterId), 'meta.json'));
}

function serveMangaOffline(req, res, requestUrl) {
  if (!libraryRoot) {
    sendJson(res, { error: 'Manga offline library unavailable' }, 503);
    return;
  }

  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'manga-offline') {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }

  const key = parts[2];
  const file = parts[3];
  if (!key || !file || file.includes('..') || key.includes('..')) {
    sendJson(res, { error: 'Forbidden' }, 403);
    return;
  }

  const filePath = path.join(libraryRoot, key, file);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, { error: 'Not found' }, 404);
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const type =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/jpeg';

  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...corsHeaders(),
  });
  res.end(data);
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
  initMangaOffline,
  downloadMangaChapter,
  getOfflineChapterPages,
  hasOfflineChapter,
  serveMangaOffline,
};
