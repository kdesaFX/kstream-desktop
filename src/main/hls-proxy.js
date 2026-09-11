'use strict';

/**
 * Same-origin HLS proxies as kdesa.stream /api/m3u8-proxy and /api/ts-proxy.
 * Without these, desktop validation/playback fetch localhost /api/m3u8-proxy
 * and get SPA HTML — every header-locked source looks like "not found".
 */

const http = require('http');
const https = require('https');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:93.0) Gecko/20100101 Firefox/93.0';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers':
      '*, Content-Range, Accept-Ranges, Content-Length, Content-Type',
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
    // ignore
  }
  return out;
}

function resolvePlaylistUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
}

function requestOrigin(req, requestUrl) {
  const host = req.headers.host || '127.0.0.1';
  return `${requestUrl.protocol}//${host}`;
}

function parseHeight(info) {
  const m = /RESOLUTION=\d+x(\d+)/i.exec(info);
  return m ? Number(m[1]) || 0 : 0;
}

function isHevcCodecs(info) {
  const m = /CODECS="([^"]+)"/i.exec(info);
  const codecs = (m?.[1] || '').toLowerCase();
  return codecs.includes('hev1') || codecs.includes('hvc1') || codecs.includes('hevc');
}

function isAvcCodecs(info) {
  const m = /CODECS="([^"]+)"/i.exec(info);
  const codecs = (m?.[1] || '').toLowerCase();
  return codecs.includes('avc1') || codecs.includes('avc3');
}

function preferBrowserVariants(body) {
  const lines = body.split(/\r?\n/);
  const head = [];
  const variants = [];
  const tail = [];
  let i = 0;
  let seenStreamInf = false;
  let pendingTags = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      seenStreamInf = true;
      const info = line;
      const uri = lines[i + 1] || '';
      variants.push({
        tags: pendingTags,
        info,
        uri,
        height: parseHeight(info),
        hevc: isHevcCodecs(info),
        avc: isAvcCodecs(info),
      });
      pendingTags = [];
      i += 2;
      continue;
    }

    if (!seenStreamInf) {
      if (line.startsWith('#') && !line.startsWith('#EXT') && line.trim() !== '') {
        pendingTags.push(line);
      } else {
        if (pendingTags.length) {
          head.push(...pendingTags);
          pendingTags = [];
        }
        head.push(line);
      }
      i += 1;
      continue;
    }

    if (pendingTags.length) {
      tail.push(...pendingTags);
      pendingTags = [];
    }
    tail.push(line);
    i += 1;
  }

  if (!variants.length) return body;

  const score = (v) => {
    let s = 0;
    if (v.avc) s += 1000;
    if (v.hevc) s -= 500;
    if (v.height > 1080) s -= 200;
    if (v.height > 0 && v.height <= 720) {
      s += 300;
      s += 1 - Math.abs(v.height - 720) / 720;
    } else if (v.height > 720 && v.height <= 1080) {
      s += 100;
      s += (1080 - v.height) / 1080;
    }
    return s;
  };

  const sorted = [...variants].sort((a, b) => score(b) - score(a));
  const hasAvc = sorted.some((v) => v.avc);
  const filtered = hasAvc
    ? sorted.filter((v) => !(v.hevc && v.height > 1080))
    : sorted;

  const out = [...head];
  for (const v of filtered.length ? filtered : sorted) {
    out.push(...v.tags, v.info, v.uri);
  }
  out.push(...tail);
  return out.join('\n');
}

function buildSegmentOrNestedProxy(
  absolute,
  origin,
  clientHeadersJson,
  isPlaylist,
  browserFriendly,
) {
  const path = isPlaylist ? '/api/m3u8-proxy' : '/api/ts-proxy';
  const u = new URL(path, origin);
  u.searchParams.set('url', absolute);
  if (clientHeadersJson) u.searchParams.set('headers', clientHeadersJson);
  if (browserFriendly && isPlaylist) u.searchParams.set('browser', '1');
  return u.toString();
}

const PLAYLIST_URI_TAGS = ['#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:'];

function tagNamesAPlaylist(line) {
  const upper = line.toUpperCase();
  return PLAYLIST_URI_TAGS.some((tag) => upper.startsWith(tag));
}

function rewritePlaylist(
  body,
  playlistUrl,
  origin,
  clientHeadersJson,
  browserFriendly,
) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let afterStreamInf = false;

  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      if (line.includes('URI=')) {
        const namesAPlaylist = tagNamesAPlaylist(line);
        out.push(
          line.replace(/URI="([^"]+)"/g, (_m, uri) => {
            const absolute = resolvePlaylistUri(uri, playlistUrl);
            if (!absolute) return `URI="${uri}"`;
            const proxied = buildSegmentOrNestedProxy(
              absolute,
              origin,
              clientHeadersJson,
              namesAPlaylist || absolute.includes('.m3u8'),
              browserFriendly,
            );
            return `URI="${proxied}"`;
          }),
        );
      } else {
        out.push(line);
      }
      if (line.toUpperCase().startsWith('#EXT-X-STREAM-INF:')) {
        afterStreamInf = true;
      }
      continue;
    }

    const absolute = resolvePlaylistUri(line.trim(), playlistUrl);
    if (!absolute) {
      out.push(line);
      afterStreamInf = false;
      continue;
    }

    out.push(
      buildSegmentOrNestedProxy(
        absolute,
        origin,
        clientHeadersJson,
        afterStreamInf || absolute.includes('.m3u8'),
        browserFriendly,
      ),
    );
    afterStreamInf = false;
  }

  let rewritten = out.join('\n');
  if (browserFriendly && rewritten.includes('#EXT-X-STREAM-INF:')) {
    rewritten = preferBrowserVariants(rewritten);
  }
  return rewritten;
}

