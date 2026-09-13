import { NativeModule, requireNativeModule } from 'expo';

declare class ExpoNativeServerModule extends NativeModule<{}> {
  startServer(port: number, deviceId: string, deviceName: string, sandboxPath: string): boolean;
  stopServer(): void;
}

export default requireNativeModule<ExpoNativeServerModule>('ExpoNativeServer');
