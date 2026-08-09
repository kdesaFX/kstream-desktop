'use strict';

const { session, net } = require('electron');

// --- Constants & Utils ---

const hostsWithCookiesAccess = [
  /^(?:.*\.)?ee3\.me$/,
  /^(?:.*\.)?rips\.cc$/,
  /^(?:.*\.)?m4ufree\.(?:tv|to|pw)$/,
  /^(?:.*\.)?goojara\.to$/,
  /^(?:.*\.)?levidia\.ch$/,
  /^(?:.*\.)?wootly\.ch$/,
  /^(?:.*\.)?multimovies\.(?:sbs|online|cloud)$/,
];

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let scrapeRuleSeq = 900000;

function canAccessCookies(host) {
  return hostsWithCookiesAccess.some((regex) => regex.test(host));
}

function domainMatches(hostname, domain) {
  if (!hostname || !domain) return false;
  const h = hostname.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, '');
  return h === d || h.endsWith(`.${d}`);
}

const modifiableResponseHeaders = new Set([
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-disposition',
]);

// --- Dynamic Rules State ---
const activeRules = new Map();

function compileRegex(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function normalizeTargetDomains(domains) {
  if (!Array.isArray(domains)) return null;
  return domains.map((domain) => domain.toLowerCase());
}

function updateRule(rule) {
  const updatedRule = { ...rule };
  updatedRule.__compiledTargetRegex = compileRegex(rule.targetRegex);
  updatedRule.__normalizedTargetDomains = normalizeTargetDomains(rule.targetDomains);
  activeRules.set(rule.ruleId, updatedRule);
}

function removeRule(ruleId) {
  activeRules.delete(ruleId);
}

function getMatchingRules(url, hostname) {
  if (activeRules.size === 0) return [];
  const hostnameLower = hostname ? hostname.toLowerCase() : null;
  const matches = [];

  for (const rule of activeRules.values()) {
    let match = false;
    if (hostnameLower && rule.__normalizedTargetDomains) {
      if (rule.__normalizedTargetDomains.some((domain) => domainMatches(hostnameLower, domain))) {
        match = true;
      }
    }
    if (!match && rule.__compiledTargetRegex && rule.__compiledTargetRegex.test(url)) {
      match = true;
    }
    if (match) matches.push(rule);
  }

  return matches;
}

function getMakeFullUrl(url, body) {
  let leftSide = body && body.baseUrl ? body.baseUrl : '';
  let rightSide = url;

  if (leftSide.length > 0 && !leftSide.endsWith('/')) leftSide += '/';
  if (rightSide.startsWith('/')) rightSide = rightSide.slice(1);

  const fullUrl = leftSide + rightSide;
  const u = new URL(fullUrl);

  if (body && body.query) {
    Object.entries(body.query).forEach(([key, val]) => {
      u.searchParams.append(key, val);
    });
  }
  return u.toString();
}

function mapBodyToFetchBody(body, bodyType) {
  if (bodyType === 'FormData') {
    const formData = new FormData();
    if (Array.isArray(body)) {
      body.forEach(([key, value]) => {
        formData.append(key, value.toString());
      });
    } else if (typeof body === 'object') {
      Object.entries(body).forEach(([key, value]) => {
        formData.append(key, value.toString());
      });
    }
    return formData;
  }
  if (bodyType === 'URLSearchParams') {
    return new URLSearchParams(body);
  }
  if (bodyType === 'object') {
    return JSON.stringify(body);
  }
  if (bodyType === 'string') {
    return body;
  }
  return body;
}

function normalizeHeaderMap(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  Object.entries(headers).forEach(([key, value]) => {
    if (value == null) return;
    out[key] = String(value);
  });
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')) {
    out['User-Agent'] = CHROME_UA;
  }
  return out;
}

/**
 * Install a temporary webRequest rule so Origin/Referer/UA/Cookie actually leave Chromium
 * (same role as the extension's temporary DNR rule).
 */
