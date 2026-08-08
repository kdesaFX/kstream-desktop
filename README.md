# kstream Desktop (Core v1)

Windows desktop shell for [kstream](https://github.com/kdesaFX/kstream).

## Features (Core v1)

- Installable NSIS `.exe` (`kstream-Setup.exe`)
- Loads your live kstream site (default `https://kstream.lol`)
- Native scraping via built-in extension bridge (no Chrome extension)
- System tray + close-to-tray
- Auto-updates from GitHub Releases

**Not in Core v1:** offline downloads, code signing (SmartScreen may warn).

## SmartScreen

Unsigned builds can trigger Windows SmartScreen. Choose **More info → Run anyway**.

## Development

```bash
pnpm install
pnpm start
```

Optional: point at a different site:

```bash
set KSTREAM_URL=http://localhost:5173
pnpm start
```

## Build Windows installer

```bash
pnpm run build:win
```

Output: `dist/kstream-Setup.exe`

## Releases

Push a tag `v*` (or publish a GitHub Release). The workflow builds Windows x64 and uploads `kstream-Setup.exe` plus `latest.yml` for `electron-updater`.

## License

MIT
