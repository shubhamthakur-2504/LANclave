import { useEffect, useRef, useState } from "react";
import Zeroconf from "react-native-zeroconf";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPeer {
  /** Unique device identifier from the peer's mDNS TXT record. */
  id: string;
  /** Human-readable display name (falls back to the mDNS instance name). */
  name: string;
  /** Resolved IPv4 address. */
  ip: string;
  /** Port the peer's HTTP server is listening on. */
  port: number;
}

// ---------------------------------------------------------------------------
// Service type constants — must match the desktop's mdns-sd broadcast.
// ---------------------------------------------------------------------------

const SERVICE_TYPE = "lanclave-portal";
const PROTOCOL = "tcp";
const DOMAIN = "local.";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Discover LANclave peers on the local network via mDNS.
 *
 * Initialises a single [`Zeroconf`] instance on mount, calls `scan()` with
 * the service type that the desktop app broadcasts
 * (`_lanclave-portal._tcp.local.`), and collects `resolved` events into a
 * deduplicated state array keyed by the peer's `device_id`.
 *
 * When the calling component unmounts, event listeners are removed and the
 * scan is stopped automatically.
 *
 * @returns An array of [`DiscoveredPeer`] objects, empty until peers are
 *          resolved on the LAN.
 */
export function usePeerDiscovery(): DiscoveredPeer[] {
  const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>(
    [],
  );

  // Keep the Zeroconf instance in a ref so it survives re-renders and can
  // be cleaned up in the effect's return closure.
  const zeroconfRef = useRef<Zeroconf | null>(null);

  useEffect(() => {
    const zc = new Zeroconf();
    zeroconfRef.current = zc;

    const handleResolved = (service: {
      host: string;
      port: number;
      name: string;
      txt: Record<string, string>;
      addresses: string[];
    }) => {
      // Extract the device_id from the TXT record.
      const deviceId: string | undefined =
        service.txt.device_id ?? service.txt["device_id"];

      if (!deviceId) {
        // Skip peers that don't advertise a device_id — they're not
        // speaking our protocol.
        return;
      }

      // Pick the first IPv4 address from the addresses list.
      const ip: string | undefined =
        service.addresses.find((addr: string) => !addr.includes(":")) ??
        service.addresses[0];

      if (!ip) {
        return;
      }

      setDiscoveredPeers((prev) => {
        // Deduplicate by device_id — only add if we haven't seen this
        // peer before.
        if (prev.some((p) => p.id === deviceId)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: deviceId,
            name: service.name || deviceId.slice(0, 12),
            ip,
            port: service.port,
          },
        ];
      });
    };

    // -------------------------------------------------------------------
    // Wire up event listeners
    // -------------------------------------------------------------------

    zc.on("resolved", handleResolved);

    zc.on("error", (err: unknown) => {
      console.warn("[lanclave/zeroconf] scan error:", err);
    });

    // -------------------------------------------------------------------
    // Start scanning
    // -------------------------------------------------------------------

    try {
      zc.scan(SERVICE_TYPE, PROTOCOL, DOMAIN);
    } catch (err) {
      console.warn("[lanclave/zeroconf] failed to start scan:", err);
    }

    // -------------------------------------------------------------------
    // Cleanup on unmount
    // -------------------------------------------------------------------

    return () => {
      try {
        zc.removeDeviceListeners(); // unbinds all event listeners
        zc.stop();                  // stops the active scan
      } catch {
        // ignore cleanup errors
      }
      zeroconfRef.current = null;
    };
  }, []);

  return discoveredPeers;
}
