/**
 * Skip transfers the destination already has — the phone's side of
 * `desktop-app/src-tauri/src/dedupe.rs`.
 *
 * Tier 1 compares name and size, which we already hold. Only a same-name,
 * same-size pair is hashed (Tier 2): the peer via
 * `GET /api/sandbox/fingerprint/{name}?size=N`, us via the native module.
 *
 * Every uncertain answer — file missing, a peer too old to have the route,
 * iOS without the native hasher, any error — resolves to `false`, i.e.
 * "transfer it". A false skip silently loses the file the user asked for;
 * a false transfer only costs time.
 */

import { Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getAuthHeaders } from "@/services/identity";
import { getSettings } from "@/services/settings";

interface Fingerprint {
  size: number;
  sha256: string | null;
}

/** Hashing a large file on the peer takes a few seconds; allow for it. */
const FINGERPRINT_TIMEOUT_MS = 120_000;

async function fetchPeerFingerprint(
  peerAddr: string,
  name: string,
  expectedSize: number,
): Promise<Fingerprint | null> {
  const url =
    `http://${peerAddr}/api/sandbox/fingerprint/${encodeURIComponent(name)}` +
    `?size=${expectedSize}`;
  const response = await fetch(url, {
    headers: await getAuthHeaders(),
    signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.json()) as Fingerprint;
}

/**
 * Before a download: does our sandbox already hold an identical `name`?
 * `remoteSize` comes from the peer's listing.
 */
export async function haveIdenticalLocalCopy(
  peerAddr: string,
  name: string,
  remoteSize: number,
): Promise<boolean> {
  if (Platform.OS !== "android" || remoteSize <= 0) return false;
  try {
    const { sandboxPath } = await getSettings();
    // Hashes only if the local size equals remoteSize.
    const local = await ExpoNativeServerModule.sandboxFileFingerprint(
      sandboxPath,
      name,
      remoteSize,
    );
    if (!local?.sha256) return false;

    const remote = await fetchPeerFingerprint(peerAddr, name, local.size);
    return !!remote?.sha256 && remote.sha256.toLowerCase() === local.sha256;
  } catch (err) {
    console.warn("[dedupe] local check failed, transferring:", err);
    return false;
  }
}

/**
 * Before an upload: does the peer already hold an identical `name`?
 * `localSize` is the size of the file at `localUri`.
 */
export async function peerHasIdenticalCopy(
  peerAddr: string,
  localUri: string,
  name: string,
  localSize: number,
): Promise<boolean> {
  if (Platform.OS !== "android" || localSize <= 0) return false;
  try {
    // The peer answers Tier 1 itself: no hash unless its size is localSize.
    const remote = await fetchPeerFingerprint(peerAddr, name, localSize);
    if (!remote?.sha256) return false;

    const localSha = await ExpoNativeServerModule.uriSha256(localUri);
    return remote.sha256.toLowerCase() === localSha;
  } catch (err) {
    console.warn("[dedupe] peer check failed, transferring:", err);
    return false;
  }
}
