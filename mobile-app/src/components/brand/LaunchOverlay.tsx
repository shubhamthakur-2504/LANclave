import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { AnimatedMark } from "./Mark";
import { CENTRE_Y } from "./geometry";

/**
 * Launch (motion spec): picks up from the native splash on its exact frame,
 * the arrows exchange once and the folder swells 3%, then it crossfades to
 * the app. 1 s + 200 ms.
 *
 * It must match the splash in app.json: the 1024 px splash image is drawn
 * 200 dp wide, and the mark inside it is 504 px (10.5 px per unit) centred
 * on its (24, 24.5) point -- so here 1 unit = 10.5 * 200 / 1024 dp.
 */
const UNIT = (10.5 * 200) / 1024;
const MARK = 48 * UNIT;

const STANDARD = Easing.bezier(0.4, 0, 0.2, 1);
const DECELERATE = Easing.bezier(0.2, 0, 0, 1);

const THEMES = {
  dark: { bg: "#080C14", accent: "#0EA5E9" },
  light: { bg: "#F6F8FC", accent: "#0284C7" },
};

export function LaunchOverlay() {
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const { bg, accent } = THEMES[scheme];
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(true);

  const topX = useSharedValue(0);
  const bottomX = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const start = () => {
    const done = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(setVisible, false);
    };
    if (reduceMotion) {
      // Hold the splash frame, then crossfade.
      opacity.set(withDelay(300, withTiming(0, { duration: 200, easing: Easing.linear }, done)));
      return;
    }
    const exchange = (to: number) =>
      withSequence(
        withDelay(150, withTiming(to, { duration: 400, easing: STANDARD })),
        withTiming(0, { duration: 450, easing: DECELERATE }),
      );
    topX.set(exchange(3));
    bottomX.set(exchange(-3));
    scale.set(withSequence(
      withDelay(150, withTiming(1.03, { duration: 400, easing: STANDARD })),
      withTiming(1, { duration: 450, easing: DECELERATE }),
    ));
    opacity.set(withDelay(1000, withTiming(0, { duration: 200, easing: Easing.linear }, done)));
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.overlay, { backgroundColor: bg }, fade]}
      pointerEvents="none"
      onLayout={() => {
        // Our first frame is on screen and identical to the splash: swap.
        SplashScreen.hideAsync().finally(start);
      }}
    >
      {/* The mark is centred on its (24, 24.5) point, as in the splash image. */}
      <View style={{ transform: [{ translateY: (24 - CENTRE_Y) * UNIT }] }}>
        <AnimatedMark size={MARK} color={accent} bg={bg} topX={topX} bottomX={bottomX} scale={scale} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
});
