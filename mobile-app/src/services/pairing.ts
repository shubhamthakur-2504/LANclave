/**
 * Pairing Service — 6-digit SAS (Short Authentication String) fingerprint
 * calculation and pairing persistent store for Mobile.
 *
 * Matches the Rust implementation in desktop-app/src-tauri/src/pairing/handshake.rs:
 * - Sorts both 32-byte public keys lexicographically.
 * - Hashes `first || second` with SHA-256.
 * - Extracts 6-digit decimal fingerprint for visual human verification.
 */

import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha2.js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getAuthHeaders, getOrCreateDeviceIdentity } from "@/services/identity";
import { updateNativeServerPairedDevices } from "@/services/server";

const PAIRED_PEERS_KEY = "lanclave_paired_peers";

export interface PairedPeerRecord {
  id: string;
  name: string;
  ip: string;
  port: number;
  pairedAt: string;
}

/** Convert a base64-encoded public key (device id) to bytes. */
function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Compute the 6-digit numeric pairing fingerprint from two base64-encoded
 * device ids. 100% identical to Rust `compute_pairing_fingerprint`.
 */
export function computeFingerprint(deviceIdA: string, deviceIdB: string): string {
  const bytesA = b64ToBytes(deviceIdA);
  const bytesB = b64ToBytes(deviceIdB);

  // Lexicographical comparison
  let aIsSmaller = false;
  const len = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < len; i++) {
    if (bytesA[i] < bytesB[i]) {
      aIsSmaller = true;
      break;
    } else if (bytesA[i] > bytesB[i]) {
      aIsSmaller = false;
      break;
    }
  }

  const first = aIsSmaller ? bytesA : bytesB;
  const second = aIsSmaller ? bytesB : bytesA;

  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  const hash = sha256(combined);
  const value = ((hash[0] << 16) | (hash[1] << 8) | hash[2]) >>> 0;
  const num = value % 1000000;
  return num.toString().padStart(6, "0");
}

/** Calculate the pairing fingerprint between the local device and a remote peer's deviceId */
export async function getPairingFingerprintForPeer(remoteDeviceId: string): Promise<string> {
  const localIdentity = await getOrCreateDeviceIdentity();
  return computeFingerprint(localIdentity.deviceId, remoteDeviceId);
}

/** Get all paired peers saved in SecureStore */
export async function getPairedPeers(): Promise<PairedPeerRecord[]> {
  try {
    const raw = await SecureStore.getItemAsync(PAIRED_PEERS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Save a new confirmed paired peer into SecureStore */
export async function savePairedPeer(peer: { id: string; name: string; ip: string; port: number }): Promise<void> {
  const list = await getPairedPeers();
  const filtered = list.filter((p) => p.id !== peer.id);
  const updated: PairedPeerRecord = {
    ...peer,
    pairedAt: new Date().toISOString(),
  };
  filtered.push(updated);
  await SecureStore.setItemAsync(PAIRED_PEERS_KEY, JSON.stringify(filtered));
  // Awaited: the peer says hello the moment it confirms, and our server
  // must already accept it or that first contact is refused with 401.
  await updateNativeServerPairedDevices().catch((err) =>
    console.error("Failed to update native server pairings", err),
  );
}

/**
 * Record a paired peer's current address. Hotspot DHCP leases rotate, so the
 * address saved at pairing time goes stale; presence calls this whenever it
 * reaches a peer somewhere new. No-op if nothing changed.
 */
export async function updatePairedPeerAddress(
  peerId: string,
  ip: string,
  port: number,
): Promise<void> {
  const list = await getPairedPeers();
  const peer = list.find((p) => p.id === peerId);
  if (!peer || (peer.ip === ip && peer.port === port)) return;
  peer.ip = ip;
  peer.port = port;
  await SecureStore.setItemAsync(PAIRED_PEERS_KEY, JSON.stringify(list));
}

/** Check if a peer ID is already paired */
export async function isPeerPaired(peerId: string): Promise<boolean> {
  const list = await getPairedPeers();
  return list.some((p) => p.id === peerId);
}

/** Forget a peer locally, and stop the native server accepting it. */
export async function removePairedPeer(peerId: string): Promise<boolean> {
  const list = await getPairedPeers();
  const kept = list.filter((p) => p.id !== peerId);
  if (kept.length === list.length) return false;
  await SecureStore.setItemAsync(PAIRED_PEERS_KEY, JSON.stringify(kept));
  await updateNativeServerPairedDevices().catch(() => {});
  return true;
}

/**
 * Tell a peer we are withdrawing our pairing: we rejected its codes, or we
 * unpaired. Signed with our own key, which is all it needs -- it checks the
 * signature against our device id without having to have paired us. Its
 * dialog closes, and if it already accepted, it drops us.
 */
export async function sendPairingCancel(ip: string, port: number): Promise<void> {
  const res = await fetch(`http://${ip}:${port}/api/pairing/cancel`, {
    method: "POST",
    headers: await getAuthHeaders(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`peer returned HTTP ${res.status}`);
}

/**
 * Forget a peer here and ask it to forget us too. Removal is local and
 * immediate; telling the peer is best effort -- if it is offline, its
 * heartbeat later sees our refusals and shows the pairing as one-sided.
 */
export async function unpairPeer(peer: { id: string; ip: string; port: number }): Promise<void> {
  await removePairedPeer(peer.id);
  sendPairingCancel(peer.ip, peer.port).catch(() => {});
}

/**
 * Apply cancels the native server received (a peer rejected our pairing or
 * unpaired us). The native side already refuses those devices; this removes
 * them from the stored list. Returns the ids removed.
 */
export async function applyPairingCancels(): Promise<string[]> {
  if (Platform.OS !== "android") return [];
  let ids: string[] = [];
  try {
    ids = ExpoNativeServerModule.consumePairingCancels();
  } catch {
    return []; // older native build
  }
  const removed: string[] = [];
  for (const id of ids) {
    if (await removePairedPeer(id)) removed.push(id);
  }
  return removed;
}
