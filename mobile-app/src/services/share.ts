/**
 * Incoming shares (U3.2).
 *
 * Registers LANclave as an Android share target, so "Share → LANclave →
 * <peer>" works from any app. This is how people actually expect to send a
 * file from a phone, and it bypasses the app's own file picker entirely.
 *
 * The native side hands back the content URIs from the share intent and
 * clears it, so a share is handled once rather than replayed on every
 * resume. Content URIs are offered as they are — the receiver pulls them
 * from `content://` — so nothing is copied into the sandbox first.
 */

import { Platform } from "react-native";
import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";

export interface PendingShare {
  uri: string;
  /** Best-effort display name parsed from the URI. */
  name: string;
}

/** Everything currently waiting to be sent, in the order it was shared. */
let pending: PendingShare[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribeShares(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Derive a filename from a content URI.
 *
 * Content URIs often end in an opaque document id rather than a filename, so
 * this is a display convenience with a sensible fallback, never a path.
 */
function nameFromUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const tail = decoded.split(/[/:]/).pop() ?? "";
    // Keep it only if it looks like a filename rather than a numeric id.
    if (tail && /\.[A-Za-z0-9]{1,8}$/.test(tail)) return tail;
  } catch {
    // fall through
  }
  return "Shared file";
}

/**
 * Pull anything the share sheet handed us into the pending queue.
 * Safe to call on every foreground: the native side only returns each
 * share once.
 */
export function collectIncomingShares(): PendingShare[] {
  if (Platform.OS !== "android") return pending;

  try {
    const uris = ExpoNativeServerModule.consumeSharedUris();
    if (uris.length > 0) {
      pending = [...pending, ...uris.map((uri) => ({ uri, name: nameFromUri(uri) }))];
      notify();
    }
  } catch {
    // Older native build without the function; shares simply do not arrive.
  }
  return pending;
}

export function getPendingShares(): PendingShare[] {
  return pending;
}

export function clearPendingShares(): void {
  if (pending.length === 0) return;
  pending = [];
  notify();
}
