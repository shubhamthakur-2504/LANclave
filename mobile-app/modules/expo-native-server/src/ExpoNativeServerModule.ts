import { NativeModule, requireNativeModule } from 'expo';

export interface NativePresenceEntry {
  deviceId: string;
  lastSeenMs: number;
  ip: string | null;
  port: number | null;
  deviceName: string | null;
  /** True after an explicit bye, until the peer makes contact again. */
  offline: boolean;
}

/** A message in a thread. waiting / delivered: written here. received: there. */
export interface ChatMessage {
  id: string;
  text: string;
  /** By the sender's clock. */
  sentAtMs: number;
  state: "waiting" | "delivered" | "received";
  read: boolean;
}

/** A thread as a list shows it: counts, never text. */
export interface ThreadSummary {
  peerId: string;
  count: number;
  unread: number;
  waiting: number;
  lastAtMs: number;
}

/** Same shape as the `/api/sandbox/fingerprint` response. */
export interface SandboxFingerprint {
  size: number;
  sha256: string | null;
  siblings?: { name: string; sha256: string }[];
}

type NativeServerEvents = {
  /** A device withdrew its own pairing: rejected the codes, or unpaired. */
  onPairingCancelled: (event: { deviceId: string }) => void;
  /** Another device started pairing with us; show the code to compare. */
  onPairingRequest: (event: PairingRequestEvent) => void;
  /** A native download changed state or progressed. */
  onTransferProgress: (job: NativeTransfer) => void;
  /** Offers changed; `json` is the full snapshot (see `listOffers`). */
  onOffersChanged: (event: { json: string }) => void;
  /** A new incoming offer; `json` is the offer. */
  onOfferReceived: (event: { json: string }) => void;
  /**
   * Screen sharing moved on: asking (the laptop's user is deciding),
   * connecting, sharing, declined, failed (with `message`), ended.
   */
  onMirrorState: (event: { state: string; peerId: string | null; peerName: string | null; message: string | null }) => void;
  /** A message arrived, was delivered, or a thread changed. */
  onMessagesChanged: () => void;
  /** How far the receiver has pulled a file of an offer we sent. */
  onOfferProgress: (event: { offerId: string; fileId: string; bytes: number }) => void;
};

/** A download in the native engine. */
export interface NativeTransfer {
  id: string;
  fileName: string;
  peerId: string;
  peerName: string | null;
  status: 'queued' | 'in_progress' | 'verifying' | 'paused' | 'completed' | 'skipped' | 'failed';
  bytes: number;
  total: number;
  message: string | null;
  destName: string | null;
  offerId: string | null;
  fileId: string | null;
  pausedBySender: boolean;
  /** Queued downloads: how many wait in front of this one. */
  ahead: number | null;
}

export interface PairingRequestEvent {
  deviceId: string;
  name: string;
  /** Where the request came from; the peer's server listens there. */
  ip: string | null;
  fingerprint: string;
}

