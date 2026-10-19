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
const releaseWorkflow = fs.readFileSync(
  path.resolve('.github/workflows/build-and-release.yml'),
  'utf8',
);
const desktopPreload = fs.readFileSync(
  path.resolve('src/preload/preload.js'),
  'utf8',
);

const enabled = extractSet(providers, 'ENABLED_SOURCE_IDS');
const desktopOnly = extractSet(providers, 'DESKTOP_SOURCE_IDS');
const webExtras = extractSet(providers, 'WEB_EXTRA_SOURCE_IDS');
requireMatch(
  providers,
  /const\s+DESKTOP_SOURCE_IDS\s*=\s*new Set\(\[\s*\.\.\.ENABLED_SOURCE_IDS,\s*["']movix["']\s*\]\);/,
  'desktop must inherit shared sources and add qualified Movix',
);
requireMatch(
  providers,
  /includeWebExtras[\s\S]*?!isDesktopApp\(\)[\s\S]*?WEB_EXTRA_SOURCE_IDS\.has\(source\.id\)/,
  'web extras must be included only on the non-desktop path',
);
requireMatch(
  releaseWorkflow,
  /node\s+kstream-web\/scripts\/provider-overlays\/movix\/apply\.mjs\s+providers-src/,
  'desktop release must include the Movix adapter in its provider bundle',
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

const overlap = enabled.filter((id) => webExtras.includes(id));
if (overlap.length) {
  throw new Error(
    `Web-extra IDs must not be in the shared enabled set: ${overlap.join(', ')}`,
  );
}
if (!desktopOnly.includes('movix') || desktopOnly.includes('veoveo')) {
  throw new Error(
    'Desktop must include Movix and keep VeoVeo behind browser-only qualification',
  );
}
if (!webExtras.includes('movix') || !webExtras.includes('veoveo')) {
  throw new Error('Website must retain both Movix and VeoVeo extras');
}

console.log(
  `Desktop sync policy verified: ${enabled.length} shared sources; desktop adds Movix and keeps VeoVeo excluded; website extras remain ${webExtras.join(', ')}.`,
);
