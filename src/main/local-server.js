'use strict';

/**
 * Local HTTP server for bundled kstream UI.
 * Serves static SPA assets + /api/proxy (MangaDex covers / scrape fallback).
 * HLS m3u8/ts proxies are intentionally omitted — desktop uses native IPC.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  serveMangaOffline,
} = require('./manga-offline');
const {
  serveOfflineVideo,
} = require('./video-offline');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0';

const HEADER_MAP = {
  'x-cookie': 'Cookie',
  'x-referer': 'Referer',
  'x-origin': 'Origin',
  'x-user-agent': 'User-Agent',
  'x-x-real-ip': 'X-Real-Ip',
};

const PASSTHROUGH_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-language',
  'x-requested-with',
  'hx-request',
  'range',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin, Accept-Encoding',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...extra,
  };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function assertSafeDestination(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid destination URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Destination must be http(s)');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    throw new Error('Destination host is not allowed');
  }
  return parsed;
}

function parseClientHeaders(raw) {
  const out = {};
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) out[key] = value;
    }
  } catch {
    // ignore malformed headers JSON
  }
  return out;
}

function buildUpstreamHeaders(incoming, embedded = {}) {
  const out = {
    'User-Agent': DEFAULT_UA,
  };
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    const mapped = HEADER_MAP[lower];
    if (mapped) {
      out[mapped] = value;
      continue;
    }
    if (PASSTHROUGH_HEADERS.has(lower)) {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(embedded)) {
    out[key] = value;
  }
  return out;
}

function collectRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxyFetch(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      {
        method,
        headers,
        timeout: 30_000,
      },
      (upstream) => {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          resolve({
            status: upstream.statusCode || 502,
            statusMessage: upstream.statusMessage || '',
            headers: upstream.headers,
            body: Buffer.concat(chunks),
            finalUrl: upstream.headers['x-final-destination'] || target.href,
          });
        });
        upstream.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Upstream request timed out'));
    });
    if (body && body.length) req.write(body);
    req.end();
  });
}

async function handleProxy(req, res, requestUrl) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    const destination = requestUrl.searchParams.get('destination');
    if (!destination) {
      sendJson(res, { error: 'Missing destination query parameter' }, 400);
      return;
    }

    const target = assertSafeDestination(destination);
    const upstreamHeaders = buildUpstreamHeaders(
      collectRequestHeaders(req),
      parseClientHeaders(requestUrl.searchParams.get('headers')),
    );

    const host = target.hostname.toLowerCase();
    if (
      (host.endsWith('.mangadex.network') || host === 'uploads.mangadex.org') &&
      !upstreamHeaders.Referer
    ) {
      upstreamHeaders.Referer = 'https://mangadex.org/';
    }

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await readRequestBody(req);
    }

    const upstream = await proxyFetch(
      target,
      req.method || 'GET',
      upstreamHeaders,
      body,
    );

    const responseHeaders = corsHeaders({
      'X-Final-Destination':
        typeof upstream.finalUrl === 'string' ? upstream.finalUrl : target.href,
    });

    const setCookie = upstream.headers['set-cookie'];
    if (setCookie) {
      responseHeaders['X-Set-Cookie'] = Array.isArray(setCookie)
        ? setCookie.join(', ')
        : setCookie;
    }
    const contentType = upstream.headers['content-type'];
    if (contentType) {
      responseHeaders['Content-Type'] = Array.isArray(contentType)
        ? contentType[0]
        : contentType;
    }

    res.writeHead(upstream.status, responseHeaders);
    res.end(upstream.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    sendJson(res, { error: message }, 400);
  }
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(root, relative));
  if (!resolved.startsWith(path.normalize(root + path.sep)) && resolved !== path.normalize(root)) {
    return null;
  }
  return resolved;
}

function serveStatic(webRoot, req, res, requestUrl) {
  let filePath = safeJoin(webRoot, requestUrl.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  const sendFile = (absolutePath) => {
    const ext = path.extname(absolutePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(absolutePath);
    const headers = {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control':
        ext === '.html' || ext === '.json'
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
    };
    res.writeHead(200, headers);
    res.end(data);
  };

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendFile(filePath);
    return;
  }

  // SPA fallback for client-side routes
  const indexHtml = path.join(webRoot, 'index.html');
  if (fs.existsSync(indexHtml)) {
    sendFile(indexHtml);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

/**
 * Resolve the bundled web root.
 * Packaged: process.resourcesPath/web
 * Dev override: KSTREAM_WEB_ROOT
 * Dev fallback: <repo>/resources/web
 */
function resolveWebRoot() {
  if (process.env.KSTREAM_WEB_ROOT) {
    const envRoot = path.resolve(process.env.KSTREAM_WEB_ROOT);
    if (fs.existsSync(path.join(envRoot, 'index.html'))) return envRoot;
  }

  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'web');
    if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  }

  const dev = path.join(__dirname, '..', '..', 'resources', 'web');
  if (fs.existsSync(path.join(dev, 'index.html'))) return dev;

  return null;
}

/**
 * Start a local server on 127.0.0.1 with a free port.
 * @returns {Promise<{ server: import('http').Server, port: number, origin: string, webRoot: string, close: () => Promise<void> }>}
 */
function startLocalServer(options = {}) {
  const webRoot = options.webRoot || resolveWebRoot();
  if (!webRoot) {
    return Promise.reject(new Error('No bundled web root found'));
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const host = req.headers.host || '127.0.0.1';
        const requestUrl = new URL(req.url || '/', `http://${host}`);

        if (requestUrl.pathname === '/api/proxy') {
          void handleProxy(req, res, requestUrl);
          return;
        }

        if (requestUrl.pathname.startsWith('/api/manga-offline/')) {
          serveMangaOffline(req, res, requestUrl);
          return;
        }

        if (requestUrl.pathname.startsWith('/api/offline-video/')) {
          serveOfflineVideo(req, res, requestUrl);
          return;
        }

        if (requestUrl.pathname.startsWith('/api/')) {
          sendJson(res, { error: 'Not available in desktop local mode' }, 404);
          return;
        }

        serveStatic(webRoot, req, res, requestUrl);
      } catch (err) {
        console.error('[kstream-desktop] local server error', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal error');
        }
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      console.log('[kstream-desktop] local UI server', origin, '→', webRoot);
      resolve({
        server,
        port,
        origin,
        webRoot,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}

module.exports = {
  resolveWebRoot,
  startLocalServer,
};
