/**
 * The LANclave mark: a folder with two-way arrows knocked out of it.
 *
 * 48-unit master geometry from branding/gen.mjs (Claude Design's
 * tools/gen.js), shared by every drawing of the mark on the phone. Motion
 * timings live in branding/motion-spec.md and Claude Design's Motion v2.
 */

export const FOLDER =
  "M5 15a6 6 0 0 1 6-6h6.5a2.5 2.5 0 0 1 2.5 2.5V13a1 1 0 0 0 1 1H37a6 6 0 0 1 6 6v13a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7Z";
export const ARROW_TOP = "M15 22.5H31M27.5 19l3.5 3.5-3.5 3.5";
export const ARROW_BOTTOM = "M33 32H17M20.5 28.5L17 32l3.5 3.5";
/** The point the mark is centred on, in 48-unit coordinates. */
export const CENTRE_Y = 24.5;

// Worklet-safe easing helpers: the animations compute their frames on the UI thread.
export function clamp01(t: number) {
  "worklet";
  return Math.max(0, Math.min(1, t));
}
export function easeOut(t: number) {
  "worklet";
  return 1 - Math.pow(1 - t, 3);
}
export function easeInOut(t: number) {
  "worklet";
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
