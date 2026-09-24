declare module "react-native-zeroconf" {
  interface ZeroconfService {
    host: string;
    port: number;
    name: string;
    type: string;
    protocol: string;
    domain: string;
    txt: Record<string, string>;
    addresses: string[];
  }

  type ZeroconfEvent = "resolved" | "error" | "start" | "stop";

  export default class Zeroconf {
    constructor();
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
    removeDeviceListeners(): void;
    on(event: "resolved", callback: (service: ZeroconfService) => void): void;
    on(event: "error", callback: (error: unknown) => void): void;
    on(event: "start" | "stop", callback: () => void): void;
    /** Advertise a service (Android: NsdManager). TXT values are stringified. */
    publishService(
      type: string,
      protocol: string,
      domain: string,
      name: string,
      port: number,
      txt?: Record<string, string>,
    ): void;
    unpublishService(name: string): void;
  }
}
