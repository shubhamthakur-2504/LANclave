# LANclave motion spec

From Claude Design (`assets/anim/motion-spec.md`). All motion uses the master
mark (48-unit grid). The two arrows are the only moving parts, plus an
optional small scale on the whole folder. The arrows are knocked out of the
folder, so in React Native build them as two separate paths drawn in the
background colour (or as a MaskedView) and animate `translateX` / `opacity`.

Units: 1 unit = mark size / 48 (at 192 px, 1 unit = 4 px).
Easing names:
- **standard** = cubic-bezier(0.4, 0, 0.2, 1)
- **decelerate** = cubic-bezier(0.2, 0, 0, 1)

Reanimated: `Easing.bezier(0.4, 0, 0.2, 1)`.

Top arrow = →, bottom arrow = ←.

## Launch: 1000 ms, plays once
It starts on the exact splash frame (same mark, same position, same
background colour), so the hand-off from the Expo splash is invisible.

| Time | Top arrow x | Bottom arrow x | Folder scale | Easing into this key |
|---|---|---|---|---|
| 0 ms | 0 | 0 | 1.00 | — |
| 150 ms | 0 | 0 | 1.00 | linear (hold) |
| 550 ms | +3 | −3 | 1.03 | standard |
| 1000 ms | 0 | 0 | 1.00 | decelerate |

After 1000 ms the app may crossfade to the first screen (200 ms, linear).

## Scanning for nearby devices: 2400 ms loop
The arrows take turns with a small nudge. Nothing leaves the folder.

| Time | Top x | Bottom x |
|---|---|---|
| 0 ms | 0 | 0 |
| 600 ms | +2.5 | 0 |
| 1200 ms | 0 | 0 |
| 1800 ms | 0 | −2.5 |
| 2400 ms | 0 | 0 |

- Every segment uses standard easing, with `withRepeat(..., -1)`.
- When the scan ends, finish the current cycle; don't cut it off mid-nudge.

## Paired successfully: 800 ms, plays once
The folder starts solid with no arrows. The two arrows arrive from opposite
sides, which stands for the two devices joining, and the folder gives a small
bump.

| Time | Top x / opacity | Bottom x / opacity | Folder scale | Easing |
|---|---|---|---|---|
| 0 ms | −6 / 0 | +6 / 0 | 1.00 | — |
| 320 ms | — / 1 | — / 1 | — | linear (opacity) |
| 400 ms | +0.8 | −0.8 | 1.00 | decelerate |
| 560 ms | 0 | 0 | 1.05 | standard |
| 800 ms | 0 | 0 | 1.00 | standard |

- Pair it with a success haptic at 400 ms (`Haptics.notificationAsync(Success)`).
- A spring alternative is `withSpring(0, { damping: 18, stiffness: 220 })` on x, starting from ±6.

## Transfer in progress (optional): 1200 ms loop
- Sending: the top arrow moves from −3 to +3 with easing
  cubic-bezier(0.4, 0, 0.6, 1). Its opacity goes 0 → 1 (at 25%) → 1 (at 75%) → 0.
- The bottom arrow stays still at 35% opacity.
- Receiving: mirror it, so the bottom arrow travels from +3 to −3 and the top
  arrow is dimmed.

## Reduce motion
In every case, show the static master mark (`svg/mark.svg`) with no movement.
- **Launch:** the splash image is held, then a 200 ms crossfade to the first screen.
- **Scanning:** the static mark, plus the text "Looking for devices…" and an indeterminate text-only status.
- **Paired:** the static mark with the arrows present, the success colour on the confirmation text, and the haptic still fires.
- **Transfer:** the static mark plus the progress bar or percentage.