function fetchBuffer(target, headers) {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      { method: 'GET', headers, timeout: 30_000 },
      (upstream) => {
        const chunks = [];
        upstream.on('data', (chunk) => chunks.push(chunk));
        upstream.on('end', () => {
          resolve({
            status: upstream.statusCode || 502,
            statusMessage: upstream.statusMessage || '',
            headers: upstream.headers,
            body: Buffer.concat(chunks),
            finalUrl: target.href,
          });
        });
        upstream.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Upstream request timed out'));
    });
    req.end();
  });
}

function handleM3u8Proxy(req, res, requestUrl) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  void (async () => {
    try {
      const targetRaw = requestUrl.searchParams.get('url');
      if (!targetRaw) {
        sendJson(res, { error: 'Missing url query parameter' }, 400);
        return;
      }
      const target = assertSafeDestination(targetRaw);
      const clientHeadersJson = requestUrl.searchParams.get('headers') || '';
      const clientHeaders = parseClientHeaders(clientHeadersJson);
      const browserFriendly = requestUrl.searchParams.get('browser') === '1';
      const origin = requestOrigin(req, requestUrl);

      const upstreamHeaders = {
        'User-Agent': DEFAULT_UA,
        ...clientHeaders,
      };

      const upstream = await fetchBuffer(target, upstreamHeaders);
      const contentType = Array.isArray(upstream.headers['content-type'])
        ? upstream.headers['content-type'][0]
        : upstream.headers['content-type'] || '';
      const text = upstream.body.toString('utf8');
      const looksLikePlaylist =
        String(contentType).includes('mpegurl') ||
        String(contentType).includes('m3u8') ||
        text.trimStart().startsWith('#EXTM3U');

      const body = looksLikePlaylist
        ? rewritePlaylist(
            text,
            upstream.finalUrl,
            origin,
            clientHeadersJson,
            browserFriendly,
          )
        : text;

      const headers = corsHeaders({
        'X-Final-Destination': upstream.finalUrl,
        'Content-Type': looksLikePlaylist
          ? 'application/vnd.apple.mpegurl; charset=utf-8'
          : contentType || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.writeHead(upstream.status, headers);
      res.end(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'M3U8 proxy failed';
      sendJson(res, { error: message }, 400);
    }
  })();
}

function handleTsProxy(req, res, requestUrl) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    const targetRaw = requestUrl.searchParams.get('url');
    if (!targetRaw) {
      sendJson(res, { error: 'Missing url query parameter' }, 400);
      return;
    }
    const target = assertSafeDestination(targetRaw);
    const clientHeaders = parseClientHeaders(requestUrl.searchParams.get('headers'));
    const range = req.headers.range || req.headers.Range;
    const upstreamHeaders = {
      'User-Agent': DEFAULT_UA,
      ...clientHeaders,
    };
    if (range) upstreamHeaders.Range = range;

    const lib = target.protocol === 'https:' ? https : http;
    const upstreamReq = lib.request(
      target,
      { method: 'GET', headers: upstreamHeaders, timeout: 60_000 },
      (upstream) => {
        const upstreamType = String(upstream.headers['content-type'] || '').toLowerCase();
        const remapHtmlTs =
          upstreamType.includes('text/html') || /page-\d+\.html/i.test(target.pathname);

        const headers = corsHeaders({
          'X-Final-Destination': target.href,
        });
        if (remapHtmlTs) {
          headers['Content-Type'] = 'video/mp2t';
          headers['X-Content-Type-Options'] = 'nosniff';
          headers['Cache-Control'] = 'no-store';
        } else {
          const ct = upstream.headers['content-type'];
          if (ct) headers['Content-Type'] = Array.isArray(ct) ? ct[0] : ct;
          headers['Cache-Control'] = 'public, max-age=3600';
        }
        const contentRange = upstream.headers['content-range'];
        if (contentRange) {
          headers['Content-Range'] = Array.isArray(contentRange)
            ? contentRange[0]
            : contentRange;
        }
        const acceptRanges = upstream.headers['accept-ranges'];
        if (acceptRanges) {
          headers['Accept-Ranges'] = Array.isArray(acceptRanges)
            ? acceptRanges[0]
            : acceptRanges;
        }
        const contentLength = upstream.headers['content-length'];
        if (contentLength) {
          headers['Content-Length'] = Array.isArray(contentLength)
            ? contentLength[0]
            : contentLength;
        }

        res.writeHead(upstream.statusCode || 502, headers);
        upstream.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        sendJson(res, { error: err.message || 'TS proxy failed' }, 400);
      } else {
        res.destroy(err);
      }
    });
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream request timed out'));
    });
    upstreamReq.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'TS proxy failed';
    sendJson(res, { error: message }, 400);
  }
}

module.exports = {
  handleM3u8Proxy,
  handleTsProxy,
  rewritePlaylist,
};
