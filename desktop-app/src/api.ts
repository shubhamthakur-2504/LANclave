// ---------------------------------------------------------------------------
// Typed invoke wrappers — the ONLY place @tauri-apps/api is imported.
// Every React component calls these functions, never invoke() directly.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import type { PeerInfo, FileEntry, SandboxFile } from "./types";

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

// ── File operations ────────────────────────────────────────────────

export async function listPeerFiles(peerAddr: string): Promise<FileEntry[]> {
  return await invoke("list_peer_files", { peerAddr });
}

export async function pullFile(
  peerAddr: string,
  remotePath: string,
  localFilename: string,
): Promise<string> {
  return await invoke("pull_file", { peerAddr, remotePath, localFilename });
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

export async function confirmPairing(
  peerAddr: string,
  peerDeviceId: string,
  peerDeviceName?: string,
): Promise<void> {
  await invoke("confirm_pairing", { peerAddr, peerDeviceId, peerDeviceName });
}
