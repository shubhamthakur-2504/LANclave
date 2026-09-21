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
}

export interface FileEntry {
  name: string;
  size: number; // bytes
  is_directory: boolean;
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
  /** Why it failed, for the failure state. Absent unless status is failed. */
  error?: string;
  /** Kept so a failed transfer can be retried without re-picking anything. */
  peerAddr?: string;
  remotePath?: string;
  localPath?: string;
}

// Connection / pairing
export interface ConnectionRequest {
  peerId: string;
  peerName: string;
  deviceName: string;
  ipAddress: string;
}
