import { useCallback, useEffect, useState } from "react";
import { fetchRemoteFileList, RemoteFileEntry } from "@/services/peer-api";

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
  /** Last error message, or null when everything is OK. */
  error: string | null;
  /** Re-fetch the peer's file list. */
  fetchPeerFiles: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRemotePeer(
  selectedPeer: SelectedPeer | null,
): UseRemotePeerResult {
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const peerAddrKey = selectedPeer ? `${selectedPeer.ip}:${selectedPeer.port}` : "";

  useEffect(() => {
    if (peerAddrKey && selectedPeer) {
      fetchPeerFiles(selectedPeer);
    } else {
      setRemoteFiles([]);
      setError(null);
    }
  }, [peerAddrKey]);

  return {
    remoteFiles,
    isFetching,
    error,
    fetchPeerFiles,
  };
}
