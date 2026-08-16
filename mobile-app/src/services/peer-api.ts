/**
 * Peer API client — HTTP transport for communicating with LANclave peers over
 * the local network — expo-file-system SDK 57 (new class-based API).
 *
 * Every request is authenticated with the signed headers produced by
 * `getAuthHeaders()` from the identity service, mirroring the auth model in
 * `desktop-app/src/client/transport.rs`:
 *
 *   X-LANclave-Device-Id   = hex(publicKey)
 *   X-LANclave-Timestamp   = unix epoch seconds
 *   X-LANclave-Signature   = hex( ed25519.sign( "deviceId:timestamp", seed ) )
 */

import { Directory, File, Paths } from "expo-file-system";
import { StorageAccessFramework } from "expo-file-system/legacy";

import { getAuthHeaders } from "@/services/identity";
import { getSettings } from "@/services/settings";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RemoteFileEntry {
  name: string;
  size: number;
  is_directory: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Percent-encode each path segment (but not the slashes between them). */
function encodeFilePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Normalise raw fetch / timeout errors into descriptive messages. */
function wrapFetchError(peerAddr: string, err: unknown): Error {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new Error(
      `connection to ${peerAddr} timed out — peer may be unreachable`,
    );
  }
  if (err instanceof TypeError && err.message.toLowerCase().includes("fetch")) {
    return new Error(
      `could not reach ${peerAddr} — check both devices are on the same LAN`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the directory listing of a remote peer's sandboxed storage.
 *
 * `GET http://{peerAddr}/api/sandbox/files`
 *
 * @param peerAddr  `host:port` of the target peer (e.g. `"192.168.1.5:7890"`).
 * @returns Array of `RemoteFileEntry` objects.
 */
export async function fetchRemoteFileList(
  peerAddr: string,
): Promise<RemoteFileEntry[]> {
  const url = `http://${peerAddr}/api/sandbox/files`;
  const headers = await getAuthHeaders();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000), // 10 s — generous for LAN
    });

    if (!response.ok) {
      throw new Error(`peer returned HTTP ${response.status}`);
    }

    const data: unknown = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("unexpected response shape from peer");
    }

    return data as RemoteFileEntry[];
  } catch (err) {
    throw wrapFetchError(peerAddr, err);
  }
}

/**
 * Download a single file from a remote peer into the app's sandbox.
 *
 * @param peerAddr       `host:port` of the target peer.
 * @param remoteFileName Path of the file on the peer (may include sub-dirs).
 * @param localFileName  Target filename inside the local sandbox.
 * @returns Local `file://` or `content://` URI of the downloaded file.
 */
export async function downloadRemoteFile(
  peerAddr: string,
  remoteFileName: string,
  localFileName: string,
): Promise<string> {
  const url = `http://${peerAddr}/files/${encodeFilePath(remoteFileName)}`;
  const headers = await getAuthHeaders();
  const settings = await getSettings();

  let destination: File;

  if (settings.sandboxPath.startsWith("content://")) {
    const createdUri = await StorageAccessFramework.createFileAsync(
      settings.sandboxPath,
      localFileName,
      "application/octet-stream"
    );
    destination = new File(createdUri);
  } else {
    destination = new File(new Directory(settings.sandboxPath), localFileName);
    if (destination.exists) {
      try {
        destination.delete();
      } catch {}
    }
  }

  try {
    const downloaded = await File.downloadFileAsync(url, destination, {
      headers,
    });
    return downloaded.uri;
  } catch (err) {
    throw new Error(
      `download from ${peerAddr} failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
