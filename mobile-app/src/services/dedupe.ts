/**
 * Skip transfers the destination already has — the phone's side of
 * `desktop-app/src-tauri/src/dedupe.rs`.
 *
 * Tier 1 compares name and size, which we already hold. Only a same-name,
 * same-size pair is hashed (Tier 2): the peer via
 * `GET /api/sandbox/fingerprint/{name}?size=N`, us via the native module.
 * "Same name" includes numbered copies (`name (1).ext`...), because a clash
 * is saved beside the original rather than over it.
 *
 * Every uncertain answer — file missing, a peer too old to have the route,
 * iOS without the native hasher, any error — resolves to `null`, i.e.
 * "transfer it". A false skip silently loses the file the user asked for;
 * a false transfer only costs time.
 */

import { Platform } from "react-native";

import ExpoNativeServerModule, {
  type SandboxFingerprint,
} from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getAuthHeaders } from "@/services/identity";
import { getSettings } from "@/services/settings";

/** Hashing a large file on the peer takes a few seconds; allow for it. */
const FINGERPRINT_TIMEOUT_MS = 120_000;

/** `"notes.txt"`, 2 → `"notes (2).txt"`; 0 is the name itself. Same scheme as both servers. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** The name in `fp` holding content `sha256`, if any. */
function holderOf(fp: SandboxFingerprint, baseName: string, sha256: string): string | null {
  const want = sha256.toLowerCase();
  if (fp.sha256?.toLowerCase() === want) return baseName;
  return fp.siblings?.find((s) => s.sha256.toLowerCase() === want)?.name ?? null;
}

async function fetchPeerFingerprint(
  peerAddr: string,
  name: string,
  expectedSize: number,
): Promise<SandboxFingerprint | null> {
  const url =
    `http://${peerAddr}/api/sandbox/fingerprint/${encodeURIComponent(name)}` +
    `?size=${expectedSize}`;
  const response = await fetch(url, {
    headers: await getAuthHeaders(),
    signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.json()) as SandboxFingerprint;
}

/**
 * Before a download: the name under which our sandbox already holds the
 * peer's `name`, or null. `remoteSize` comes from the peer's listing.
 */
export async function localCopyOf(
  peerAddr: string,
  name: string,
  remoteSize: number,
): Promise<string | null> {
  if (Platform.OS !== "android" || remoteSize <= 0) return null;
  try {
    const { sandboxPath } = await getSettings();
    // Hashes only local candidates whose size equals remoteSize.
    const local = await ExpoNativeServerModule.sandboxFileFingerprint(
      sandboxPath,
      name,
      remoteSize,
    );
    if (!local || (!local.sha256 && !local.siblings?.length)) return null;

    const remote = await fetchPeerFingerprint(peerAddr, name, remoteSize);
    if (!remote?.sha256) return null;
    return holderOf(local, name, remote.sha256);
  } catch (err) {
    console.warn("[dedupe] local check failed, transferring:", err);
    return null;
  }
}

/**
 * Before an upload: the name under which the peer already holds the file
 * at `localUri`, or null. `localSize` is that file's size.
 */
export async function peerCopyOf(
  peerAddr: string,
  localUri: string,
  name: string,
  localSize: number,
): Promise<string | null> {
  if (Platform.OS !== "android" || localSize <= 0) return null;
  try {
    // The peer answers Tier 1 itself: it hashes only same-size candidates.
    const remote = await fetchPeerFingerprint(peerAddr, name, localSize);
    if (!remote || (!remote.sha256 && !remote.siblings?.length)) return null;

    const localSha = await ExpoNativeServerModule.uriSha256(localUri);
    return holderOf(remote, name, localSha);
  } catch (err) {
    console.warn("[dedupe] peer check failed, transferring:", err);
    return null;
  }
}
