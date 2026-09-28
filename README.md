<div align="center">
  <img src="https://kdesa.stream/logo.png?v=9" alt="kstream logo" width="112">

  <h1>kstream Desktop</h1>

  <p>
    <strong>A focused Windows desktop home for kstream.</strong><br>
    A native Electron shell with a locally bundled interface, desktop integrations, and a dependable update path.
  </p>

  <p>
    <a href="https://github.com/kdesaFX/kstream-desktop/releases/latest">
      <img src="https://img.shields.io/github/v/release/kdesaFX/kstream-desktop?label=latest%20release&color=22c7ae" alt="Latest release">
    </a>
    <a href="https://github.com/kdesaFX/kstream-desktop/releases">
      <img src="https://img.shields.io/github/downloads/kdesaFX/kstream-desktop/total?label=downloads&color=6eecd9" alt="Total downloads">
    </a>
    <img src="https://img.shields.io/badge/platform-Windows-24272e" alt="Windows">
  </p>

  <p>
    <a href="https://github.com/kdesaFX/kstream-desktop/releases/latest/download/kstream-Setup.exe">Download the latest installer</a>
    ·
    <a href="https://kdesa.stream">Open kstream</a>
    ·
    <a href="https://github.com/kdesaFX/kstream">Main web project</a>
  </p>
</div>

> [!NOTE]
> This repository contains the Windows desktop client, packaging configuration, and public release channel for kstream. It does not host streaming media.

## What is kstream Desktop?

kstream Desktop brings the kstream experience into a native Windows app while keeping the interface fast, self-contained, and easy to update.

The packaged app includes a copy of the kstream web interface and serves it from a small local server on 127.0.0.1. That means the app shell does not depend on the public website being reachable in order to open. Streaming, metadata, authentication, and provider requests still require an internet connection.

## Highlights

- **Bundled local interface** — release builds serve the UI locally instead of loading the app shell from the public website.
- **Native desktop bridge** — Electron handles desktop-only capabilities such as networking, media helpers, offline-library plumbing, OAuth callbacks, and update management.
- **Windows-first experience** — installer and portable modes, branded first run, system tray support, close-to-tray behavior, and saved window state.
- **Automatic updates** — checks GitHub Releases, downloads updates in the background, and applies them through a silent installer flow.
- **Startup recovery** — if an update is interrupted or a check stalls, the app can continue with the installed version instead of trapping the user at launch.
- **One release channel** — the website’s download link points to the latest published Windows installer.

## How the local shell works

When a packaged build starts, it:

1. Starts a small HTTP server on a free localhost port.
2. Serves the bundled SPA and desktop-specific API routes.
3. Loads the app from that local origin.
4. Uses the network only for the services the experience needs, such as metadata, providers, CDNs, and account services.

The desktop shell does not host media files. It provides the native environment around the kstream interface.

## Install

Download [kstream-Setup.exe](https://github.com/kdesaFX/kstream-desktop/releases/latest/download/kstream-Setup.exe), run it, and choose one of the two modes:

| Mode | Best for | Behavior |
| --- | --- | --- |
| **Install** | Everyday use | Copies kstream to %LOCALAPPDATA%/Programs/kstream and creates Desktop and Start Menu shortcuts. |
| **Portable** | USB drives or isolated folders | Runs from the downloaded location and stores app data in a kstream-data folder beside the executable. |

Windows SmartScreen may show a warning for unsigned development builds. Release signing and verification are documented in [SIGNING.md](./SIGNING.md).

## Updates

The desktop client checks for updates when it launches and also supports manual checks from the tray menu.

- Updates are downloaded without opening the NSIS wizard.
- The installed version remains available if an update cannot be downloaded or applied.
- A slow startup check can be skipped so the app can launch on the currently installed version.
- Interrupted installs are detected and recovered instead of repeatedly trapping the app at startup.

## OAuth callbacks

Google and Discord sign-in return to the desktop app through the kstream:// protocol.

Add this redirect URL in Supabase:

~~~text
kstream://auth/callback
~~~

The app opens authentication in the default browser and receives the result through the registered desktop protocol.

## Development

### Prerequisites

- Windows
- Node.js 20+
- pnpm
- A sibling checkout of the [kstream web project](https://github.com/kdesaFX/kstream) when rebuilding the bundled UI

### Run the desktop shell

~~~powershell
git clone https://github.com/kdesaFX/kstream-desktop.git
cd kstream-desktop
pnpm install --config.block-exotic-subdeps=false
pnpm start
~~~

To point the development shell at a running Vite server:

~~~powershell
$env:KSTREAM_URL = "http://localhost:5173"
pnpm start
~~~

KSTREAM_URL is development-only and is ignored by packaged builds.

### Embed the web UI locally

From the desktop repository’s parent directory:

~~~powershell
cd ../kstream
pnpm build
Copy-Item -Recurse -Force dist/* ../kstream-desktop/resources/web/
cd ../kstream-desktop
pnpm start
~~~

### Build a Windows package

After embedding the web UI:

~~~powershell
pnpm run dist
~~~

The installer is written to dist/kstream-Setup.exe. Release builds are published separately through the GitHub Actions release workflow.

## Repository map

| Path | Purpose |
| --- | --- |
| src/main/ | Electron main process, updater, local server, storage, and native integrations |
| src/preload/ | Secure bridges between the renderer and desktop APIs |
| renderer/ | First-run, update, and small desktop-facing screens |
| resources/web/ | Bundled web UI included in packaged builds |
| electron-builder.config.cjs | Windows packaging and installer configuration |
| .github/workflows/ | Build, release, and deployment automation |

## Contributing

Bug reports, focused improvements, and documentation fixes are welcome. For changes that affect both the desktop shell and the web interface, include the desktop/runtime assumptions in the pull request so the two repositories stay aligned.

<div align="center">
  <sub>Built for Windows · Part of the kstream project</sub>
</div>
