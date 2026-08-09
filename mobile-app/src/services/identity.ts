/**
 * Device identity service — Ed25519 keypair backed by SecureStore.
 *
 * On first launch a fresh keypair is generated, the private-key seed is stored
 * in `expo-secure-store` under the key `lanclave_private_key`, and the derived
 * public key becomes the persistent `deviceId`.
 *
 * On subsequent launches the seed is loaded from secure storage and the public
 * key is re-derived deterministically — no new keys are created.
 *
 * Auth header scheme (mirrors desktop-app/src/client/transport.rs):
 *   X-LANclave-Device-Id   — hex(publicKey)
 *   X-LANclave-Timestamp   — Unix epoch seconds (string)
 *   X-LANclave-Signature   — hex( ed25519.sign( "deviceId:timestamp", seed ) )
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

// Configure SHA-512 for @noble/ed25519 (both sync and async fallback for React Native)
ed.hashes.sha512 = sha512;
ed.hashes.sha512Async = (m) => Promise.resolve(sha512(m));

// ─── Constants ────────────────────────────────────────────────────────────────

const SECURE_STORE_KEY = "lanclave_private_key";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface DeviceIdentity {
  /** Hex string derived from the Ed25519 public key. Used as a unique device ID. */
  deviceId: string;
  /** Ed25519 public key in hex format. */
  publicKey: string;
  /** Ed25519 private key seed in hex format (stored securely, never transmitted). */
  privateKey: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a Uint8Array to a lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert a lowercase hex string back to Uint8Array. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("identity: invalid hex string length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ─── Module-level in-memory cache (avoids repeated SecureStore reads) ─────────

let _cachedIdentity: DeviceIdentity | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the device's persistent Ed25519 identity.
 *
 * - First call: generates a new keypair, persists the seed in SecureStore,
 *   and caches the identity in memory.
 * - Subsequent calls within the same session: returns the in-memory cache.
 * - Subsequent app launches: loads the seed from SecureStore and re-derives
 *   the public key.
 *
 * @throws If SecureStore is unavailable or returns a corrupted value.
 */
export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  // Fast path — already loaded this session.
  if (_cachedIdentity !== null) {
    return _cachedIdentity;
  }

  let seedHex: string | null = null;

  try {
    seedHex = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  } catch (err) {
    console.warn("[identity] SecureStore read failed:", err);
    // Fall through — will generate a new key below.
  }

  let seed: Uint8Array;

  if (seedHex !== null && seedHex.length === 64) {
    // ── Restore existing identity ────────────────────────────────────────────
    try {
      seed = fromHex(seedHex);
    } catch {
      console.warn("[identity] Stored key was malformed — regenerating.");
      seed = await _generateAndStoreSeed();
    }
  } else {
    // ── Generate a brand-new identity ────────────────────────────────────────
    seed = await _generateAndStoreSeed();
  }

  const publicKeyBytes = ed.getPublicKey(seed);
  const publicKeyHex = toHex(publicKeyBytes);

  _cachedIdentity = {
    deviceId: publicKeyHex,   // deviceId === publicKey hex (no extra hash needed)
    publicKey: publicKeyHex,
    privateKey: toHex(seed),
  };

  return _cachedIdentity;
}

/**
 * Build the signed authentication headers required by every peer request.
 *
 * Signs `"deviceId:timestamp"` with the device's private Ed25519 key.
 *
 * @returns An object ready to pass as the `headers` option of `fetch`.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const identity = await getOrCreateDeviceIdentity();

  const timestamp = Math.floor(Date.now() / 1000); // Unix epoch seconds
  const message = new TextEncoder().encode(`${identity.deviceId}:${timestamp}`);
  const seed = fromHex(identity.privateKey);
  const signatureBytes = await ed.signAsync(message, seed);
  const signature = toHex(signatureBytes);

  return {
    "X-LANclave-Device-Id": identity.deviceId,
    "X-LANclave-Timestamp": String(timestamp),
    "X-LANclave-Signature": signature,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Generate a fresh 32-byte seed, persist it, and return it. */
async function _generateAndStoreSeed(): Promise<Uint8Array> {
  const seed = getRandomBytes(32);
  const seedHex = toHex(seed);

  try {
    await SecureStore.setItemAsync(SECURE_STORE_KEY, seedHex);
  } catch (err) {
    // Non-fatal — identity works in-memory for this session, but won't survive
    // an app restart. Log prominently so it's visible during debugging.
    console.error(
      "[identity] Failed to persist private key in SecureStore. " +
        "A new identity will be generated on the next launch.",
      err,
    );
  }

  return seed;
}
