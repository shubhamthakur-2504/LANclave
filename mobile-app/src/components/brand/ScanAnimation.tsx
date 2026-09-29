import { StyleSheet, View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";

import { C } from "@/constants/colors";
import { Mark } from "./Mark";
import { CENTRE_Y, clamp01, easeOut } from "./geometry";

/**
 * "Looking for devices" (Motion v2, scanning): a disc of dots is the local
 * network, a ping sweeps it every 2.4 s, and spokes reach out to nearby
 * nodes, 12 of them staggered over a 4.8 s cycle. Nothing crosses the disc
 * edge -- the search stays local. Same timings as the desktop's canvas.
 *
 * Plain Views driven by one UI-thread clock; no canvas library needed.
 * Reduce motion: the still field, the mark and 6 spokes at half strength.
 */

const W = 360; // design space
const PITCH = 28;
const SPOKES: [number, number][] = [[1, 1], [2, 0], [1, -2], [-1, -1], [-2, 1], [0, 2], [3, 1], [-3, -1], [2, -3], [-1, 3], [3, -2], [-3, 2]];

const DOTS: { x: number; y: number; d: number; spoke: number }[] = [];
for (let i = -6; i <= 6; i++) {
  for (let j = -6; j <= 6; j++) {
    const x = i * PITCH, y = j * PITCH, d = Math.hypot(x, y);
    if (d <= 150 && d > 0) DOTS.push({ x, y, d, spoke: SPOKES.findIndex(([a, b]) => a === i && b === j) });
  }
}

/** A spoke's strength and reach at time t; strength 0 when it is resting. */
function spokeAt(t: number, n: number, still: boolean) {
  "worklet";
  if (still) return n % 2 ? { a: 0, grow: 0 } : { a: 0.5, grow: 1 };
  const lt = (((t - n * 0.4) % 4.8) + 4.8) % 4.8;
  if (lt > 1.6) return { a: 0, grow: 0 };
  return { a: Math.sin((Math.PI * lt) / 1.6), grow: easeOut(clamp01(lt / 0.5)) };
}

function ping(t: number) {
  "worklet";
  const phase = (t % 2.4) / 2.4;
  return { r: easeOut(phase) * 152, a: 1 - phase };
}

function Dot({ x, y, d, spoke, k, clock, still }: (typeof DOTS)[number] & { k: number; clock: SharedValue<number>; still: boolean }) {
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    const p = ping(t);
    const boost = still ? 0 : Math.max(0, 1 - Math.abs(d - p.r) / 16) * 0.6 * p.a;
    const s = spoke >= 0 ? spokeAt(t, spoke, still) : { a: 0, grow: 0 };
    const act = s.grow >= 1 ? s.a : 0;
    return {
      backgroundColor: act ? C.content : C.contentMuted,
      opacity: act ? 0.4 + 0.6 * act : 0.2 + boost,
      transform: [{ scale: (act ? 3.6 : 1.8 + boost * 1.5) / 3.6 }],
    };
  });
  const size = 7.2 * k;
  return <Animated.View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, left: (W / 2 + x) * k - size / 2, top: (W / 2 + y) * k - size / 2 }, style]} />;
}

function Spoke({ i, j, n, k, clock, still }: { i: number; j: number; n: number; k: number; clock: SharedValue<number>; still: boolean }) {
  const x = i * PITCH, y = j * PITCH;
  const len = Math.hypot(x, y) * k;
  const style = useAnimatedStyle(() => {
    const s = spokeAt(clock.value, n, still);
    return { opacity: 0.55 * s.a, transform: [{ rotate: `${Math.atan2(y, x)}rad` }, { scaleX: s.grow }] };
  });
  const h = 1.5 * k;
  return <Animated.View style={[styles.spoke, { width: len, height: h, left: (W / 2) * k, top: (W / 2) * k - h / 2 }, style]} />;
}

function Ping({ k, clock }: { k: number; clock: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const p = ping(clock.value);
    const size = 2 * p.r * k;
    return { width: size, height: size, borderRadius: size / 2, left: (W / 2) * k - size / 2, top: (W / 2) * k - size / 2, opacity: 0.4 * p.a };
  });
  return <Animated.View style={[styles.ping, { borderWidth: 2 * k }, style]} />;
}

export function ScanAnimation({ size = 200 }: { size?: number }) {
  const still = useReducedMotion();
  const k = size / W;
  const clock = useSharedValue(0);
  useFrameCallback((f) => {
    clock.value = f.timeSinceFirstFrame / 1000;
  }, !still);

  const edge = 2 * 166 * k;
  const hole = 2 * 26 * k;
  const mark = 48 * 0.8 * k;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel="Looking for devices">
      <View style={[styles.edge, { width: edge, height: edge, borderRadius: edge / 2, left: (size - edge) / 2, top: (size - edge) / 2, borderWidth: 1.5 * k }]} />
      {!still && <Ping k={k} clock={clock} />}
      {SPOKES.map(([i, j], n) => (
        <Spoke key={n} i={i} j={j} n={n} k={k} clock={clock} still={still} />
      ))}
      {DOTS.map((p) => (
        <Dot key={`${p.x},${p.y}`} {...p} k={k} clock={clock} still={still} />
      ))}
      {/* A clear disc for the mark, so spokes never run under it. */}
      <View style={[styles.hole, { width: hole, height: hole, borderRadius: hole / 2, left: (size - hole) / 2, top: (size - hole) / 2 }]} />
      <View style={{ position: "absolute", left: (size - mark) / 2, top: (size - mark) / 2 + (24 - CENTRE_Y) * (mark / 48) }}>
        <Mark size={mark} color={C.action} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { position: "absolute" },
  spoke: { position: "absolute", backgroundColor: C.content, transformOrigin: "left center" },
  ping: { position: "absolute", borderColor: C.action },
  edge: { position: "absolute", borderColor: C.border },
  hole: { position: "absolute", backgroundColor: C.surface },
});
