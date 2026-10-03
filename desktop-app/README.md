# LANclave — desktop app

The Windows app. A React interface in a Tauri window, with the engine
(discovery, pairing, the file server and transfers) written in Rust.

For what LANclave does, see the [main README](../README.md).

## What you need

- Windows 10 or 11. The app is developed and tested on Windows 11.
- [Node.js](https://nodejs.org/) (LTS) with npm.
- [Rust](https://www.rust-lang.org/tools/install), stable, with the MSVC
  toolchain.
- Microsoft C++ Build Tools and WebView2. WebView2 is already present on
  Windows 11.

Tauri's [prerequisites page](https://tauri.app/start/prerequisites/) walks
through installing the last two.

## Run it

```powershell
cd desktop-app
npm install
npm run tauri dev
```

The first run compiles the Rust side and takes a few minutes; later runs are
quick. Changes to the interface reload on save, and changes to the Rust code
rebuild and restart the app.

## Build an installer

```powershell
npm run tauri build
```

The installers are written to `src-tauri/target/release/bundle/`.

## Tests

```powershell
cd src-tauri
cargo test
```

## Using it on your network

- The app listens on **TCP port 8377**. The first time it starts, Windows
  Firewall asks whether to allow it; allow it, or other devices will not be
  able to reach this one.
- Windows often marks a phone hotspot as a *Public* network. If the app was
  only allowed on *Private* networks, phones on the hotspot cannot connect to
  it. Allow it on Public networks too, or change the network's profile to
  Private.
- Closing the window does not quit the app. It stays in the system tray so
  transfers and incoming offers keep working; quit it from the tray icon.

## Where things are kept

Everything is under `%LOCALAPPDATA%\LANclave`:

| What | Where |
|---|---|
| Shared folder (default) | `Sandbox\` — change it in Settings |
| Device name and other settings | `settings.json` |
| Paired devices | `paired_devices.json` |
| Unfinished transfers and open offers | `transfers.json`, `offers.json` |

Deleting the folder resets the app, including its identity: every device
paired with it has to be paired again.

## Layout

```
src/                 Interface (React, TypeScript, Tailwind)
  components/        Pages: peers, files, transfers, settings
  contexts/          Transfer and offer state shared across pages
  api.ts             Calls into the Rust side
src-tauri/src/       Engine (Rust)
  server.rs          The HTTP server other devices talk to
  pairing/           Identity keys, the pairing code, request signing
  discovery.rs       mDNS and the subnet sweep
  presence.rs        Which paired devices are online right now
  offers.rs          Sending: offers, consent, expiry
  transfers.rs       Downloads: queue, pause, resume, persistence
  client/            Requests this device makes to others
  sandbox.rs         Keeps every path inside the shared folder
  tray.rs            System tray and running with the window closed
```
