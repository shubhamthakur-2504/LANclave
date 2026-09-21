import { NativeModule, requireNativeModule } from 'expo';

declare class ExpoNativeServerModule extends NativeModule {
  startServer(port: number, deviceId: string, deviceName: string, sandboxPath: string, pairedDevices: string[]): boolean;
  isRunning(): boolean;
  stopServer(): void;
  updatePairedDevices(devices: string[]): void;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
