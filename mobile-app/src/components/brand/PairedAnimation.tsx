import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedProps,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, G, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";

import { C } from "@/constants/colors";
import { AnimatedMark } from "./Mark";
import { CENTRE_Y, clamp01, easeInOut, easeOut } from "./geometry";

/**
 * "Paired" (Motion v2): two devices' streams flow in from either side in
 * their own colours, their lead dots meet in a glow, and the result resolves
 * into the folder with its arrows sliding into place. 1.4 s, plays once.
 *
 * - 0-600 ms: 9 curves per side draw in, a bright head dot leading each side.
 * - 600-850 ms: the head dots meet and merge; the glow peaks. Haptic here.
 * - 850-1400 ms: streams fade to 12%, the folder scales 0.6 -> 1, the
 *   arrows slide in from +/-6 units, and a halo settles.
 *
 * Reduce motion: the final frame, and the haptic still fires.
 */

const W = 360;
const DURATION = 1.4;
const N = 9;
const MID = (N - 1) / 2;

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

/** The i-th stream on a side: a quadratic curve into the centre. */
function curve(side: -1 | 1, i: number) {
  return { x0: side < 0 ? -10 : 370, y0: 180 + (i - MID) * 34, cx: side < 0 ? 120 : 240, ex: 180 + side * 10 };
}
function pointOn(side: -1 | 1, i: number, u: number): [number, number] {
  "worklet";
  const x0 = side < 0 ? -10 : 370, y0 = 180 + (i - MID) * 34, cx = side < 0 ? 120 : 240, ex = 180 + side * 10;
  return [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * ex, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * 180 + u * u * 180];
}
function curveLength(side: -1 | 1, i: number) {
  let len = 0, [px, py] = pointOn(side, i, 0);
  for (let k = 1; k <= 60; k++) {
    const [x, y] = pointOn(side, i, k / 60);
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

function Stream({ side, i, drawn }: { side: -1 | 1; i: number; drawn: SharedValue<number> }) {
  const { x0, y0, cx, ex } = curve(side, i);
  const len = curveLength(side, i);
  const mid = 1 - Math.abs(i - MID) / MID;
  const props = useAnimatedProps(() => ({ strokeDashoffset: len * (1 - drawn.value) }));
  return (
    <AnimatedPath
      d={`M${x0} ${y0}Q${cx} 180 ${ex} 180`}
      fill="none"
      stroke={`url(#s${side}_${i})`}
      strokeWidth={1 + mid}
      strokeDasharray={[len, len]}
      animatedProps={props}
    />
  );
}

function HeadDot({ side, t, drawn, join, color }: { side: -1 | 1; t: SharedValue<number>; drawn: SharedValue<number>; join: SharedValue<number>; color: string }) {
  const at = () => {
    "worklet";
    const [x, y] = pointOn(side, MID, drawn.value);
    return { cx: x - side * 10 * join.value, cy: y, opacity: t.value < 0.85 ? 1 : 0 };
  };
  const outer = useAnimatedProps(at);
  const inner = useAnimatedProps(at);
  return (
    <>
      <AnimatedCircle r={3.5} fill={color} animatedProps={outer} />
      <AnimatedCircle r={1.6} fill="#FFFFFF" animatedProps={inner} />
    </>
  );
}

/**
 * `colors`: this device's stream, then the other device's -- each device's
 * identity colour, so the join shows *which* two devices came together.
 * `bg` is the colour behind the animation (the mark's arrows are painted in it).
 */
export function PairedAnimation({ size = 180, colors, bg = C.surfaceRaised }: { size?: number; colors: [string, string]; bg?: string }) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(reduceMotion ? DURATION : 0);

  useEffect(() => {
    if (reduceMotion) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }
    t.set(withTiming(DURATION, { duration: DURATION * 1000, easing: Easing.linear }));
    const haptic = setTimeout(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }, 850);
    return () => clearTimeout(haptic);
  }, [reduceMotion, t]);

  const drawn = useDerivedValue(() => easeInOut(clamp01(t.value / 0.6)));
  const join = useDerivedValue(() => easeInOut(clamp01((t.value - 0.6) / 0.25)));
  const fade = useDerivedValue(() => 1 - 0.88 * easeOut(clamp01((t.value - 0.85) / 0.45)));
  const glow = useDerivedValue(() =>
    t.value < 0.85 ? clamp01((t.value - 0.5) / 0.35) : 1 - 0.6 * easeOut(clamp01((t.value - 0.85) / 0.55)),
  );
  const u = useDerivedValue(() => clamp01((t.value - 0.85) / 0.55));
  const markScale = useDerivedValue(() => {
    const v = u.value;
    return 0.6 + 0.4 * (1 - Math.pow(1 - v, 3)) + 0.05 * Math.sin(Math.PI * clamp01(v / 0.8)) * (1 - v);
  });
  const markOpacity = useDerivedValue(() => (t.value < 0.85 ? 0 : clamp01(u.value / 0.25)));
  const spread = useDerivedValue(() => 6 * (1 - easeOut(u.value)));
  const arrowOpacity = useDerivedValue(() => clamp01(u.value / 0.4));

  const streams = useAnimatedProps(() => ({ opacity: fade.value }));
  const glowProps = useAnimatedProps(() => ({ r: 30 + 40 * glow.value, opacity: glow.value }));
  const merged = useAnimatedProps(() => ({ opacity: join.value >= 1 && t.value < 0.85 ? 1 : 0 }));

  const k = size / W;
  const mark = 48 * 1.35 * k;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel="Paired">
      <Svg width={size} height={size} viewBox={`0 0 ${W} ${W}`}>
        <Defs>
          {([-1, 1] as const).flatMap((side) =>
            Array.from({ length: N }, (_, i) => {
              const { x0, y0, ex } = curve(side, i);
              const mid = 1 - Math.abs(i - MID) / MID;
              const color = side < 0 ? colors[0] : colors[1];
              return (
                <LinearGradient key={`s${side}_${i}`} id={`s${side}_${i}`} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={ex} y2={180}>
                  <Stop offset="0" stopColor={color} stopOpacity={0} />
                  <Stop offset="1" stopColor={color} stopOpacity={0.35 + 0.55 * mid} />
                </LinearGradient>
              );
            }),
          )}
          <RadialGradient id="glow">
            <Stop offset="0" stopColor={C.action} stopOpacity={0.55} />
            <Stop offset="1" stopColor={C.action} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <AnimatedG animatedProps={streams}>
          {([-1, 1] as const).flatMap((side) =>
            Array.from({ length: N }, (_, i) => <Stream key={`${side}${i}`} side={side} i={i} drawn={drawn} />),
          )}
        </AnimatedG>
        <HeadDot side={-1} t={t} drawn={drawn} join={join} color={colors[0]} />
        <HeadDot side={1} t={t} drawn={drawn} join={join} color={colors[1]} />
        <AnimatedCircle cx={180} cy={180} fill="url(#glow)" animatedProps={glowProps} />
        <AnimatedCircle cx={180} cy={180} r={4} fill="#FFFFFF" animatedProps={merged} />
      </Svg>
      <View style={[styles.mark, { left: (size - mark) / 2, top: (size - mark) / 2 + (24 - CENTRE_Y) * (mark / 48) }]}>
        <AnimatedMark size={mark} color={C.action} bg={bg} scale={markScale} opacity={markOpacity} spread={spread} arrowOpacity={arrowOpacity} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute" },
});
