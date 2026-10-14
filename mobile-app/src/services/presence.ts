/**
 * Presence — is a paired peer online right now?
 *
 * Discovery ("who is out there?") needs a subnet sweep and is user-driven.
 * Presence only touches peers whose address we already know, so it costs one
 * request per paired peer instead of hundreds per sweep.
 *
 * Signals, all feeding one `lastSeen` timestamp per peer:
 *   1. Outbound heartbeat: GET /health on each paired peer every 20s.
 *   2. Inbound contact: the native server records every authenticated request
 *      (see PresenceRegistry.kt). Read locally, no network.
 *   3. hello / bye announcements.
 *
 * A peer is online if seen within ONLINE_TTL_MS. hello/bye only make changes
 * instant — a crash, a swipe-away kill, or a peer leaving Wi-Fi range sends
 * nothing, so the TTL is what actually decides.
 */

import { AppState, AppStateStatus, Platform } from "react-native";
import ExpoNativeServerModule, {
  NativePresenceEntry,
} from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { peerFetch, type PeerRequestInit } from "./peer-http";
import {
  applyPairingCancels,
  getPairedPeers,
  PairedPeerRecord,
  updatePairedPeerAddress,
} from "./pairing";
import { getSettings } from "./settings";

const ONLINE_TTL_MS = 45_000;
const HEARTBEAT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_FAILS = 2;
const OWN_PORT = 8377;

interface Entry {
  lastSeenMs: number;
  fails: number;
  /** When the peer last refused us as unpaired; 0 if it has not. */
  untrustedAtMs?: number;
}

interface Addr {
  ip: string;
  port: number;
}

export interface PeerPresence extends PairedPeerRecord {
  isOnline: boolean;
  lastSeenMs: number;
  /** Paired here, but the peer refuses us: it rejected the pairing or
   *  unpaired. Nothing works until it is removed and paired again. */
  untrusted: boolean;
}

const table = new Map<string, Entry>();
const listeners = new Set<() => void>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let running = false;
let cancelSub: { remove: () => void } | null = null;

// ─── Subscription ────────────────────────────────────────────────────────────

