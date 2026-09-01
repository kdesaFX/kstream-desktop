'use strict';

const https = require('https');
const http = require('http');

/**
 * Lightweight reachability probe for school / filtered networks.
 * @param {string} url
 * @param {{ method?: string, timeout?: number }} [options]
 */
function probeUrl(url, options = {}) {
  const timeout = options.timeout ?? 8000;
  return new Promise((resolve) => {
    const started = Date.now();
    let lib;
    let reqUrl;
    try {
      reqUrl = new URL(url);
      lib = reqUrl.protocol === 'https:' ? https : http;
    } catch {
      resolve({ ok: false, ms: 0, error: 'Invalid URL' });
      return;
    }

    const req = lib.request(
      reqUrl,
      { method: options.method || 'GET', timeout },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      },
    );
    req.on('error', (err) => {
      resolve({ ok: false, ms: Date.now() - started, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, ms: timeout, error: 'Timed out' });
    });
    req.end();
  });
}

/**
 * @param {{ localOrigin?: string }} options
 */
async function runNetworkCheck(options = {}) {
  const localOrigin = options.localOrigin || null;
  const tests = [];

  if (localOrigin) {
    tests.push({
      id: 'local-ui',
      label: 'Local app UI',
      optional: false,
      ...(await probeUrl(localOrigin)),
    });

    const proxyDest = encodeURIComponent('https://api.mangadex.org/manga?limit=1');
    tests.push({
      id: 'local-proxy',
      label: 'Local scrape proxy',
      optional: false,
      ...(await probeUrl(`${localOrigin}/api/proxy?destination=${proxyDest}`)),
    });
  }

  tests.push({
    id: 'tmdb',
    label: 'TMDB (search & artwork)',
    optional: false,
    ...(await probeUrl('https://api.themoviedb.org/3/configuration')),
  });

  tests.push({
    id: 'mangadex',
    label: 'MangaDex API',
    optional: false,
    ...(await probeUrl('https://api.mangadex.org/manga?limit=1')),
  });

  tests.push({
    id: 'main-site',
    label: 'kdesa.stream website',
    optional: true,
    ...(await probeUrl('https://kdesa.stream/')),
  });

  return { testedAt: new Date().toISOString(), tests };
}

module.exports = { runNetworkCheck };
