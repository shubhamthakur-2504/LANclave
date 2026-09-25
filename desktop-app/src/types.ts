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

// Transfers -- the backend holds the list (`transfers.rs`); the page shows it.
/** "queued": waiting for one of the download slots. */
export type TransferStatus = "queued" | "in_progress" | "verifying" | "paused" | "completed" | "failed";
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
  /** Why it is waiting or paused: "Paused by sender", "Waiting for network". */
  message?: string;
  /** Queued downloads: how many wait ahead of this one. */
  ahead?: number;
  /** Set when this download is a file of an incoming offer. */
  offerId?: string;
  offerFileId?: string;
  /** Kept so a failed transfer can be retried without re-picking anything. */
  peerAddr?: string;
  remotePath?: string;
  localPath?: string;
}

/** A row as `transfers.rs` sends it. */
export interface TransferRow {
  id: string;
  file_name: string;
  file_size: number;
  peer_id: string;
  peer_name: string | null;
  direction: TransferDirection;
  progress: number;
  status: TransferStatus;
  skipped: boolean;
  dest_name: string | null;
  error: string | null;
  message: string | null;
  started_ms: number;
  ahead: number | null;
  peer_addr: string | null;
  remote_path: string | null;
  local_path: string | null;
  offer_id: string | null;
  offer_file_id: string | null;
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

// Offers -- mirrors `offers.rs`.
export type OfferState = "waiting" | "accepted" | "declined" | "cancelled" | "expired" | "done";

export interface OfferFile {
  id: string;
  name: string;
  size: number;
  modified?: number | null;
}

export interface FileResult {
  outcome: "completed" | "skipped" | "failed" | "cancelled";
  dest_name?: string | null;
  error?: string | null;
}

export interface OutgoingOffer {
  id: string;
  peer_id: string;
  peer_name: string | null;
  files: OfferFile[];
  state: OfferState;
  paused: boolean;
  accepted: string[];
  served: Record<string, number>;
  results: Record<string, FileResult>;
  created_ms: number;
  expires_ms: number;
}

export interface IncomingOffer {
  id: string;
  peer_id: string;
  peer_name: string | null;
  files: OfferFile[];
  state: OfferState;
  accepted: string[];
  results: Record<string, FileResult>;
  received_ms: number;
  expires_ms: number;
}

export interface OffersSnapshot {
  outgoing: OutgoingOffer[];
  incoming: IncomingOffer[];
}

// Connection / pairing
export interface ConnectionRequest {
  peerId: string;
  peerName: string;
  deviceName: string;
  ipAddress: string;
}