function installTempScrapeRule(url, headers) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const ruleId = scrapeRuleSeq++;
  updateRule({
    ruleId,
    targetDomains: [hostname],
    requestHeaders: normalizeHeaderMap(headers),
    responseHeaders: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
  return ruleId;
}

function cookieHeaderFromJar(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function setCookieLinesFromJar(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return [];
  return cookies.map((c) => {
    const parts = [`${c.name}=${c.value}`];
    if (c.domain) parts.push(`Domain=${c.domain}`);
    if (c.path) parts.push(`Path=${c.path}`);
    if (c.secure) parts.push('Secure');
    if (c.httpOnly) parts.push('HttpOnly');
    return parts.join('; ');
  });
}

// --- IPC Handlers ---

const handlers = {
  async hello() {
    return {
      success: true,
      version: '1.1.8',
      type: 'desktop',
      allowed: true,
      hasPermission: true,
    };
  },

  async openPage(body) {
    if (body && body.page) {
      console.log('Request to openPage:', body);
    }
    return { success: true };
  },

  async prepareStream(body) {
    try {
      if (!body) throw new Error('No body');

      const filteredResponseHeaders = {};
      if (body.responseHeaders) {
        Object.keys(body.responseHeaders).forEach((key) => {
          if (modifiableResponseHeaders.has(key.toLowerCase())) {
            filteredResponseHeaders[key] = body.responseHeaders[key];
          }
        });
      }
      body.responseHeaders = filteredResponseHeaders;

      updateRule(body);
      return { success: true };
    } catch (err) {
      console.error('prepareStream error:', err);
      return { success: false, error: err.message };
    }
  },

  async makeRequest(body) {
    let tempRuleId = null;
    try {
      if (!body.url) throw new Error('No url');

      const url = getMakeFullUrl(body.url, body);
      const method = body.method || 'GET';
      const headers = normalizeHeaderMap(body.headers);

      // Mirror extension: force forbidden headers via webRequest for this host
      tempRuleId = installTempScrapeRule(url, headers);

      const fetchOptions = {
        method,
        headers,
        body: mapBodyToFetchBody(body.body, body.bodyType),
        signal: AbortSignal.timeout(20000),
      };

      let response;
      if (session.defaultSession && typeof session.defaultSession.fetch === 'function') {
        response = await session.defaultSession.fetch(url, fetchOptions);
      } else if (typeof net.fetch === 'function') {
        response = await net.fetch(url, fetchOptions);
      } else {
        response = await fetch(url, fetchOptions);
      }

      const contentType = response.headers.get('content-type') || '';
      const responseBody = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      const finalUrl = response.url || url;
      const cookies = await session.defaultSession.cookies.get({ url: finalUrl });

      const responseHeaders = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });

      // Prefer real multi Set-Cookie if present
      if (typeof response.headers.getSetCookie === 'function') {
        const lines = response.headers.getSetCookie();
        if (lines && lines.length) {
          responseHeaders['Set-Cookie'] = lines.join('\n');
        }
      }

      const hostname = new URL(finalUrl).hostname;
      if (canAccessCookies(hostname)) {
        const lines = setCookieLinesFromJar(cookies);
        if (lines.length) {
          responseHeaders['Set-Cookie'] = lines.join('\n');
        }
        responseHeaders['Access-Control-Allow-Credentials'] = 'true';
        // Also expose a Cookie-style snapshot some parsers expect
        const cookieHeader = cookieHeaderFromJar(cookies);
        if (cookieHeader) responseHeaders['X-Desktop-Cookies'] = cookieHeader;
      }

      return {
        success: true,
        response: {
          statusCode: response.status,
          headers: responseHeaders,
          finalUrl,
          body: responseBody,
        },
      };
    } catch (err) {
      console.error('makeRequest error:', err);
      return { success: false, error: err.message };
    } finally {
      if (tempRuleId != null) removeRule(tempRuleId);
    }
  },
};

// --- Network Interceptor ---

function setupInterceptors(sess, options = {}) {
  const filter = { urls: ['<all_urls>'] };

  sess.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    let parsedHostname = null;
    try {
      parsedHostname = new URL(details.url).hostname;
    } catch {
      parsedHostname = null;
    }

    const getStreamHostname = options.getStreamHostname;
    if (typeof getStreamHostname === 'function' && parsedHostname) {
      try {
        const streamHostname = getStreamHostname();
        if (streamHostname) {
          const requestHostname = parsedHostname.replace(/^www\./, '');
          if (requestHostname === streamHostname.replace(/^www\./, '')) {
            requestHeaders['X-P-Stream-Client'] = 'desktop';
          }
        }
      } catch (_) {
        // ignore
      }
    }

    // Default to Chrome UA unless a rule overrides it
    const hasUa = Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'user-agent');
    if (!hasUa) {
      requestHeaders['User-Agent'] = CHROME_UA;
    } else {
      // Strip Electron fingerprint if present
      for (const key of Object.keys(requestHeaders)) {
        if (key.toLowerCase() === 'user-agent' && /Electron\//i.test(requestHeaders[key])) {
          requestHeaders[key] = CHROME_UA;
        }
      }
    }

    const matchingRules = getMatchingRules(details.url, parsedHostname);
    for (const rule of matchingRules) {
      if (rule.requestHeaders) {
        Object.entries(rule.requestHeaders).forEach(([name, value]) => {
          requestHeaders[name] = value;
        });
      }
    }

    callback({ requestHeaders });
  });

  sess.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };

    let parsedHostname = null;
    try {
      parsedHostname = new URL(details.url).hostname;
    } catch {
      parsedHostname = null;
    }

    const ruleMatches = getMatchingRules(details.url, parsedHostname);

    if (ruleMatches.length > 0) {
      const removeHeader = (name) => {
        const lowerName = name.toLowerCase();
        Object.keys(responseHeaders).forEach((key) => {
          if (key.toLowerCase() === lowerName) {
            delete responseHeaders[key];
          }
        });
      };

      ruleMatches.forEach((rule) => {
        if (rule.responseHeaders) {
          Object.entries(rule.responseHeaders).forEach(([name, value]) => {
            removeHeader(name);
            responseHeaders[name] = [value];
          });
        }
      });

      removeHeader('Access-Control-Allow-Origin');
      removeHeader('Access-Control-Allow-Methods');
      removeHeader('Access-Control-Allow-Headers');
      removeHeader('Access-Control-Allow-Credentials');

      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
    }

    callback({ responseHeaders });
  });
}

module.exports = {
  handlers,
  setupInterceptors,
  CHROME_UA,
};
