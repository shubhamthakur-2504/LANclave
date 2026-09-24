// ---------------------------------------------------------------------------
// Shared types — mirror the backend command signatures.
// ---------------------------------------------------------------------------

export type PageType = "peers" | "files" | "transfers" | "settings";

// Server lifecycle
export interface PeerInfo {
  addr: string;
  device_id: string;
  device_name?: string;
  /** "laptop" | "phone" | ... — reported over /health. */
  device_type?: string;
  paired: boolean;
  /** Paired here, but the peer no longer trusts us: it rejected the pairing
   *  or unpaired. Needs removing and pairing again. */
  untrusted?: boolean;
}

export interface FileEntry {
  name: string;
  size: number; // bytes
  is_directory: boolean;
  /** Last modified, Unix ms. Absent from peers that predate the field. */
  modified?: number | null;
}

// Local sandbox list (same shape as FileEntry from list_sandbox_files)
export type SandboxFile = FileEntry;

// Transfers (UI-only for now — no backend)
export type TransferStatus = "pending" | "in_progress" | "completed" | "failed";
export type TransferDirection = "upload" | "download";
export type TransferFilter = "all" | "active" | "completed" | "failed";

export interface Transfer {
  id: string;
  fileName: string;
  fileSize: number;
  /** device_id of the other end, so a transfer can be tied to a peer row. */
  peerId: string;
  peerName: string;
  direction: TransferDirection;
  progress: number;
  status: TransferStatus;
  speed: number;
  startedAt: string;
  /** Completed without sending anything: the destination already had an
   *  identical copy. */
  skipped?: boolean;
  /** Name at the destination, when it differs from `fileName`: the requested
   *  name was taken (saved as "name (1).ext"), or an identical copy already
   *  lived under a numbered name. */
  destName?: string;
  /** Why it failed, for the failure state. Absent unless status is failed. */
  error?: string;
  /** Kept so a failed transfer can be retried without re-picking anything. */
  peerAddr?: string;
  remotePath?: string;
  localPath?: string;
}

// Transfer history (30 days) -- mirrors `history.rs`'s HistoryEntry.
export type HistoryDirection = "sent" | "received";
export type HistoryOutcome = "completed" | "skipped" | "failed" | "cancelled";

export interface HistoryEntry {
  id: string;
  /** When it finished, Unix ms. */
  at_ms: number;
  direction: HistoryDirection;
  /** "me": started here. "peer": the peer started it against our server. */
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

// Connection / pairing
export interface ConnectionRequest {
  peerId: string;
  peerName: string;
  deviceName: string;
  ipAddress: string;
}
