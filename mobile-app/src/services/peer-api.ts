/**
 * P2P API service — communicates with LANclave desktop/mobile peers over
 * the local network.  Every outbound request is signed with our device's
 * ed25519 identity key so the receiving peer can authenticate us.
 *
 * This mirrors the auth model in desktop-app/src/client/transport.rs:
 *   - X-LANclave-Device-Id   = base64(public_key)
 *   - X-LANclave-Timestamp   = unix epoch seconds
 *   - X-LANclave-Signature   = ed25519("device_id:timestamp")
 */

import * as FileSystem from "expo-file-system";
import { ed25519 } from "@noble/ed25519";
import { randomBytes } from "expo-crypto";

// ---------------------------------------------------------------------------
// Identity (lazy — generated once per app session)
// ---------------------------------------------------------------------------

interface Identity {
  secretKey: Uint8Array; // 32 bytes seed
  publicKey: Uint8Array; // 32 bytes verifying key
  deviceId: string; // base64(publicKey)
}

let _identity: Identity | null = null;

function getOrCreateIdentity(): Identity {
  if (_identity) return _identity;

  const seed = randomBytes(32);
  const publicKey = ed25519.getPublicKey(seed);

  _identity = {
    secretKey: seed,
    publicKey,
    deviceId: btoa(String.fromCharCode(...publicKey)),
  };

  return _identity;
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

function signPayload(deviceId: string, timestamp: number): string {
  const ident = getOrCreateIdentity();
  const message = new TextEncoder().encode(`${deviceId}:${timestamp}`);
  const sig = ed25519.sign(message, ident.secretKey);
  return btoa(String.fromCharCode(...sig));
}

function base64UrlEncode(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

// ---------------------------------------------------------------------------
// Remote file list
// ---------------------------------------------------------------------------

export interface RemoteFileEntry {
  name: string;
  size: number;
  is_directory: boolean;
}

/**
 * Fetch the directory listing of a remote peer's sandbox.
 *
 * GET http://{peerAddr}/api/sandbox/files
 *
 * The request is signed with our device identity so the peer can verify us.
 */
export async function fetchRemoteFileList(
  peerAddr: string,
): Promise<RemoteFileEntry[]> {
  const ident = getOrCreateIdentity();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(ident.deviceId, timestamp);

  const url = `http://${peerAddr}/api/sandbox/files`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-LANclave-Device-Id": ident.deviceId,
        "X-LANclave-Timestamp": String(timestamp),
        "X-LANclave-Signature": signature,
      },
      signal: AbortSignal.timeout(10_000), // 10s LAN timeout
    });

    if (!response.ok) {
      throw new Error(`peer returned HTTP ${response.status}`);
    }

    const data: unknown = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("unexpected response format from peer");
    }

    return data as RemoteFileEntry[];
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `connection to ${peerAddr} timed out — peer may be unreachable`,
      );
    }
    if (err instanceof TypeError && (err as Error).message.includes("fetch")) {
      throw new Error(
        `could not reach ${peerAddr} — check that both devices are on the same LAN`,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------

/**
 * Download a file from a remote peer and save it into the local sandbox
 * directory (FileSystem.documentDirectory).
 *
 * GET http://{peerAddr}/files/{remoteFileName}  →  FileSystem.downloadAsync
 *
 * The result is saved as {localFileName} inside the app's document directory
 * (the phone's secure sandboxed storage root).
 */
export async function downloadRemoteFile(
  peerAddr: string,
  remoteFileName: string,
  localFileName: string,
): Promise<string> {
  const ident = getOrCreateIdentity();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(ident.deviceId, timestamp);

  const encodedPath = base64UrlEncode(remoteFileName);
  const url = `http://${peerAddr}/files/${encodedPath}`;

  const localUri = `${FileSystem.documentDirectory}${localFileName}`;

  try {
    const result = await FileSystem.downloadAsync(url, localUri, {
      headers: {
        "X-LANclave-Device-Id": ident.deviceId,
        "X-LANclave-Timestamp": String(timestamp),
        "X-LANclave-Signature": signature,
      },
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    });

    if (result.status !== 200) {
      // Remove the partial file if the peer returned an error.
      try {
        await FileSystem.deleteAsync(result.uri, { idempotent: true });
      } catch {
        // best-effort cleanup
      }
      throw new Error(`peer returned HTTP ${result.status}`);
    }

    return result.uri;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("peer returned")) {
      throw err;
    }
    throw new Error(
      `download from ${peerAddr} failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
