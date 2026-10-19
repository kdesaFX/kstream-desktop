'use strict';

const fs = require('fs');
const path = require('path');

const webRoot = path.resolve(process.argv[2] || 'kstream-web');

function readWebFile(relativePath) {
  return fs.readFileSync(path.join(webRoot, relativePath), 'utf8');
}

function extractSet(source, name) {
  const match = source.match(
    new RegExp(`const ${name} = new Set(?:<[^>]+>)?\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  if (!match) throw new Error(`Could not find ${name} in the website provider policy`);
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

function requireMatch(source, expression, description) {
  if (!expression.test(source)) throw new Error(`Desktop sync check failed: ${description}`);
}

const providers = readWebFile('src/backend/providers/providers.ts');
const sourceOrder = readWebFile('src/utils/media/sourceOrder.ts');
const sourceSelection = readWebFile(
  'src/components/player/atoms/settings/SourceSelectingView.tsx',
);
const desktopPreload = fs.readFileSync(
  path.resolve('src/preload/preload.js'),
  'utf8',
);

const enabled = extractSet(providers, 'ENABLED_SOURCE_IDS');
const browserOnly = extractSet(providers, 'BROWSER_ONLY_SOURCE_IDS');
requireMatch(
  providers,
  /const\s+DESKTOP_SOURCE_IDS\s*=\s*ENABLED_SOURCE_IDS\s*;/,
  'desktop must inherit the website enabled source allowlist',
);
requireMatch(
  providers,
  /includeBrowserOnly[\s\S]*?!isDesktopApp\(\)[\s\S]*?BROWSER_ONLY_SOURCE_IDS\.has\(source\.id\)/,
  'browser-only sources must stay excluded in the desktop target',
);
requireMatch(
  sourceOrder,
  /LAST_RESORT_SOURCE_IDS\s*=\s*new Set(?:<string>)?\(\[[^\]]*["']movix["'][^\]]*\]\)/,
  'Movix must remain deferred as a last-resort source',
);
requireMatch(
  sourceSelection,
  /filterLastResortSourcesUntilNormalFailed/,
  'source selection UI must honor last-resort ordering',
);
requireMatch(
  desktopPreload,
  /__KSTREAM_DESKTOP_IPC__/,
  'desktop preload must expose the runtime marker used by the website source policy',
);

const overlap = enabled.filter((id) => browserOnly.includes(id));
if (overlap.length) {
  throw new Error(
    `Browser-only IDs must not be in the shared enabled set: ${overlap.join(', ')}`,
  );
}

console.log(
  `Desktop sync policy verified: ${enabled.length} shared sources (${enabled.join(', ')}); ${browserOnly.length} browser-only sources excluded (${browserOnly.join(', ')}).`,
);
