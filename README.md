# kstream Desktop (Core)

Windows desktop shell for [kstream](https://github.com/kdesaFX/kstream).

## Features

- One download: `kstream-Setup.exe` (portable build)
- Branded first-run UI — **install** to AppData or **keep portable**
- Loads your live kstream site (default `https://kstream-one.vercel.app`; later `https://kdesa.stream`)
- Native scraping via built-in extension bridge (no Chrome extension)
- System tray + close-to-tray
- Auto-update checks from GitHub Releases (best after install)

**Not in Core yet:** offline downloads.

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

Optional: point at a different site:

```bash
set KSTREAM_URL=http://localhost:5173
pnpm start
```

In dev, the welcome screen still appears until you pick a mode (`runMode` in settings). Install skips the file copy and just continues.

## Build Windows package

```bash
pnpm run dist
```

Output: `dist/kstream-Setup.exe` (signed automatically when Azure env vars / CI secrets are set).

## Releases

Push a `v*` tag (e.g. `v1.1.0`). GitHub Actions builds and uploads the exe to Releases. The website download button uses `/download/kstream-Setup.exe` → latest release asset.
