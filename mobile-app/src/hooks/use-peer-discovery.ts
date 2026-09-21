/**
 * usePeerDiscovery — two-layer peer discovery:
 *
 * Layer 1 – mDNS (react-native-zeroconf)
 *   Discovers peers that advertise `_lanclave-portal._tcp.local.`
 *   Requires CHANGE_WIFI_MULTICAST_STATE permission (now declared in app.json).
 *
 * Layer 2 – Active Subnet Probe (HTTP /health)
 *   Reads the current gateway IP via expo-network, then sweeps every host in
 *   the same /24 subnet on port 8377 in parallel. This makes discovery work
 *   on ANY network topology — Wi-Fi router, Android hotspot (192.168.43.x,
 *   10.123.104.x, 172.20.10.x, etc.), iOS hotspot, and emulators.
 */

import { useEffect, useRef, useState } from "react";
import Zeroconf from "react-native-zeroconf";
import * as Network from "expo-network";
import { getOrCreateDeviceIdentity } from "@/services/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPeer {
  id: string;
  name: string;
  ip: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_TYPE = "lanclave-portal";
const PROTOCOL = "tcp";
const DOMAIN = "local.";
const LANCLAVE_PORT = 8377;

/**
 * Derive the /24 subnet prefix from an IP address.
 * e.g. "10.123.104.69" → "10.123.104."
 */
function subnetPrefix(ip: string): string {
  const parts = ip.split(".");
  if (parts.length < 3) return "";
  return `${parts[0]}.${parts[1]}.${parts[2]}.`;
}

/**
 * Probe all 254 hosts in the same /24 as the gateway IP on LANCLAVE_PORT.
 * Returns any that respond with a valid LANclave /health response.
 */
async function probeSubnet(
  gatewayOrLocalIp: string,
  myDeviceId: string | null,
  signal: AbortSignal,
): Promise<DiscoveredPeer[]> {
  const prefix = subnetPrefix(gatewayOrLocalIp);
  if (!prefix) return [];

  const results: DiscoveredPeer[] = [];

  // Build all 254 host IPs in the subnet
  const allIps: string[] = [];
  for (let i = 1; i <= 254; i++) {
    allIps.push(`${prefix}${i}`);
  }

  // Probe in chunks of 20 in parallel to be fast but not overwhelming
  const CHUNK = 20;
  for (let i = 0; i < allIps.length; i += CHUNK) {
    if (signal.aborted) break;

    const chunk = allIps.slice(i, i + CHUNK);
    const probeResults = await Promise.all(
      chunk.map(async (ip): Promise<DiscoveredPeer | null> => {
        try {
          const res = await fetch(`http://${ip}:${LANCLAVE_PORT}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(500),
          });

          if (res.status === 200 || res.status === 401) {
            let name = `LANclave @ ${ip}`;
            let id = `ip-${ip}`;

            if (res.status === 200) {
              try {
                const body = await res.json();
                if (body.app === "lanclave") {
                  if (body.device_id) id = body.device_id;
                  if (body.device_name) name = body.device_name;
                }
              } catch {
                // ignore
              }
            }

            // Skip self
            if (myDeviceId && myDeviceId === id) return null;

            return { id, name, ip, port: LANCLAVE_PORT };
          }
        } catch {
          // unreachable or no LANclave running
        }
        return null;
      }),
    );

    for (const p of probeResults) {
      if (p) results.push(p);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePeerDiscovery(): DiscoveredPeer[] {
  const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>([]);

  const zeroconfRef = useRef<Zeroconf | null>(null);
  const myDeviceIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Fetch own device ID once on mount for self-filtering
    getOrCreateDeviceIdentity()
      .then((ident) => {
        myDeviceIdRef.current = ident.deviceId;
      })
      .catch(() => {});

    // ── Layer 1: mDNS via react-native-zeroconf ──────────────────────────────
    const zc = new Zeroconf();
    zeroconfRef.current = zc;

    function addPeer(peer: DiscoveredPeer) {
      setDiscoveredPeers((prev) => {
        if (prev.some((p) => p.id === peer.id || p.ip === peer.ip)) {
          return prev;
        }
        return [...prev, peer];
      });
    }

    zc.on(
      "resolved",
      (service: {
        host: string;
        port: number;
        name: string;
        txt: Record<string, string>;
        addresses: string[];
      }) => {
        const deviceId = service.txt.device_id ?? service.txt["device_id"];
        if (!deviceId) return;
        if (myDeviceIdRef.current && myDeviceIdRef.current === deviceId) return;

        const ip =
          service.addresses.find((a: string) => !a.includes(":")) ??
          service.addresses[0];
        if (!ip) return;

        const deviceName = service.txt.device_name ?? service.txt["device_name"];

        addPeer({
          id: deviceId,
          name: deviceName || service.name || `Peer-${deviceId.slice(0, 8)}`,
          ip,
          port: service.port,
        });
      },
    );

    zc.on("error", (err: unknown) => {
      // Suppress — will fall through to subnet probe layer
      console.warn("[lanclave/zeroconf]", err);
    });

    try {
      zc.scan(SERVICE_TYPE, PROTOCOL, DOMAIN);
    } catch {
      // Permission denied or unavailable — subnet probe handles discovery
    }

    // ── Layer 2: Active Subnet Probe ─────────────────────────────────────────
    let isCancelled = false;
    const abortController = new AbortController();

    async function runSubnetScan() {
      try {
        // Get the device's own IP address on the current network
        const ipInfo = await Network.getIpAddressAsync();
        const myIp = ipInfo; // e.g. "10.123.104.69" (laptop) or "192.168.43.1" (phone)

        let targetIps: string[] = [];
        if (myIp && myIp !== "0.0.0.0" && myIp !== "127.0.0.1") {
          targetIps.push(myIp);
        }
        // If the phone is hosting a hotspot, its Wi-Fi STA IP might be 0.0.0.0 or cellular,
        // while the AP interface for connected clients is 192.168.43.1
        if (!targetIps.some((ip) => ip.startsWith("192.168.43."))) {
          targetIps.push("192.168.43.1");
        }

        for (const ip of targetIps) {
          const found = await probeSubnet(
            ip,
            myDeviceIdRef.current,
            abortController.signal,
          );

          if (!isCancelled) {
            for (const peer of found) {
              addPeer(peer);
            }
          }
        }
      } catch (err) {
        console.warn("[lanclave/subnet] scan error:", err);
      }
    }

    // Run immediately, then every 5 seconds
    runSubnetScan();
    const interval = setInterval(() => {
      if (!isCancelled) runSubnetScan();
    }, 5000);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      isCancelled = true;
      abortController.abort();
      clearInterval(interval);
      try {
        zc.removeDeviceListeners();
        zc.stop();
      } catch {
        // ignore
      }
      zeroconfRef.current = null;
    };
  }, []);

  return discoveredPeers;
}
