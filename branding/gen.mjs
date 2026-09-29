// LANclave brand assets: SVG masters -> the PNG/ICO files each app ships.
//
// Geometry is Claude Design's generator (project "LANclave Logo Directions",
// tools/gen.js), mark 4e: folder with two-way arrows knocked out, drawn on
// 48 / 24 / 16 unit grids. The 24 and 16 grids are hand-tuned masters for
// small sizes -- never downscale the 48 master into them.
//
//   node branding/gen.mjs
//
// Writes branding/svg/*.svg, rasterises through headless Edge/Chrome (exact
// pixel sizes, transparent where the SVG is), then copies the results into
// desktop-app/src-tauri/icons and mobile-app/assets/images.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const ACCENT = "#0EA5E9";
const ACCENT_LIGHT = "#0284C7";

const G = {
  48: { vb: 48, sw: 5, p: "M5 15a6 6 0 0 1 6-6h6.5a2.5 2.5 0 0 1 2.5 2.5V13a1 1 0 0 0 1 1H37a6 6 0 0 1 6 6v13a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7Z", a: "M15 22.5H31M27.5 19l3.5 3.5-3.5 3.5M33 32H17M20.5 28.5L17 32l3.5 3.5" },
  24: { vb: 24, sw: 3, p: "M2 6.5A3.5 3.5 0 0 1 5.5 3H8.5A1.5 1.5 0 0 1 10 4.5V6H18.5A3.5 3.5 0 0 1 22 9.5V17.5A3.5 3.5 0 0 1 18.5 21H5.5A3.5 3.5 0 0 1 2 17.5Z", a: "M6.5 11.5H16M14 9.5l2 2-2 2M17.5 16.5H8M10 14.5l-2 2 2 2" },
  16: { vb: 16, sw: 2, p: "M1 4a2 2 0 0 1 2-2h3a1 1 0 0 1 1 1v.5h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z", a: "M4 7H11M9 5l2 2M12 11H5M7 13l-2-2" },
};

let uid = 0;
const glyph = (v, fill) => {
  const g = G[v], id = "k" + uid++, e = g.vb + 20;
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="${e}" height="${e}"><rect x="-10" y="-10" width="${e}" height="${e}" fill="#fff"/><path d="${g.a}" fill="none" stroke="#000" stroke-width="${g.sw}" stroke-linecap="round" stroke-linejoin="round"/></mask><path d="${g.p}" fill="${fill}" mask="url(#${id})"/>`;
};
const doc = (w, h, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ""}${body}</svg>`;
const place = (v, fill, cx, cy, s) => {
  const c = v === 48 ? [24, 24.5] : [G[v].vb / 2, G[v].vb / 2];
  return `<g transform="translate(${cx - c[0] * s} ${cy - c[1] * s}) scale(${s})">${glyph(v, fill)}</g>`;
};
const tile = (s, inner) => doc(s, s, `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="${ACCENT}"/>` + inner);

// name -> [svg, [[pixelSize, outputPng], ...]]
const SOURCES = {
  "mark.svg": [doc(48, 48, glyph(48, ACCENT)), [[48, "out/mark-48.png"], [512, "out/mark-512.png"]]],
  "mark-on-light.svg": [doc(48, 48, glyph(48, ACCENT_LIGHT)), []],
  "mark-white.svg": [doc(48, 48, glyph(48, "#FFFFFF")), []],
  "mark-24.svg": [doc(24, 24, glyph(24, ACCENT)), [[24, "out/mark-24.png"]]],
  "mark-16.svg": [doc(16, 16, glyph(16, ACCENT)), [[16, "out/mark-16.png"], [32, "out/tray-32.png"]]],
  "android-icon-foreground.svg": [doc(108, 108, place(48, "#FFFFFF", 54, 54, 1.25)), [[1024, "out/android-icon-foreground.png"]]],
  // Android themes this layer from its alpha, so the white foreground doubles as it.
  "android-icon-monochrome.svg": [doc(108, 108, place(48, "#FFFFFF", 54, 54, 1.25)), [[1024, "out/android-icon-monochrome.png"]]],
  "android-icon-background.svg": [doc(108, 108, "", ACCENT), [[1024, "out/android-icon-background.png"]]],
  "app-icon.svg": [doc(108, 108, place(48, "#FFFFFF", 54, 54, 1.7), ACCENT), [[1024, "out/icon-1024.png"], [48, "out/favicon-48.png"]]],
  // Windows: the full tile down to 48 px, then the tuned masters below that.
  "windows-icon.svg": [tile(256, place(48, "#FFFFFF", 128, 128, 4.1)), [[1024, "out/win-1024.png"], [256, "out/win-256.png"], [128, "out/win-128.png"], [64, "out/win-64.png"], [48, "out/win-48.png"]]],
  "windows-icon-32.svg": [tile(32, `<g transform="translate(4 4)">${glyph(24, "#FFFFFF")}</g>`), [[32, "out/win-32.png"]]],
  "windows-icon-24.svg": [tile(24, `<g transform="translate(4 4)">${glyph(16, "#FFFFFF")}</g>`), [[24, "out/win-24.png"]]],
  "windows-icon-16.svg": [doc(16, 16, glyph(16, ACCENT)), [[16, "out/win-16.png"]]],
  "splash-icon-dark.svg": [doc(1024, 1024, place(48, ACCENT, 512, 512, 10.5)), [[1024, "out/splash-icon-dark.png"]]],
  "splash-icon-light.svg": [doc(1024, 1024, place(48, ACCENT_LIGHT, 512, 512, 10.5)), [[1024, "out/splash-icon-light.png"]]],
};

function findBrowser() {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("need Edge or Chrome to rasterise the SVGs");
  return hit;
}

// Rasterise every (svg, size) pair in one headless page: each SVG is drawn
// onto a canvas of exactly that size and the PNGs come back through the DOM.
function rasterise(jobs) {
  const page = `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const jobs = ${JSON.stringify(jobs)};
Promise.all(jobs.map(([svg, size]) => new Promise((ok, fail) => {
  const img = new Image();
  img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = size;
    c.getContext("2d").drawImage(img, 0, 0, size, size); ok(c.toDataURL("image/png").split(",")[1]); };
  img.onerror = fail;
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}))).then((pngs) => { const m = "@" + "@PNG" + "S@@"; document.getElementById("out").textContent = m + JSON.stringify(pngs) + m; });
</script>`;
  const tmp = join(ROOT, "out", "_rasterise.html");
  writeFileSync(tmp, page);
  const dom = execFileSync(findBrowser(), ["--headless=new", "--disable-gpu", "--virtual-time-budget=10000", "--dump-dom", pathToFileURL(tmp).href], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  // The marker is split in the page source so only the output contains it whole.
  const m = dom.match(/@@PNGS@@(.*)@@PNGS@@/s);
  if (!m) throw new Error("rasterising failed: no output from the browser");
  return JSON.parse(m[1]);
}

// A PNG-compressed .ico: one directory entry per size, PNG bytes stored as-is.
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(([, b]) => b)]);
}

