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
  /** The key native requests are signed with. Call before startServer. */
  setIdentity(deviceId: string, seedHex: string): void;
  /** Start a native download from a peer's sandbox; resolves to its id. */
  pull(peerAddr: string, peerId: string, peerName: string | null, remoteName: string, size: number | null): Promise<string>;
  pauseTransfer(id: string): void;
  resumeTransfer(id: string): void;
  cancelTransfer(id: string): void;
  getTransfers(): NativeTransfer[];
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
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
