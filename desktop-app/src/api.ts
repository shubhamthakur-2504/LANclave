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

export async function discoverPeers(): Promise<PeerInfo[]> {
  return await invoke("discover_peers");
}

// ── File operations ────────────────────────────────────────────────

export async function listPeerFiles(peerAddr: string): Promise<FileEntry[]> {
  return await invoke("list_peer_files", { peerAddr });
}

export async function pullFile(
  peerAddr: string,
  remotePath: string,
  localFilename: string,
): Promise<void> {
  await invoke("pull_file", { peerAddr, remotePath, localFilename });
}

export async function pushFile(
  peerAddr: string,
  localRelativePath: string,
  remotePath: string,
): Promise<void> {
  await invoke("push_file", { peerAddr, localRelativePath, remotePath });
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
