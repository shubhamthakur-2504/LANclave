import type { HistoryEntry } from "../types";

export interface PeerVolume {
  peerId: string;
  peerName: string;
  files: number;
  bytes: number;
}

export interface TransferStats {
  sentFiles: number;
  sentBytes: number;
  receivedFiles: number;
  receivedBytes: number;
  /** Transfers the destination already had: time and data saved. */
  skippedFiles: number;
  skippedBytes: number;
  failed: number;
  /** Per peer, busiest first. */
  byPeer: PeerVolume[];
}

/**
 * Counts and volumes for `entries` since `sinceMs`. Only completed transfers
 * count as sent/received; skips are tallied as savings, failures on their
 * own. Same rules as the phone's `computeStats`.
 */
export function computeStats(entries: HistoryEntry[], sinceMs = 0): TransferStats {
  const stats: TransferStats = {
    sentFiles: 0,
    sentBytes: 0,
    receivedFiles: 0,
    receivedBytes: 0,
    skippedFiles: 0,
    skippedBytes: 0,
    failed: 0,
    byPeer: [],
  };
  const peers = new Map<string, PeerVolume>();

  for (const e of entries) {
    if (e.at_ms < sinceMs) continue;
    if (e.outcome === "failed" || e.outcome === "cancelled") {
      stats.failed += 1;
      continue;
    }
    if (e.outcome === "skipped") {
      stats.skippedFiles += 1;
      stats.skippedBytes += e.bytes;
      continue;
    }
    if (e.direction === "sent") {
      stats.sentFiles += 1;
      stats.sentBytes += e.bytes;
    } else {
      stats.receivedFiles += 1;
      stats.receivedBytes += e.bytes;
    }
    const peer = peers.get(e.peer_id) ?? {
      peerId: e.peer_id,
      peerName: e.peer_name ?? "Unknown device",
      files: 0,
      bytes: 0,
    };
    peer.files += 1;
    peer.bytes += e.bytes;
    peers.set(e.peer_id, peer);
  }

  stats.byPeer = [...peers.values()].sort((a, b) => b.bytes - a.bytes);
  return stats;
}

/** Compact byte size: 812 B, 4.2 KB, 12.9 MB, 1.3 GB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}
