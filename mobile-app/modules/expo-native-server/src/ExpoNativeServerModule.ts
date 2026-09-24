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
};

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
  stopServer(): void;
  updatePairedDevices(devices: string[]): void;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
