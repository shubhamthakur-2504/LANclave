/**
 * Visual identity for a peer.
 *
 * The avatar used to show the first character of the base64 public key, which
 * is meaningless to a reader and changes nothing about what they know. It now
 * shows the device-name initial, and where there is no name, a device glyph.
 *
 * The colour is derived from the device id, so a peer keeps the same colour
 * everywhere and on every launch. That doubles as a lightweight identity
 * check: a peer whose colour suddenly changed is not the peer you paired.
 */

export type DeviceKind = "laptop" | "phone" | "tablet" | "unknown";

/** Stable per-device colour. Kept in step with mobile's `idColor()`. */
const PALETTE = [
  "#38BDF8",
  "#34D399",
  "#FBBF24",
  "#F472B6",
  "#A78BFA",
  "#FB923C",
  "#2DD4BF",
];

export function colorForDevice(deviceId: string): string {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

/**
 * Initial to show in the avatar, or null when there is no usable name and the
 * caller should fall back to a device glyph.
 */
export function initialForDevice(deviceName?: string | null): string | null {
  const trimmed = deviceName?.trim();
  if (!trimmed) return null;

  const ch = [...trimmed][0];
  // Only letters and digits read as an initial; punctuation does not.
  return /[\p{L}\p{N}]/u.test(ch) ? ch.toUpperCase() : null;
}

/**
 * Best guess at the device type.
 *
 * Peers report `device_type` over /health; this is the fallback for peers
 * running an older build that does not send it.
 */
export function deviceKind(
  reported?: string | null,
  deviceName?: string | null,
): DeviceKind {
  const r = reported?.toLowerCase();
  if (r === "laptop" || r === "desktop") return "laptop";
  if (r === "phone" || r === "mobile") return "phone";
  if (r === "tablet") return "tablet";

  const n = deviceName?.toLowerCase() ?? "";
  if (/pixel|galaxy|iphone|phone|redmi|oneplus|moto|nokia|xiaomi/.test(n)) {
    return "phone";
  }
  if (/ipad|tab\b|tablet/.test(n)) return "tablet";
  if (/mac|book|pc|laptop|desktop|workstation|windows|linux/.test(n)) {
    return "laptop";
  }
  return "unknown";
}
