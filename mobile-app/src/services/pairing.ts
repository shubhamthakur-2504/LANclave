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
import { getOrCreateDeviceIdentity } from "@/services/identity";

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
}

/** Check if a peer ID is already paired */
export async function isPeerPaired(peerId: string): Promise<boolean> {
  const list = await getPairedPeers();
  return list.some((p) => p.id === peerId);
}
