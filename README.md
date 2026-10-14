<p align="center">
  <img src="branding/svg/app-icon.svg" width="96" alt="LANclave logo">
</p>

<h1 align="center">LANclave</h1>

<p align="center">Local network file vault. No internet, ever.</p>

LANclave moves files between your devices over the Wi-Fi network they already
share. Nothing goes through the internet or a cloud account: the devices find
each other on the local network, you pair them once, and from then on each can
browse the other's shared folder and send or fetch files directly.

It also works over a phone hotspot, so two devices can exchange files with no
router and no mobile data.

## The apps

| App | Runs on | Built with | Setup |
|---|---|---|---|
| Desktop | Windows 10 and 11 | Tauri, Rust, React | [desktop-app/README.md](desktop-app/README.md) |
| Mobile | Android 13 and later | Expo, React Native, Kotlin | [mobile-app/README.md](mobile-app/README.md) |

Any pair works: phone and desktop, two desktops, or two phones.

## What it does

**Find and pair**

- Devices running LANclave on the same network appear on their own.
- Pairing shows the same 6-digit code on both screens. You confirm it once;
  after that the two devices recognise each other silently.
- Only one pairing can be in progress at a time, and a device that keeps
  getting rejected is muted for longer each time.

**Share a folder, not the whole disk**

- Each device shares exactly one folder, its *sandbox*. A paired device can
  see and fetch what is in it and nothing outside it.
- You choose the folder in Settings.

**Send and fetch**

- Browse a paired device's sandbox and download what you want, without anyone
  on the other side pressing Send.
- Or send files to a device: it shows what is being offered and its owner
  accepts or declines. A trusted device can be set to always accept.
- On the desktop, drop files onto a device to send them. On the phone, use
  Share from any other app and pick LANclave.

**Transfers that survive real networks**

- Pause and resume. An interrupted download continues from where it stopped,
  including after the app restarts.
- Every finished file is checked against the sender's copy with SHA-256.
- A file the destination already has is skipped. A different file with the
  same name is kept alongside it as `name (1).ext`; nothing is overwritten.
- Downloads from one device are queued, two at a time by default.
- A history of what was sent and received.

**Around the edges**

- Open a received file straight from the app. Programs and scripts ask for
  confirmation first and say which device they came from.
- The desktop app keeps running in the system tray after its window is
  closed, and notifies you when an offer arrives.
- The phone keeps a transfer going while the app is in the background.

## How it works

**Discovery.** Each device announces itself with mDNS. Because hotspots often
block that, the apps also check the network's gateway address and sweep the
local subnet for other LANclave devices on port 8377.

**Pairing.** Each device creates an Ed25519 key pair the first time it runs;
the public key is the device's identity. The 6-digit code is derived from both
devices' public keys, so matching codes mean each side holds the other's real
key.

**Encryption.** Every device runs a small server that speaks TLS 1.3 and
nothing else. There is no certificate authority: each device makes a TLS key
when it starts, and its identity key signs for it inside the certificate. So
the handshake alone tells a client which device it has reached, and files and
names are only ever sent to a device in the paired list.

**Requests.** Every request to a device, apart from the ones used for
discovery and pairing, must also be signed by a paired device's key and carry
a fresh timestamp. Requests from anything else are refused.

**Transfers.** All transfers are downloads by the receiving device. Sending is
an offer; once accepted, the receiver pulls each file with resumable HTTP
range requests and verifies it when it is complete.

## Security, plainly

- Only paired devices can list or fetch files, and only from the one sandbox
  folder. Paths that try to leave it are refused.
- Everything between devices is encrypted, and each side checks it reached
  the device it paired with, not just any device at that address.
- Version 1 of LANclave did not encrypt. A version 2 device will not talk to
  it, and lists it as "Needs update".

## Limits

- Both devices must be on the same local network at the same time.
- A phone can only be found, browsed or sent to while LANclave is open on it
  with its server on. The server starts with the app and can be switched off.
  With the app closed, the phone is not reachable.
- Android 13 or later. There is no iPhone version.
- Only the top level of the sandbox is listed; subfolders cannot be browsed
  yet.

## Repository layout

```
desktop-app/   Windows app: React interface, Rust engine (src-tauri/)
mobile-app/    Android app: React Native interface, Kotlin engine
               (modules/expo-native-server/)
branding/      Logo masters and the script that generates every icon
```

## Coming next

A private text thread between paired devices for passing links and codes,
subfolder browsing, blocking a device that keeps asking to pair, and mirroring
a phone's screen in a desktop window.

## Author

Built by [Shubham Thakur](https://github.com/shubhamthakur-2504).
