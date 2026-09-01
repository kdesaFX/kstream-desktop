'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let db = null;
let dbPath = null;

const DEFAULT_TTL_SEC = 24 * 3600;
const DETAIL_TTL_SEC = 30 * 24 * 3600;
const LIST_TTL_SEC = 7 * 24 * 3600;
const MAX_ROWS = 50_000;

function hashKey(keyObj) {
  return crypto.createHash('sha256').update(JSON.stringify(keyObj)).digest('hex');
}

function ttlForUrl(url) {
  const u = String(url || '').replace(/^\//, '');
  if (/^(movie|tv)\/\d+$/.test(u)) return DETAIL_TTL_SEC;
  if (/^(movie|tv)\/\d+\/(season|episode)/.test(u)) return DETAIL_TTL_SEC;
  if (
    u.startsWith('search/') ||
    u.startsWith('discover/') ||
    u.startsWith('trending/') ||
    u.startsWith('genre/')
  ) {
    return LIST_TTL_SEC;
  }
  return DEFAULT_TTL_SEC;
}

function openDatabase(userDataPath) {
  const dir = path.join(userDataPath, 'tmdb-cache');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cache.db');
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (err) {
    console.warn('[kstream-desktop] node:sqlite unavailable — TMDB disk cache disabled', err?.message);
    return null;
  }

  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS tmdb_cache (
      cache_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tmdb_accessed ON tmdb_cache(accessed_at);
  `);
  dbPath = file;
  return database;
}

function initTmdbCache(userDataPath) {
  if (db) return db;
  db = openDatabase(userDataPath);
  if (db) {
    console.log('[kstream-desktop] TMDB disk cache ready at', dbPath);
  }
  return db;
}

function pruneIfNeeded() {
  if (!db) return;
  const row = db.prepare('SELECT COUNT(*) AS n FROM tmdb_cache').get();
  const count = row?.n ?? 0;
  if (count <= MAX_ROWS) return;
  const excess = count - MAX_ROWS + 1000;
  db.prepare(
    `DELETE FROM tmdb_cache WHERE cache_key IN (
      SELECT cache_key FROM tmdb_cache ORDER BY accessed_at ASC LIMIT ?
    )`,
  ).run(excess);
}

/**
 * @param {{ url: string, params?: object, language: string }} keyObj
 * @param {{ allowStale?: boolean }} [options]
 */
function getTmdbCacheEntry(keyObj, options = {}) {
  if (!db || !keyObj?.url) return null;
  const cacheKey = hashKey(keyObj);
  const now = Date.now();
  const row = db
    .prepare('SELECT payload, expires_at FROM tmdb_cache WHERE cache_key = ?')
    .get(cacheKey);
  if (!row) return null;

  db.prepare('UPDATE tmdb_cache SET accessed_at = ? WHERE cache_key = ?').run(now, cacheKey);

  if (row.expires_at > now || options.allowStale) {
    try {
      return JSON.parse(row.payload);
    } catch {
      db.prepare('DELETE FROM tmdb_cache WHERE cache_key = ?').run(cacheKey);
      return null;
    }
  }
  return null;
}

/**
 * @param {{ url: string, params?: object, language: string }} keyObj
 * @param {unknown} value
 * @param {number} [ttlSec]
 */
function setTmdbCacheEntry(keyObj, value, ttlSec) {
  if (!db || !keyObj?.url || value == null) return;
  const cacheKey = hashKey(keyObj);
  const now = Date.now();
  const ttl = ttlSec || ttlForUrl(keyObj.url);
  const expires = now + ttl * 1000;
  let payload;
  try {
    payload = JSON.stringify(value);
  } catch {
    return;
  }

  db.prepare(
    `INSERT INTO tmdb_cache (cache_key, url, payload, expires_at, accessed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload = excluded.payload,
       expires_at = excluded.expires_at,
       accessed_at = excluded.accessed_at`,
  ).run(cacheKey, keyObj.url, payload, expires, now);

  pruneIfNeeded();
}

function getTmdbCacheStats() {
  if (!db) return { enabled: false, rows: 0, path: dbPath };
  const row = db.prepare('SELECT COUNT(*) AS n FROM tmdb_cache').get();
  return {
    enabled: true,
    rows: row?.n ?? 0,
    path: dbPath,
  };
}

module.exports = {
  initTmdbCache,
  getTmdbCacheEntry,
  setTmdbCacheEntry,
  getTmdbCacheStats,
};
