'use strict';

/**
 * Router DNS on this network hijacks some stream CDNs (movieboxnoob.cc)
 * to 192.168.4.1. UDP to 1.1.1.1 is intercepted too. HTTPS DoH is not.
 */

const https = require('https');
const dns = require('dns');

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase();
  if (!v) return true;
  if (v.includes(':')) {
    return (
      v === '::1' ||
      v.startsWith('fc') ||
      v.startsWith('fd') ||
      v.startsWith('fe80:')
    );
  }
  return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v);
}

function dohLookup(hostname) {
  const name = encodeURIComponent(hostname);
  const url = `${DOH_URL}?name=${name}&type=A`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { Accept: 'application/dns-json', 'User-Agent': 'kstream-desktop' },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const answers = (json.Answer || [])
              .filter((a) => a.type === 1 && a.data && !isPrivateIp(a.data))
              .map((a) => a.data);
            if (!answers.length) {
              reject(new Error(`DoH returned no public A records for ${hostname}`));
              return;
            }
            resolve(answers[0]);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('DoH lookup timed out')));
  });
}

async function resolvePublicAddress(hostname) {
  const host = String(hostname || '').toLowerCase();
  const hit = cache.get(host);
  if (hit && hit.expires > Date.now()) return hit.address;

  let address = null;
  try {
    const sys = await dns.promises.lookup(host, { all: true, verbatim: true });
    const publicSys = (sys || []).map((r) => r.address).filter((ip) => !isPrivateIp(ip));
    if (publicSys.length) address = publicSys[0];
  } catch {
    // fall through to DoH
  }
  if (!address) address = await dohLookup(host);

  cache.set(host, { address, expires: Date.now() + CACHE_MS });
  return address;
}

function lookupPublic(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  resolvePublicAddress(hostname).then(
    (address) => {
      const family = address.includes(':') ? 6 : 4;
      if (options && options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    },
    (err) => callback(err),
  );
}

function withPublicDns(requestOptions) {
  return { ...requestOptions, lookup: lookupPublic };
}

module.exports = {
  isPrivateIp,
  lookupPublic,
  resolvePublicAddress,
  withPublicDns,
};