export function subscribePresence(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

// ─── Table ───────────────────────────────────────────────────────────────────

function markSeen(id: string) {
  table.set(id, { lastSeenMs: Date.now(), fails: 0 });
}

/**
 * The peer answered and refused us as unpaired. Not online, and not a
 * network failure either -- its address is fine.
 */
function markUntrusted(id: string) {
  table.set(id, { lastSeenMs: 0, fails: 0, untrustedAtMs: Date.now() });
}

function recordFailure(id: string): number {
  const prev = table.get(id) ?? { lastSeenMs: 0, fails: 0 };
  const next = { lastSeenMs: prev.lastSeenMs, fails: prev.fails + 1 };
  if (next.fails >= MAX_FAILS) next.lastSeenMs = 0;
  table.set(id, next);
  return next.fails;
}

function nativeInbound(): Map<string, NativePresenceEntry> {
  if (Platform.OS !== "android") return new Map();
  try {
    return new Map(
      ExpoNativeServerModule.getPresence().map((e) => [e.deviceId, e]),
    );
  } catch {
    return new Map();
  }
}

/**
 * Current presence of every paired peer. Merges our outbound results with
 * what the native server heard inbound. Local reads only.
 */
export async function getPeerPresence(): Promise<PeerPresence[]> {
  const peers = await getPairedPeers();
  const inbound = nativeInbound();
  const now = Date.now();

  return peers.map((p) => {
    const entry = table.get(p.id);
    const ours = entry?.lastSeenMs ?? 0;
    const theirs = inbound.get(p.id);

    // A peer only contacts devices it has paired, so inbound contact after
    // the refusal means the pairing is back on its side.
    const untrusted =
      !!entry?.untrustedAtMs && !(theirs && theirs.lastSeenMs > entry.untrustedAtMs);

    let lastSeenMs = ours;
    if (theirs && !theirs.offline) {
      lastSeenMs = Math.max(ours, theirs.lastSeenMs);
    }

    // A bye is authoritative until we hear from the peer again afterwards.
    const saidBye = theirs?.offline === true && ours <= theirs.lastSeenMs;
    const isOnline =
      !untrusted && !saidBye && lastSeenMs > 0 && now - lastSeenMs < ONLINE_TTL_MS;

    // A peer saved without a name still has the one it last said hello with.
    const name = p.name || theirs?.deviceName || p.name;
    return { ...p, name, isOnline, lastSeenMs, untrusted };
  });
}

// ─── Network ─────────────────────────────────────────────────────────────────

/** A signed request to a paired peer, bounded by the heartbeat's timeout. */
function request(a: Addr, path: string, init: PeerRequestInit = {}) {
  return peerFetch(`${a.ip}:${a.port}`, path, { ...init, timeoutMs: REQUEST_TIMEOUT_MS });
}

/**
 * One /health probe. The reply's device_id is checked, so a stale address
 * that now belongs to another device is never mistaken for this peer.
 */
async function probe(peer: PairedPeerRecord, a: Addr): Promise<boolean> {
  try {
    // /api/pairing/status answers only devices the peer still trusts: 200
    // means paired on both sides, 401 means paired here only. A 404 is a
    // peer from before the endpoint existed; fall back to the open /health,
    // which cannot tell the two apart. Signed either way, so the peer counts
    // this as contact from us and learns our current address.
    let res = await request(a, "/api/pairing/status");
    if (res.status === 401 || res.status === 403) {
      markUntrusted(peer.id);
      return true;
    }
    if (res.status === 404) {
      res = await request(a, "/health");
    }
    if (!res.ok) return false;
    const body = res.json();
    if (body?.app !== "lanclave" || body?.device_id !== peer.id) return false;
    markSeen(peer.id);
    await updatePairedPeerAddress(peer.id, a.ip, a.port, body.device_name);
    return true;
  } catch {
    return false;
  }
}

async function sendHello(peer: PairedPeerRecord, a: Addr): Promise<boolean> {
  try {
    const settings = await getSettings();
    const res = await request(a, "/api/presence/hello", {
      method: "POST",
      body: {
        device_name: settings.displayName,
        port: OWN_PORT,
      },
    });
    if (res.status === 401 || res.status === 403) {
      markUntrusted(peer.id);
      return false;
    }
    if (!res.ok) return false;
    markSeen(peer.id);
    // The reply carries the peer's current name.
    await updatePairedPeerAddress(peer.id, a.ip, a.port, res.json()?.device_name);
    return true;
  } catch {
    return false;
  }
}

async function sendBye(a: Addr): Promise<void> {
  try {
    await request(a, "/api/presence/bye", { method: "POST" });
  } catch {
    // best effort
  }
}

/**
 * Candidate addresses for a peer, freshest first: wherever it last contacted
 * us from, then wherever we last reached it. On a phone hotspot it is the
 * laptop's lease that rotates, and the laptop's own heartbeat to this phone
 * reveals its new address here for free — no mDNS, no sweep.
 */
function candidateAddrs(peer: PairedPeerRecord): Addr[] {
  const out: Addr[] = [];
  const inbound = nativeInbound().get(peer.id);
  if (inbound?.ip) {
    out.push({ ip: inbound.ip, port: inbound.port ?? peer.port });
  }
  if (peer.ip && !out.some((a) => a.ip === peer.ip)) {
    out.push({ ip: peer.ip, port: peer.port });
  }
  return out;
}

async function heartbeatOnce() {
  await applyPairingCancels();
  const peers = await getPairedPeers();
  const before = await getPeerPresence();

  for (const peer of peers) {
    const [primary, ...fallbacks] = candidateAddrs(peer);
    if (primary && (await probe(peer, primary))) continue;

    // Stale address: once the primary has failed repeatedly, try the rest.
    if (recordFailure(peer.id) >= MAX_FAILS) {
      for (const a of fallbacks) {
        if (await probe(peer, a)) break;
      }
    }
  }

  const after = await getPeerPresence();
  const changed = after.some((p) => {
    const b = before.find((x) => x.id === p.id);
    return b?.isOnline !== p.isOnline || b?.untrusted !== p.untrusted;
  });
  if (changed) notify();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Announce ourselves to every paired peer. */
export async function announceHello(): Promise<void> {
  const peers = await getPairedPeers();
  await Promise.all(
    peers.map(async (peer) => {
      for (const a of candidateAddrs(peer)) {
        if (await sendHello(peer, a)) return;
      }
    }),
  );
  notify();
}

/** Re-find one quiet peer without sweeping the subnet. */
export async function rescanPeer(peerId: string): Promise<boolean> {
  const peer = (await getPairedPeers()).find((p) => p.id === peerId);
  if (!peer) return false;

  let reached = false;
  for (const a of candidateAddrs(peer)) {
    if (await sendHello(peer, a)) {
      reached = true;
      break;
    }
  }
  notify();
  return reached;
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    heartbeatOnce().catch(() => {});
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function onAppStateChange(state: AppStateStatus) {
  // Pause rather than send bye: the server may keep serving while the app is
  // backgrounded, and a bye would just be contradicted by the next inbound
  // request. Re-announce on return so peers update immediately.
  if (state === "active") {
    announceHello().catch(() => {});
    startHeartbeat();
  } else if (state === "background") {
    stopHeartbeat();
  }
}

/** Start presence: hello to every paired peer, then heartbeat. Idempotent. */
export function startPresence(): void {
  if (running) return;
  running = true;
  appStateSub = AppState.addEventListener("change", onAppStateChange);

  // A peer rejected our pairing or unpaired us: drop it from the list now.
  if (Platform.OS === "android") {
    applyPairingCancels().then((ids) => ids.length && notify()).catch(() => {});
    try {
      cancelSub = ExpoNativeServerModule.addListener("onPairingCancelled", () => {
        applyPairingCancels().then(() => notify()).catch(() => {});
      });
    } catch {
      // older native build
    }
  }
  startHeartbeat();
  announceHello().catch(() => {});
}

/**
 * Stop presence and tell peers we are going away. Sent when the user turns
 * the server off — the one shutdown the app can reliably observe. A
 * swipe-away kill gives no warning, which is exactly why peers rely on the
 * TTL rather than on this.
 */
export async function stopPresence(): Promise<void> {
  if (!running) return;
  running = false;
  stopHeartbeat();
  appStateSub?.remove();
  appStateSub = null;
  cancelSub?.remove();
  cancelSub = null;

  const peers = await getPairedPeers();
  await Promise.all(
    peers.map((p) => {
      const [first] = candidateAddrs(p);
      return first ? sendBye(first) : Promise.resolve();
    }),
  );
  table.clear();
  notify();
}
