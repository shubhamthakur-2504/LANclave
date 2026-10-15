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
  /** True while the file list is being fetched. */
  isFetching: boolean;
  /** Last error message, or null when everything is OK. */
  error: string | null;
  /** Re-fetch the peer's file list. */
  fetchPeerFiles: () => Promise<void>;
}

/** A fetch result, tagged with the peer address it belongs to. */
interface Listing {
  addr: string;
  files: RemoteFileEntry[];
  error: string | null;
}

const EMPTY: Listing = { addr: "", files: [], error: null };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to fetch peer files.";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRemotePeer(
  selectedPeer: SelectedPeer | null,
  /** `a/b` inside the peer's sandbox; empty for the top. */
  folder = "",
): UseRemotePeerResult {
  // Keyed by address and folder rather than by the object: callers build a
  // new peer object on every render.
  const peerAddr = selectedPeer ? `${selectedPeer.ip}:${selectedPeer.port}` : "";
  const addr = peerAddr ? `${peerAddr}|${folder}` : "";

  const [listing, setListing] = useState<Listing>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);

  // Fetch whenever the peer changes. Results carry their address, so a slow
  // reply for a previous peer is never shown for the current one, and
  // "loading" is simply "no result for this address yet".
  useEffect(() => {
    if (!addr) return;
    let cancelled = false;
    fetchRemoteFileList(peerAddr, folder)
      .then((files) => {
        if (!cancelled) setListing({ addr, files, error: null });
      })
      .catch((err) => {
        console.warn("[useRemotePeer] fetch error:", err);
        if (!cancelled) setListing({ addr, files: [], error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [addr, peerAddr, folder]);

  /** Manual refresh, e.g. after an upload or on pull-to-refresh. */
  const fetchPeerFiles = useCallback(async () => {
    if (!addr) return;
    setRefreshing(true);
    try {
      const files = await fetchRemoteFileList(peerAddr, folder);
      setListing({ addr, files, error: null });
    } catch (err) {
      console.warn("[useRemotePeer] refresh error:", err);
      setListing((prev) => ({
        addr,
        files: prev.addr === addr ? prev.files : [],
        error: errorMessage(err),
      }));
    } finally {
      setRefreshing(false);
    }
  }, [addr, peerAddr, folder]);

  const current = listing.addr === addr && addr !== "";
  return {
    remoteFiles: current ? listing.files : [],
    isFetching: (addr !== "" && !current) || refreshing,
    error: current ? listing.error : null,
    fetchPeerFiles,
  };
}
