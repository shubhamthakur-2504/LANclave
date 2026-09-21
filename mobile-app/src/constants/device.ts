/**
 * Device kind → icon. Mirrors `desktop-app/src/lib/identity.ts`.
 *
 * Peers report `device_type` over /health; the name heuristic is the fallback
 * for peers running an older build that does not send it.
 */

import type { IconName } from "@/components/Icon";

export type DeviceKind = "laptop" | "phone" | "tablet" | "unknown";

export function deviceKind(
  reported?: string | null,
  deviceName?: string | null,
): DeviceKind {
  const r = reported?.toLowerCase();
  if (r === "laptop" || r === "desktop") return "laptop";
  if (r === "phone" || r === "mobile") return "phone";
  if (r === "tablet") return "tablet";

  const n = deviceName?.toLowerCase() ?? "";
  if (/pixel|galaxy|iphone|phone|redmi|oneplus|moto|nokia|xiaomi/.test(n)) return "phone";
  if (/ipad|\btab\b|tablet/.test(n)) return "tablet";
  if (/mac|book|pc|laptop|desktop|workstation|windows|linux/.test(n)) return "laptop";
  return "unknown";
}

export const KIND_ICON: Record<DeviceKind, IconName> = {
  laptop: "laptop",
  phone: "phone",
  tablet: "device",
  unknown: "device",
};

/** Initial for an avatar, or null when there is no usable name. */
export function initialForDevice(deviceName?: string | null): string | null {
  const trimmed = deviceName?.trim();
  if (!trimmed) return null;
  const ch = [...trimmed][0];
  return /[\p{L}\p{N}]/u.test(ch) ? ch.toUpperCase() : null;
}
