/**
 * What a paired device's sandbox holds.
 *
 * Files themselves are moved by the native engine (downloads) and by offers
 * (sending); this is only the listing the browse screen shows.
 */

import { peerFetch } from "@/services/peer-http";

export interface RemoteFileEntry {
  name: string;
  size: number;
  is_directory: boolean;
  /** Last modified, Unix ms. Absent from peers that predate the field. */
  modified?: number;
}

/**
 * The directory listing of a paired peer's sandbox.
 *
 * @param peerAddr  `host:port` of the target peer (e.g. `"192.168.1.5:8377"`).
 */
export async function fetchRemoteFileList(
  peerAddr: string,
): Promise<RemoteFileEntry[]> {
  const response = await peerFetch(peerAddr, "/api/sandbox/files");
  if (!response.ok) {
    throw new Error(`peer returned HTTP ${response.status}`);
  }
  const data = response.json<unknown>();
  if (!Array.isArray(data)) {
    throw new Error("unexpected response shape from peer");
  }
  return data as RemoteFileEntry[];
}