declare class ExpoNativeServerModule extends NativeModule<NativeServerEvents> {
  startServer(port: number, deviceId: string, deviceName: string, sandboxPath: string, pairedDevices: string[]): boolean;
  isRunning(): boolean;
  /** Our code is on screen for a pairing started here; other devices get "busy". */
  beginOutgoingPairing(deviceId: string): void;
  /** The user rejected the codes; a device that asked us is muted, longer each time. */
  declinePairing(deviceId: string): void;
  /** Paired: forgive the device and free the screen. */
  pairingConfirmed(deviceId: string): void;
  /** Private IPv4s on Wi-Fi, hotspot, USB or Ethernet (not mobile data). */
  getLocalIpv4Addresses(): string[];
  getPresence(): NativePresenceEntry[];
  /** URIs from an Android share intent; consumed on read. */
  consumeSharedUris(): string[];
  /**
   * Dedupe: size of `name` in our sandbox and, when it equals `expectedSize`,
   * its SHA-256, plus same-size numbered copies (`name (1).ext`...).
   * Null when absent. Android only.
   */
  sandboxFileFingerprint(
    sandboxPath: string,
    name: string,
    expectedSize: number | null,
  ): Promise<SandboxFingerprint | null>;
  /** Append one transfer to the 30-day history (JSON `HistoryEntry`). Android only. */
  recordTransfer(json: string): Promise<void>;
  /** The 30-day history as a JSON array string, newest first. Android only. */
  getTransferHistory(): Promise<string>;
  clearTransferHistory(): Promise<void>;
  /** SHA-256 of a local `content://` or `file://` URI. Android only. */
  uriSha256(uri: string): Promise<string>;
  /** Pairing cancels received since the last call; consumed on read. */
  consumePairingCancels(): string[];
  /** "Open with" for a `content://` URI; false when no app opens this type. */
  openUri(uri: string, name: string): boolean;
  /** The share sheet for one file (`content://` URI). */
  shareUri(uri: string, name: string): void;
  /** Types that install or run code when opened (e.g. `.apk`). */
  isRiskyFile(name: string): boolean;
  /** The key native requests are signed with. Call before startServer. */
  setIdentity(deviceId: string, seedHex: string): void;
  /** Start a native download from a peer's sandbox; resolves to its id. */
  pull(peerAddr: string, peerId: string, peerName: string | null, remoteName: string, size: number | null): Promise<string>;
  pauseTransfer(id: string): void;
  resumeTransfer(id: string): void;
  cancelTransfer(id: string): void;
  /** Forget a failed or paused download and its partial file. */
  removeTransfer(id: string): void;
  getTransfers(): NativeTransfer[];
  /** Downloads that run at once (default 2); the rest wait in line. */
  getMaxDownloads(): number;
  setMaxDownloads(n: number): void;
  /** Devices whose offers are taken without asking. */
  getAutoAccept(): string[];
  setAutoAccept(deviceId: string, enabled: boolean): void;
  /** Offers snapshot as JSON: `{ outgoing: [...], incoming: [...] }`. */
  listOffers(): string;
  /** Offer files (`[{uri, name, size}]` as JSON); the offer id, or null if the peer predates offers. */
  sendFiles(peerAddr: string, peerId: string, peerName: string | null, filesJson: string): Promise<string | null>;
  acceptOffer(offerId: string, fileIds: string[]): Promise<void>;
  declineOffer(offerId: string): Promise<void>;
  cancelOffer(offerId: string): Promise<void>;
  pauseOffer(offerId: string, paused: boolean): void;
  /** A pairing request that arrived with nothing listening (under a minute old). */
  consumePairingRequest(): PairingRequestEvent | null;
  stopServer(): void;
  updatePairedDevices(devices: string[]): void;
  /**
   * One request to another device, over TLS. `anyone` reaches a device that
   * is not paired (discovery, pairing); otherwise only paired devices are
   * accepted. `status` is negative when nothing usable came back: -1
   * unreachable, -2 timed out, -3 not a device we accept.
   */
  peerRequest(
    addr: string,
    method: string,
    path: string,
    body: string | null,
    anyone: boolean,
    signed: boolean,
    timeoutMs: number,
  ): Promise<{ status: number; body: string }>;
  sendMessage(peerId: string, peerAddr: string | null, text: string): ChatMessage;
  getThread(peerId: string): ChatMessage[];
  listThreads(): ThreadSummary[];
  markThreadRead(peerId: string): void;
  clearThread(peerId: string): void;
  /** A paired device answered: deliver to it, and fetch what it holds for us. */
  messagesContact(peerId: string, peerAddr: string, waitingThere: number): void;
  /** Copy, marked sensitive so Android's clipboard preview hides it. */
  copyText(text: string): void;
  /**
   * Ask Android to allow screen capture, then ask the laptop to show it.
   * `false` if the user declined Android's prompt.
   */
  shareScreen(peerId: string, peerAddr: string, peerName: string | null): Promise<boolean>;
  stopScreenShare(): void;
  screenShareState(): string;
  /** Refuse every future pairing request from this device. */
  blockDevice(deviceId: string, deviceName: string | null): void;
  /** `true` when it was blocked. */
  unblockDevice(deviceId: string): boolean;
  listBlocked(): { deviceId: string; deviceName: string | null; blockedAtMs: number }[];
  /** `/health` of each `ip:port` at once; the bodies of those that answered. */
  probeHealth(addrs: string[], timeoutMs: number): Promise<Record<string, string>>;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
