# LANclave brand assets

The mark is **4e "Rounder"**: a folder with two-way arrows knocked out of it.
It was designed in Claude Design (project "LANclave Logo Directions",
`LANclave Brand Sheet.dc.html`), whose `tools/gen.js` supplies the geometry
ported into `gen.mjs`.

```
node branding/gen.mjs
```

This regenerates every icon from the SVG masters and copies the results into
both apps. It needs Edge or Chrome, for rasterising, and the desktop app's
`npm install` for `tauri icon`.

| Output | Used by |
|---|---|
| `desktop-app/src-tauri/icons/icon.ico` | Windows exe, taskbar, title bar. 16 and 24 px entries are the tuned masters, not downscales |
| `desktop-app/src-tauri/icons/tray.png` | System tray (`tray.rs`) |
| `desktop-app/src-tauri/icons/*.png`, `icon.icns`, `Square*Logo.png` | Tauri bundle and Store tiles |
| `mobile-app/assets/images/icon.png` | App icon |
| `mobile-app/assets/images/android-icon-{foreground,background,monochrome}.png` | Android adaptive icon (background `#0EA5E9`) |
| `mobile-app/assets/images/splash-icon-{light,dark}.png` | Splash, on `#F6F8FC` / `#080C14` |

Rules from the brand sheet:
- Below 24 px, always use the tuned 16 and 24 px masters.
- Minimum size is 16 px for the mark and 80 px wide for the lockup.
- Never recolour or stretch the mark, and always write the name as **LANclave**.

The animations (launch, scanning, paired, transfer) are specified in
[`motion-spec.md`](./motion-spec.md) but not built yet.
