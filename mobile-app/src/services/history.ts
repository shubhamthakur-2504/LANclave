/**
 * Transfer history (30 days) and the analytics derived from it.
 *
 * Stored natively (`TransferHistory.kt`), in the same shape as the desktop's
 * `history.rs`: the phone's server logs what peers do to us, and this module
 * logs the transfers the app starts. Android only; elsewhere history is
 * empty and recording is a no-op.
 */

import { Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getPairedPeers } from "@/services/pairing";

export type HistoryDirection = "sent" | "received";
export type HistoryOutcome = "completed" | "skipped" | "failed" | "cancelled";

export interface HistoryEntry {
  id: string;
  /** When it finished, Unix ms. */
  at_ms: number;
  direction: HistoryDirection;
  /** "me": started from this phone. "peer": the peer started it against our server. */
  initiated_by: "me" | "peer";
  peer_id: string;
  peer_name: string | null;
  file_name: string;
  /** Name at the destination, when it differs (numbered copy). */
  dest_name: string | null;
  bytes: number;
  outcome: HistoryOutcome;
  error: string | null;
}

const listeners = new Set<() => void>();

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Log a transfer this phone started. Never throws: history must not break a transfer. */
export async function recordTransfer(
  fields: Omit<HistoryEntry, "id" | "at_ms" | "initiated_by" | "dest_name" | "error"> & {
    dest_name?: string | null;
    error?: string | null;
  },
): Promise<void> {
  if (Platform.OS !== "android") return;
  const entry: HistoryEntry = {
    id: randomId(),
    at_ms: Date.now(),
    initiated_by: "me",
    ...fields,
    dest_name: fields.dest_name && fields.dest_name !== fields.file_name ? fields.dest_name : null,
    error: fields.error ?? null,
  };
  try {
    await ExpoNativeServerModule.recordTransfer(JSON.stringify(entry));
    listeners.forEach((fn) => fn());
  } catch (err) {
    console.warn("[history] could not record transfer:", err);
  }
}

/** Last 30 days, newest first, with peer names filled in from the paired list. */
export async function getHistory(): Promise<HistoryEntry[]> {
  if (Platform.OS !== "android") return [];
  try {
    const [raw, peers] = await Promise.all([
      ExpoNativeServerModule.getTransferHistory(),
      getPairedPeers(),
    ]);
    const names = new Map(peers.map((p) => [p.id, p.name]));
    return (JSON.parse(raw) as HistoryEntry[]).map((e) => ({
      ...e,
      peer_name: e.peer_name ?? names.get(e.peer_id) ?? null,
    }));
  } catch (err) {
    console.warn("[history] could not read history:", err);
    return [];
  }
}

export async function clearHistory(): Promise<void> {
  if (Platform.OS !== "android") return;
  await ExpoNativeServerModule.clearTransferHistory();
  listeners.forEach((fn) => fn());
}

/** Resolve a peer's device id from its address, for logging. */
export async function peerIdForAddress(ip: string, port: number): Promise<string> {
  try {
    const peers = await getPairedPeers();
    return peers.find((p) => p.ip === ip && p.port === port)?.id ?? `${ip}:${port}`;
  } catch {
    return `${ip}:${port}`;
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

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
  byPeer: { peerId: string; peerName: string; files: number; bytes: number }[];
}

/**
 * Counts and volumes for `entries` since `sinceMs`. Only completed transfers
 * count as sent/received; skips are tallied as savings, failures on their own.
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
  const peers = new Map<string, { peerId: string; peerName: string; files: number; bytes: number }>();

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
