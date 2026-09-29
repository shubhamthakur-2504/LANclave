import { useEffect, useRef } from "react";
import { clamp01, drawMark, easeInOut, easeOut, fitCanvas, prefersReducedMotion, rgb, token } from "./geometry";

/**
 * "Paired" (Motion v2): two devices' streams flow in from either side in
 * their own colours, their lead dots meet in a glow, and the result resolves
 * into the folder with its arrows sliding into place. 1.4 s, plays once.
 *
 * - 0-600 ms: 9 curves per side draw in, a bright head dot leading each side.
 * - 600-850 ms: the head dots meet and merge; the glow peaks.
 * - 850-1400 ms: streams fade to 12%, the folder scales 0.6 -> 1, the
 *   arrows slide in from +/-6 units, and a halo settles.
 *
 * Reduce motion: the final frame.
 */

const W = 360;
const DURATION = 1.4;
const N = 9;

function curvePoint(side: -1 | 1, i: number, u: number): [number, number] {
  const y0 = 180 + (i - (N - 1) / 2) * 34;
  const x0 = side < 0 ? -10 : 370;
  const cx = side < 0 ? 120 : 240;
  const ex = 180 + side * 10;
  const x = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * ex;
  const y = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * 180 + u * u * 180;
  return [x, y];
}

function draw(ctx: CanvasRenderingContext2D, t: number, colors: [string, string]) {
  const accent = token("--color-action") || "#0ea5e9";
  ctx.clearRect(-1e3, -1e3, 3e3, 3e3);

  const drawn = easeInOut(clamp01(t / 0.6));
  const fade = 1 - 0.88 * easeOut(clamp01((t - 0.85) / 0.45));
  const join = easeInOut(clamp01((t - 0.6) / 0.25));
  const glow = t < 0.85 ? clamp01((t - 0.5) / 0.35) : 1 - 0.6 * easeOut(clamp01((t - 0.85) / 0.55));

  ([[-1, colors[0]], [1, colors[1]]] as const).forEach(([side, hex]) => {
    const c = rgb(hex);
    for (let i = 0; i < N; i++) {
      const mid = 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
      const [sx, sy] = curvePoint(side, i, 0);
      const [ex, ey] = curvePoint(side, i, 1);
      const g = ctx.createLinearGradient(sx, sy, ex, ey);
      g.addColorStop(0, `rgba(${c},0)`);
      g.addColorStop(1, `rgba(${c},${(0.35 + 0.55 * mid) * fade})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1 + mid;
      ctx.beginPath();
      for (let k = 0; k <= 40; k++) {
        const [x, y] = curvePoint(side, i, (k / 40) * drawn);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
    if (t < 0.85) {
      const [hx, hy] = curvePoint(side, (N - 1) / 2, drawn);
      const x = hx - side * 10 * join;
      ctx.fillStyle = `rgb(${c})`;
      ctx.beginPath();
      ctx.arc(x, hy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, hy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (glow > 0) {
    const r = 30 + 40 * glow;
    const g = ctx.createRadialGradient(180, 180, 0, 180, 180, r);
    g.addColorStop(0, `rgba(${rgb(accent)},${0.55 * glow})`);
    g.addColorStop(1, `rgba(${rgb(accent)},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(180, 180, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (t >= 0.85) {
    const u = clamp01((t - 0.85) / 0.55);
    const s = 0.6 + 0.4 * (1 - Math.pow(1 - u, 3)) + 0.05 * Math.sin(Math.PI * clamp01(u / 0.8)) * (1 - u);
    ctx.save();
    ctx.globalAlpha = clamp01(u / 0.25);
    drawMark(ctx, 180, 180, 1.35 * s, accent, 6 * (1 - easeOut(u)), clamp01(u / 0.4));
    ctx.restore();
  } else if (join >= 1) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(180, 180, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * `colors`: this device's stream, then the other device's -- each device's
 * identity colour, so the join shows *which* two devices came together.
 */
export default function PairedAnimation({ size = 160, colors }: { size?: number; colors: [string, string] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (prefersReducedMotion()) {
      draw(fitCanvas(cv, W, W), DURATION, colors);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      // performance.now(), not the rAF timestamp: that can be earlier than
      // `start`, making t negative.
      const t = Math.min(Math.max(0, (performance.now() - start) / 1000), DURATION);
      draw(fitCanvas(cv, W, W), t, colors);
      if (t < DURATION) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Plays once per mount; a colour change mid-flight would restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} style={{ width: size, height: size }} role="img" aria-label="Paired" />;
}
