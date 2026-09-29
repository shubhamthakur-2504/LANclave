import { useEffect, useRef } from "react";
import { clamp01, drawMark, easeOut, fitCanvas, prefersReducedMotion, rgb, token } from "./geometry";

/**
 * "Looking for devices" (Motion v2, scanning): a disc of dots is the local
 * network, a ping sweeps it every 2.4 s, and spokes reach out to nearby
 * nodes, 12 of them staggered over a 4.8 s cycle. Nothing crosses the disc
 * edge -- the search stays local.
 *
 * Reduce motion: the still field, the mark and 6 spokes at half strength.
 */

const W = 360;
const PITCH = 28;
const RADIUS = 150;
const SPOKES: [number, number][] = [[1, 1], [2, 0], [1, -2], [-1, -1], [-2, 1], [0, 2], [3, 1], [-3, -1], [2, -3], [-1, 3], [3, -2], [-3, 2]];

const DOTS: { x: number; y: number; d: number }[] = [];
for (let i = -6; i <= 6; i++) {
  for (let j = -6; j <= 6; j++) {
    const x = i * PITCH, y = j * PITCH, d = Math.hypot(x, y);
    if (d <= RADIUS && d > 0) DOTS.push({ x, y, d });
  }
}

function draw(ctx: CanvasRenderingContext2D, t: number, still: boolean) {
  const accent = token("--color-action") || "#0ea5e9";
  const content = rgb(token("--color-content") || "#e8edf5");
  const muted = rgb(token("--color-content-muted") || "#94a3b8");
  const edge = token("--color-border") || "#1e2a3f";

  ctx.clearRect(-1e3, -1e3, 3e3, 3e3);
  ctx.save();
  ctx.translate(W / 2, W / 2);

  const phase = (t % 2.4) / 2.4;
  const pingR = Math.max(0, easeOut(phase) * 152); // arc() throws on a negative radius
  const pingA = 1 - phase;

  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 166, 0, Math.PI * 2);
  ctx.stroke();

  if (!still) {
    ctx.strokeStyle = `rgba(${rgb(accent)},${0.4 * pingA})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, pingR, 0, Math.PI * 2);
    ctx.stroke();
  }

  const lit = new Map<string, number>();
  SPOKES.forEach(([i, j], n) => {
    let a: number, grow: number;
    if (still) {
      if (n % 2) return;
      a = 0.5;
      grow = 1;
    } else {
      const lt = (((t - n * 0.4) % 4.8) + 4.8) % 4.8;
      if (lt > 1.6) return;
      grow = easeOut(clamp01(lt / 0.5));
      a = Math.sin((Math.PI * lt) / 1.6);
    }
    const x = i * PITCH, y = j * PITCH;
    ctx.strokeStyle = `rgba(${content},${0.55 * a})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(x * grow, y * grow);
    ctx.stroke();
    if (grow >= 1) lit.set(`${x},${y}`, a);
  });

  for (const p of DOTS) {
    const boost = still ? 0 : Math.max(0, 1 - Math.abs(p.d - pingR) / 16) * 0.6 * pingA;
    const act = lit.get(`${p.x},${p.y}`) ?? 0;
    ctx.fillStyle = act ? `rgba(${content},${0.4 + 0.6 * act})` : `rgba(${muted},${0.2 + boost})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, act ? 3.6 : 1.8 + boost * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Clear a disc for the mark, so spokes and dots never run under it.
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(0, 0, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawMark(ctx, 0, 0, 0.8, accent);
  ctx.restore();
}

export default function ScanAnimation({ size = 200 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (prefersReducedMotion()) {
      draw(fitCanvas(cv, W, W), 0, true);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      // Queue the next frame first: one frame that throws must not end the
      // loop, which is how the field used to freeze after its boundary ring.
      raf = requestAnimationFrame(loop);
      // performance.now(), not the rAF timestamp: that is the frame's start
      // time and can be earlier than `start`, making t negative.
      draw(fitCanvas(cv, W, W), Math.max(0, (performance.now() - start) / 1000), false);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} style={{ width: size, height: size }} role="img" aria-label="Looking for devices" />;
}
