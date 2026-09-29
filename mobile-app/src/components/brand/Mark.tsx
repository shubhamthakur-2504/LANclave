import { useId } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import Svg, { Mask, Path, Rect } from "react-native-svg";

import { ARROW_BOTTOM, ARROW_TOP, FOLDER } from "./geometry";

/** The LANclave mark. The arrows are a mask, so it sits on any background. */
export function Mark({ size = 32, color }: { size?: number; color: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Mask id={id} maskUnits="userSpaceOnUse" x="-10" y="-10" width="68" height="68">
        <Rect x="-10" y="-10" width="68" height="68" fill="#fff" />
        <Path d={ARROW_TOP + ARROW_BOTTOM} fill="none" stroke="#000" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      </Mask>
      <Path d={FOLDER} fill={color} mask={`url(#${id})`} />
    </Svg>
  );
}

/** "LANclave": LAN bold, clave regular, next to the mark. */
export function Wordmark({ markSize = 26, color, textColor }: { markSize?: number; color: string; textColor: string }) {
  return (
    <View style={styles.row} accessible accessibilityRole="header" accessibilityLabel="LANclave">
      <Mark size={markSize} color={color} />
      <Text style={[styles.word, { color: textColor, fontSize: markSize * 0.72 }]}>
        <Text style={styles.bold}>LAN</Text>clave
      </Text>
    </View>
  );
}

/**
 * The mark with moving parts, for the animations: the folder scales, and
 * each arrow slides and fades on its own. The arrows are painted in `bg`
 * rather than masked -- the motion spec's approach, since a mask would have
 * to be rebuilt every frame -- so `bg` must be the colour behind the mark.
 *
 * Offsets are in mark units (1 unit = size / 48); positive `spread` moves
 * the top arrow left and the bottom arrow right, as when they arrive.
 */
export function AnimatedMark({
  size,
  color,
  bg,
  scale,
  spread,
  topX,
  bottomX,
  arrowOpacity,
  opacity,
}: {
  size: number;
  color: string;
  bg: string;
  scale?: SharedValue<number>;
  spread?: SharedValue<number>;
  topX?: SharedValue<number>;
  bottomX?: SharedValue<number>;
  arrowOpacity?: SharedValue<number>;
  opacity?: SharedValue<number>;
}) {
  const unit = size / 48;
  const whole = useAnimatedStyle(() => ({
    opacity: opacity ? opacity.value : 1,
    transform: [{ scale: scale ? scale.value : 1 }],
  }));
  const top = useAnimatedStyle(() => ({
    opacity: arrowOpacity ? arrowOpacity.value : 1,
    transform: [{ translateX: ((topX ? topX.value : 0) - (spread ? spread.value : 0)) * unit }],
  }));
  const bottom = useAnimatedStyle(() => ({
    opacity: arrowOpacity ? arrowOpacity.value : 1,
    transform: [{ translateX: ((bottomX ? bottomX.value : 0) + (spread ? spread.value : 0)) * unit }],
  }));
  const arrow = (d: string) => (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path d={d} fill="none" stroke={bg} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
  return (
    <Animated.View style={[{ width: size, height: size }, whole]}>
      <Svg width={size} height={size} viewBox="0 0 48 48" style={StyleSheet.absoluteFill}>
        <Path d={FOLDER} fill={color} />
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, top]}>{arrow(ARROW_TOP)}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, bottom]}>{arrow(ARROW_BOTTOM)}</Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  word: { letterSpacing: -0.3, fontWeight: "400" },
  bold: { fontWeight: "700" },
});
