# kstream Desktop (Core)

Windows desktop shell for [kstream](https://github.com/kdesaFX/kstream).

## Features

- One download: `kstream-Setup.exe` (portable build)
- Branded first-run UI — **install** to AppData or **keep portable**
- **Bundled local UI** on `http://127.0.0.1` (no Cloudflare / domain block for the shell)
- Native scraping via built-in extension bridge (no Chrome extension)
- System tray + close-to-tray
- Auto-update checks from GitHub Releases (best after install)

**Not in Core yet:** offline downloads.

## Local mode

Release builds embed a copy of the kstream web UI. On launch the desktop app:

1. Starts a tiny HTTP server on `127.0.0.1` (random free port)
2. Serves the bundled SPA + `/api/proxy` (for MangaDex covers / scrape fallback)
3. Loads that local origin instead of `https://kdesa.stream`

Streaming still needs internet (TMDB, sources, CDNs). Only the **UI shell** is local.

Force the remote site (or Vite) with:

```bash
set KSTREAM_URL=https://kdesa.stream
pnpm start
```

## First run

After you open `kstream-Setup.exe`:

1. **Install** (recommended) — copies the app to `%LOCALAPPDATA%\Programs\kstream` and creates Desktop + Start Menu shortcuts, then relaunches from there.
2. **Portable** — runs from the download location and stores data in a `kstream-data` folder beside the exe.

## SmartScreen

Unsigned builds show Windows SmartScreen. Signed releases use **Azure Artifact Signing** — see [SIGNING.md](./SIGNING.md) for the one-time Azure + GitHub secrets setup.

Until signing secrets are configured, choose **More info → Run anyway**.

## Development

```bash
pnpm install --config.block-exotic-subdeps=false
pnpm start
```

Point at Vite during web development:

```bash
set KSTREAM_URL=http://localhost:5173
pnpm start
```

Or build and embed the web UI locally:

```bash
cd ../kstream
pnpm build
xcopy /E /I /Y dist\* ..\kstream-desktop\resources\web\
cd ../kstream-desktop
pnpm start
```

In dev, the welcome screen still appears until you pick a mode (`runMode` in settings). Install skips the file copy and just continues.

## Build Windows package

CI builds kstream `@production` and copies `dist/` into `resources/web` before packaging. Locally:

```bash
# after embedding web UI into resources/web (see above)
pnpm run dist
```

Output: `dist/kstream-Setup.exe` (signed automatically when Azure env vars / CI secrets are set).

## Releases

Push a `v*` tag (e.g. `v1.1.0`). GitHub Actions builds and uploads the exe to Releases. The website download button uses `/download/kstream-Setup.exe` → latest release asset.
