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

declare class ExpoNativeServerModule extends NativeModule {
  startServer(port: number, deviceId: string, deviceName: string, sandboxPath: string, pairedDevices: string[]): boolean;
  isRunning(): boolean;
  getPresence(): NativePresenceEntry[];
  /** URIs from an Android share intent; consumed on read. */
  consumeSharedUris(): string[];
  /**
   * Dedupe: size of `name` in our sandbox and, when it equals `expectedSize`,
   * its SHA-256. Null when absent. Android only.
   */
  sandboxFileFingerprint(
    sandboxPath: string,
    name: string,
    expectedSize: number | null,
  ): Promise<{ size: number; sha256: string | null } | null>;
  /** SHA-256 of a local `content://` or `file://` URI. Android only. */
  uriSha256(uri: string): Promise<string>;
  stopServer(): void;
  updatePairedDevices(devices: string[]): void;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
