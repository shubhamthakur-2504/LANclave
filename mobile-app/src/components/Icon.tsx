/**
 * Icon — the single icon surface for mobile.
 *
 * Wraps `expo-symbols`, which renders Material Symbols from a font that ships
 * inside the bundle (`@expo-google-fonts/material-symbols`). That matters
 * here: LANclave is a LAN-only app that must work with no internet at all, so
 * an icon set that fetches anything at runtime would be wrong.
 *
 * This replaces the emoji that were used for tab bar and file icons. Emoji
 * cannot be tinted to match the active tab colour and render differently on
 * every Android version, which was the loudest "unfinished" signal in the UI.
 *
 * Names are semantic (`peers`, `send`) rather than glyph names, so swapping
 * the underlying icon set later is a change to this file alone.
 */

import { SymbolView } from "expo-symbols";
import { Text, type ColorValue, type StyleProp, type ViewStyle } from "react-native";

export type IconName =
  | "sandbox"
  | "peers"
  | "scan"
  | "transfers"
  | "settings"
  | "check"
  | "close"
  | "search"
  | "refresh"
  | "send"
  | "download"
  | "upload"
  | "laptop"
  | "phone"
  | "device"
  | "shield"
  | "wifi"
  | "wifiOff"
  | "folder"
  | "file"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "code"
  | "add"
  | "trash"
  | "chevronRight"
  | "chevronLeft"
  | "alert";

/** Semantic name → Material Symbol, and an emoji of last resort. */
const SYMBOLS: Record<IconName, { android: string; fallback: string }> = {
  sandbox: { android: "inventory_2", fallback: "▣" },
  peers: { android: "handshake", fallback: "◎" },
  scan: { android: "wifi_tethering", fallback: "◌" },
  transfers: { android: "swap_vert", fallback: "⇅" },
  settings: { android: "settings", fallback: "⚙" },
  check: { android: "check", fallback: "✓" },
  close: { android: "close", fallback: "✕" },
  search: { android: "search", fallback: "⌕" },
  refresh: { android: "refresh", fallback: "↻" },
  send: { android: "send", fallback: "→" },
  download: { android: "download", fallback: "↓" },
  upload: { android: "upload", fallback: "↑" },
  laptop: { android: "laptop_mac", fallback: "▭" },
  phone: { android: "smartphone", fallback: "▯" },
  device: { android: "devices", fallback: "▢" },
  shield: { android: "shield_lock", fallback: "⛨" },
  wifi: { android: "wifi", fallback: "≋" },
  wifiOff: { android: "wifi_off", fallback: "≁" },
  folder: { android: "folder", fallback: "▤" },
  file: { android: "draft", fallback: "▧" },
  image: { android: "image", fallback: "▨" },
  video: { android: "movie", fallback: "▶" },
  audio: { android: "graphic_eq", fallback: "♪" },
  document: { android: "description", fallback: "▤" },
  archive: { android: "folder_zip", fallback: "▦" },
  code: { android: "code", fallback: "❮" },
  add: { android: "add", fallback: "＋" },
  trash: { android: "delete", fallback: "🗑" },
  chevronRight: { android: "chevron_right", fallback: "›" },
  chevronLeft: { android: "chevron_left", fallback: "‹" },
  alert: { android: "error", fallback: "!" },
};

interface IconProps {
  name: IconName;
  size?: number;
  /** ColorValue, not string: tab bars hand back a platform colour object. */
  color: ColorValue;
  style?: StyleProp<ViewStyle>;
}

export function Icon({ name, size = 22, color, style }: IconProps) {
  const symbol = SYMBOLS[name];

  return (
    <SymbolView
      // SymbolView resolves a per-platform record on Android; the cast keeps
      // that shape without dragging the SF Symbols union into our call sites.
      name={{ android: symbol.android, web: symbol.android } as never}
      size={size}
      tintColor={color as string}
      style={style}
      fallback={
        <Text style={{ fontSize: size * 0.9, color, lineHeight: size }}>
          {symbol.fallback}
        </Text>
      }
    />
  );
}
