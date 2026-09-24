// ---------------------------------------------------------------------------
// Typed invoke wrappers — the ONLY place @tauri-apps/api is imported.
// Every React component calls these functions, never invoke() directly.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { PeerInfo, FileEntry, SandboxFile, HistoryEntry } from "./types";

// ── Dialogs ────────────────────────────────────────────────────────

/**
 * A native yes/no confirmation for destructive actions. Replaces
 * `window.confirm`, which renders as a bare browser prompt titled with the
 * page URL inside the app window.
 */
export async function confirmAction(
  message: string,
  { title, okLabel }: { title: string; okLabel: string },
): Promise<boolean> {
  return await ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
}

// ── Server lifecycle ───────────────────────────────────────────────

export async function startServer(): Promise<void> {
  await invoke("start_server");
}

export async function stopServer(): Promise<void> {
  await invoke("stop_server");
}

export async function isServerRunning(): Promise<boolean> {
  return await invoke("is_server_running");
}

// ── Peer discovery ─────────────────────────────────────────────────

/** Full subnet sweep. Expensive -- only ever run on an explicit user action. */
export async function discoverPeers(): Promise<PeerInfo[]> {
  return await invoke("discover_peers");
}

/** Paired peers with live presence. Reads local state; no network traffic. */
export async function listPeers(): Promise<PeerInfo[]> {
  return await invoke("list_peers");
}

/** Re-resolve one quiet peer via mDNS / its last address. Returns reachability. */
export async function rescanPeer(deviceId: string): Promise<boolean> {
  return await invoke("rescan_peer", { deviceId });
}

/** Copy files from anywhere on disk into the sandbox. Returns their names. */
export async function importFiles(paths: string[]): Promise<string[]> {
  return await invoke("import_files", { paths });
}

/** Reveal a completed download in the OS file manager. */
export async function revealInSandbox(fileName: string): Promise<void> {
  await invoke("reveal_in_sandbox", { fileName });
}

// ── File operations ────────────────────────────────────────────────

export async function listPeerFiles(peerAddr: string): Promise<FileEntry[]> {
  return await invoke("list_peer_files", { peerAddr });
}

export async function pullFile(
  peerAddr: string,
  remotePath: string,
  localFilename: string,
  remoteSize?: number,
): Promise<string> {
  return await invoke("pull_file", { peerAddr, remotePath, localFilename, remoteSize });
}

export async function pushFile(
  peerAddr: string,
  localRelativePath: string,
  remotePath: string,
): Promise<string> {
  return await invoke("push_file", { peerAddr, localRelativePath, remotePath });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  await invoke("cancel_transfer", { transferId });
}

// ── History ────────────────────────────────────────────────────────

/** Every transfer from the last 30 days, newest first. */
export async function getTransferHistory(): Promise<HistoryEntry[]> {
  return await invoke("get_transfer_history");
}

export async function clearTransferHistory(): Promise<void> {
  await invoke("clear_transfer_history");
}

export async function pickFile(): Promise<string | null> {
  return await invoke("pick_file");
}

// ── Local sandbox (legacy) ─────────────────────────────────────────

export async function listSandboxFiles(): Promise<SandboxFile[]> {
  return await invoke("list_sandbox_files");
}

// ── Pairing ────────────────────────────────────────────────────────

export async function initiatePairing(
  peerAddr: string,
  peerDeviceId: string,
  peerDeviceName?: string,
): Promise<string> {
  return await invoke("initiate_pairing", { peerAddr, peerDeviceId, peerDeviceName });
}

/** The user rejected the codes: tell the peer so it closes its dialog and
 *  drops the pairing if it already accepted. Best effort. */
export async function cancelPairing(peerAddr: string): Promise<void> {
  await invoke("cancel_pairing", { peerAddr });
}

/** Forget a paired peer here, and ask it to forget this computer too. */
export async function unpairPeer(deviceId: string): Promise<void> {
  await invoke("unpair_peer", { deviceId });
}

export async function confirmPairing(
  peerAddr: string,
  peerDeviceId: string,
  peerDeviceName?: string,
): Promise<void> {
  await invoke("confirm_pairing", { peerAddr, peerDeviceId, peerDeviceName });
}
