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
  stopServer(): void;
  updatePairedDevices(devices: string[]): void;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
