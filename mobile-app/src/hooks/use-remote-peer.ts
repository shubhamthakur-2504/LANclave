/**
 * useRemotePeer — manages the active peer connection, remote file listing, and
 * file downloads using expo-file-system SDK 57's class-based API.
 *
 * Usage:
 *   const { remoteFiles, isFetching, downloadProgress, error,
 *           fetchPeerFiles, downloadFile } = useRemotePeer(selectedPeer, onLocalRefresh);
 *
 * Downloads use `File.createDownloadTask()` (SDK 57) with the `onProgress`
 * callback to report per-file percentage (0–100) in `downloadProgress`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { File, Paths } from "expo-file-system";
import type { DownloadTask } from "expo-file-system";

import { fetchRemoteFileList, RemoteFileEntry } from "@/services/peer-api";
import { getAuthHeaders } from "@/services/identity";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectedPeer {
  ip: string;
  port: number;
  name: string;
}

export interface UseRemotePeerResult {
  /** Files available on the connected peer. */
  remoteFiles: RemoteFileEntry[];
  /** True while `fetchPeerFiles` is running. */
  isFetching: boolean;
  /**
   * Per-file download progress keyed by remote filename.
   * Value is 0–100 while downloading, absent when idle.
   */
  downloadProgress: Record<string, number>;
  /** Last error message, or null when everything is OK. */
  error: string | null;
  /** Re-fetch the peer's file list. */
  fetchPeerFiles: () => Promise<void>;
  /**
   * Download `remoteFileName` from the active peer and save it into the
   * local sandbox. Calls `onLocalRefresh` on completion.
   */
  downloadFile: (remoteFileName: string) => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param selectedPeer  The currently active peer, or `null` when none is selected.
 * @param onLocalRefresh  Optional callback to trigger after a successful download
 *                        (e.g. call `refreshFiles()` from `useSandboxFiles`).
 */
export function useRemotePeer(
  selectedPeer: SelectedPeer | null,
  onLocalRefresh?: () => void,
): UseRemotePeerResult {
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [error, setError] = useState<string | null>(null);

  // Keep a map of active DownloadTask references for potential cancellation.
  const activeTasks = useRef<Map<string, DownloadTask>>(new Map());

  // ── fetchPeerFiles ──────────────────────────────────────────────────────────

  const fetchPeerFiles = useCallback(
    async (overridePeer?: SelectedPeer | null) => {
      const activePeer = overridePeer !== undefined ? overridePeer : selectedPeer;
      if (!activePeer) {
        setError("No peer selected.");
        return;
      }

      setIsFetching(true);
      setError(null);

      try {
        const peerAddr = `${activePeer.ip}:${activePeer.port}`;
        const files = await fetchRemoteFileList(peerAddr);
        setRemoteFiles(files);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch peer files.";
        setError(message);
        console.warn("[useRemotePeer] fetchPeerFiles error:", err);
      } finally {
        setIsFetching(false);
      }
    },
    [selectedPeer],
  );

  // Automatically fetch peer files whenever selectedPeer updates
  useEffect(() => {
    if (selectedPeer) {
      fetchPeerFiles(selectedPeer);
    } else {
      setRemoteFiles([]);
      setError(null);
    }
  }, [selectedPeer]);

  // ── downloadFile ────────────────────────────────────────────────────────────

  const downloadFile = useCallback(
    async (remoteFileName: string) => {
      if (!selectedPeer) {
        setError("No peer selected.");
        return;
      }

      // Prevent duplicate downloads of the same file.
      if (activeTasks.current.has(remoteFileName)) return;

      setError(null);

      // Encode path segments so filenames with spaces / special chars work.
      const encodedPath = remoteFileName
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const url = `http://${selectedPeer.ip}:${selectedPeer.port}/files/${encodedPath}`;

      // Auth headers for the download request.
      const headers = await getAuthHeaders();

      // Destination file inside the sandbox.
      const destination = new File(Paths.document, remoteFileName);

      // If a previous partial download exists, clean it up first.
      if (destination.exists) {
        try {
          destination.delete();
        } catch {
          // ignore — task will overwrite it anyway
        }
      }

      // Initialise progress at 0.
      setDownloadProgress((prev) => ({ ...prev, [remoteFileName]: 0 }));

      const task = File.createDownloadTask(url, destination, {
        headers,
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (totalBytes > 0) {
            const pct = Math.round((bytesWritten / totalBytes) * 100);
            setDownloadProgress((prev) => ({
              ...prev,
              [remoteFileName]: pct,
            }));
          }
        },
      });

      activeTasks.current.set(remoteFileName, task);

      try {
        await task.downloadAsync();

        // Clear progress entry and notify local storage to refresh.
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[remoteFileName];
          return next;
        });

        onLocalRefresh?.();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : `Download of "${remoteFileName}" failed.`;
        setError(message);
        console.warn("[useRemotePeer] downloadFile error:", err);

        // Clear progress on failure too.
        setDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[remoteFileName];
          return next;
        });
      } finally {
        activeTasks.current.delete(remoteFileName);
      }
    },
    [selectedPeer, onLocalRefresh],
  );

  return {
    remoteFiles,
    isFetching,
    downloadProgress,
    error,
    fetchPeerFiles,
    downloadFile,
  };
}
