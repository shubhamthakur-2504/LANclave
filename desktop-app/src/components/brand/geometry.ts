/**
 * The LANclave mark: a folder with two-way arrows knocked out of it.
 *
 * Geometry is the 48-unit master from branding/gen.mjs (and Claude Design's
 * tools/gen.js). Canvas animations share it from here so every drawing of the
 * mark agrees with the icons.
 */

export const FOLDER =
  "M5 15a6 6 0 0 1 6-6h6.5a2.5 2.5 0 0 1 2.5 2.5V13a1 1 0 0 0 1 1H37a6 6 0 0 1 6 6v13a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7Z";
export const ARROW_TOP = "M15 22.5H31M27.5 19l3.5 3.5-3.5 3.5";
export const ARROW_BOTTOM = "M33 32H17M20.5 28.5L17 32l3.5 3.5";
/** The point the mark is centred on, in 48-unit coordinates. */
export const CENTRE = [24, 24.5] as const;

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

let paths: { folder: Path2D; top: Path2D; bottom: Path2D } | null = null;
function markPaths() {
  paths ??= { folder: new Path2D(FOLDER), top: new Path2D(ARROW_TOP), bottom: new Path2D(ARROW_BOTTOM) };
  return paths;
}

/**
 * Draw the mark centred on (x, y) at `scale` units per px. The arrows are
 * cut out with destination-out, so the mark is correct on any background.
 * `dx` spreads the arrows apart (top left, bottom right) for the slide-in.
 */
export function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  fill: string,
  dx = 0,
  arrowAlpha = 1,
) {
  const p = markPaths();
  ctx.save();
  ctx.translate(x - CENTRE[0] * scale, y - CENTRE[1] * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = fill;
  ctx.fill(p.folder);
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha *= arrowAlpha;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000";
  ctx.save();
  ctx.translate(-dx, 0);
  ctx.stroke(p.top);
  ctx.restore();
  ctx.save();
  ctx.translate(dx, 0);
  ctx.stroke(p.bottom);
  ctx.restore();
  ctx.restore();
}

/** The current value of a theme token, e.g. `--color-action`. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** `#38bdf8` -> `56,189,248`, for rgba() strings. */
export function rgb(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Size a canvas to its CSS box at device pixel ratio and map a W x H design
 * space into it, centred. Returns the context ready to draw in design units.
 */
export function fitCanvas(cv: HTMLCanvasElement, W: number, H: number) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const ctx = cv.getContext("2d")!;
  const k = Math.min(cv.width / W, cv.height / H);
  ctx.setTransform(k, 0, 0, k, (cv.width - W * k) / 2, (cv.height - H * k) / 2);
  return ctx;
}