mkdirSync(join(ROOT, "svg"), { recursive: true });
mkdirSync(join(ROOT, "out"), { recursive: true });

const jobs = [], targets = [];
for (const [name, [svg, outs]] of Object.entries(SOURCES)) {
  writeFileSync(join(ROOT, "svg", name), svg + "\n");
  for (const [size, out] of outs) { jobs.push([svg, size]); targets.push(out); }
}
const pngs = rasterise(jobs);
const built = {};
targets.forEach((t, i) => { built[t] = Buffer.from(pngs[i], "base64"); writeFileSync(join(ROOT, t), built[t]); });

const icoBytes = ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, built[`out/win-${s}.png`]]));
writeFileSync(join(ROOT, "out", "icon.ico"), icoBytes);

// Into the apps.
const copy = (from, to) => { mkdirSync(dirname(join(REPO, to)), { recursive: true }); writeFileSync(join(REPO, to), readFileSync(join(ROOT, from))); };
const icons = "desktop-app/src-tauri/icons";
copy("out/icon.ico", `${icons}/icon.ico`);
copy("out/win-32.png", `${icons}/32x32.png`);
copy("out/win-128.png", `${icons}/128x128.png`);
copy("out/win-256.png", `${icons}/128x128@2x.png`);
copy("out/win-1024.png", `${icons}/icon.png`);
copy("out/tray-32.png", `${icons}/tray.png`);
// The macOS .icns and the Windows Store tiles come from `tauri icon`, which
// only downscales one master; its .ico and small PNGs are skipped in favour
// of the tuned ones above.
const tauriOut = join(ROOT, "out", "tauri-icon");
execSync(`npx tauri icon "${join(ROOT, "out", "win-1024.png")}" -o "${tauriOut}"`, { cwd: join(REPO, "desktop-app"), stdio: "ignore" });
for (const f of ["icon.icns", "StoreLogo.png", ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((s) => `Square${s}x${s}Logo.png`)]) {
  copy(`out/tauri-icon/${f}`, `${icons}/${f}`);
}
const img = "mobile-app/assets/images";
copy("out/icon-1024.png", `${img}/icon.png`);
copy("out/android-icon-foreground.png", `${img}/android-icon-foreground.png`);
copy("out/android-icon-background.png", `${img}/android-icon-background.png`);
copy("out/android-icon-monochrome.png", `${img}/android-icon-monochrome.png`);
copy("out/splash-icon-dark.png", `${img}/splash-icon-dark.png`);
copy("out/splash-icon-light.png", `${img}/splash-icon-light.png`);
copy("out/favicon-48.png", `${img}/favicon.png`);

console.log(`wrote ${targets.length} PNGs, icon.ico (${icoBytes.length} bytes), and copied them into both apps`);
