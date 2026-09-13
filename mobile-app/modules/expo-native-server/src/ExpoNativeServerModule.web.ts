import { registerWebModule, NativeModule } from 'expo';

// ExpoNativeServerModule is not available on the web platform.
class ExpoNativeServerModule extends NativeModule<{}> {}

export default registerWebModule(ExpoNativeServerModule, 'ExpoNativeServerModule');
