/**
 * usePeerDiscovery — two-layer peer discovery:
 *
 * Layer 1 – mDNS (react-native-zeroconf)
 *   Discovers peers that advertise `_lanclave-portal._tcp.local.`
 *   Requires CHANGE_WIFI_MULTICAST_STATE permission (now declared in app.json).
 *
 * Layer 2 – Active Subnet Probe (HTTP /health)
 *   Sweeps every host in the device's own /24 on port 8377. This makes
 *   discovery work on ANY network topology — Wi-Fi router, Android hotspot,
 *   iOS hotspot, and emulators.
 *
 *   The sweep is EXPLICIT — it runs only when the user asks for it. It used to
 *   run on a 5s timer, but a full sweep takes far longer than 5s, so sweeps
 *   stacked on top of each other and the pileup was self-amplifying. Every
 *   probe to an unused address also forces an ARP resolution and an ARP
 *   broadcast, which is punishing for a phone acting as a Wi-Fi hotspot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
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
/** Concurrent probes in flight. Kept low: each one can cost an ARP broadcast. */
const PROBE_CONCURRENCY = 10;
/** Per-probe timeout. Dead hosts never answer, so this dominates sweep time. */
const PROBE_TIMEOUT_MS = 600;

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
 * An AbortSignal that fires on `timeoutMs` OR when `parent` aborts.
 *
 * `AbortSignal.timeout()` alone ignored the caller's controller, so cancelling
 * a sweep left every in-flight request running to completion.
 */
function linkedSignal(parent: AbortSignal, timeoutMs: number) {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();

  if (parent.aborted) {
    ctrl.abort();
  } else {
    parent.addEventListener("abort", onParentAbort);
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
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
  const CHUNK = PROBE_CONCURRENCY;
  for (let i = 0; i < allIps.length; i += CHUNK) {
    if (signal.aborted) break;

    const chunk = allIps.slice(i, i + CHUNK);
    const probeResults = await Promise.all(
      chunk.map(async (ip): Promise<DiscoveredPeer | null> => {
        const link = linkedSignal(signal, PROBE_TIMEOUT_MS);
        try {
          const res = await fetch(`http://${ip}:${LANCLAVE_PORT}/health`, {
            method: "GET",
            signal: link.signal,
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
          // unreachable, timed out, or no LANclave running
        } finally {
          link.cleanup();
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

export interface PeerDiscovery {
  peers: DiscoveredPeer[];
  isScanning: boolean;
  /** Run one subnet sweep. No-op if a sweep is already running. */
  scan: () => void;
}

export function usePeerDiscovery(): PeerDiscovery {
  const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const zeroconfRef = useRef<Zeroconf | null>(null);
  const myDeviceIdRef = useRef<string | null>(null);
  const scanInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const addPeer = useCallback((peer: DiscoveredPeer) => {
    setDiscoveredPeers((prev) => {
      if (prev.some((p) => p.id === peer.id || p.ip === peer.ip)) return prev;
      return [...prev, peer];
    });
  }, []);

  // Fetch own device ID once for self-filtering.
  useEffect(() => {
    mountedRef.current = true;
    getOrCreateDeviceIdentity()
      .then((ident) => {
        myDeviceIdRef.current = ident.deviceId;
      })
      .catch(() => {});

    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ── Layer 1: mDNS ────────────────────────────────────────────────────────
  // Bound to screen focus so nothing keeps listening once the user navigates
  // away. This is passive multicast listening and costs almost nothing, so it
  // stays automatic -- unlike the subnet sweep below.
  useFocusEffect(
    useCallback(() => {
      const zc = new Zeroconf();
      zeroconfRef.current = zc;

      zc.on(
        "resolved",
        (service: {
          host: string;
          port: number;
          name: string;
          txt: Record<string, string>;
          addresses: string[];
        }) => {
          const deviceId = service.txt?.device_id;
          if (!deviceId) return;
          if (myDeviceIdRef.current === deviceId) return;

          const ip =
            service.addresses.find((a: string) => !a.includes(":")) ??
            service.addresses[0];
          if (!ip) return;

          addPeer({
            id: deviceId,
            name:
              service.txt?.device_name ||
              service.name ||
              `Peer-${deviceId.slice(0, 8)}`,
            ip,
            port: service.port,
          });
        },
      );

      zc.on("error", (err: unknown) => {
        // Suppress -- the manual subnet sweep is the fallback.
        console.warn("[lanclave/zeroconf]", err);
      });

      try {
        zc.scan(SERVICE_TYPE, PROTOCOL, DOMAIN);
      } catch {
        // Permission denied or unavailable.
      }

      return () => {
        try {
          zc.removeDeviceListeners();
          zc.stop();
        } catch {
          // ignore
        }
        zeroconfRef.current = null;
      };
    }, [addPeer]),
  );

  // ── Layer 2: Active Subnet Probe (manual) ────────────────────────────────
  const scan = useCallback(() => {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setIsScanning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const myIp = await Network.getIpAddressAsync();
        if (!myIp || myIp === "0.0.0.0" || myIp === "127.0.0.1") return;

        // Only our own /24. The old code also swept a hardcoded
        // 192.168.43.0/24, doubling the traffic for a guess that is wrong on
        // most networks.
        const found = await probeSubnet(
          myIp,
          myDeviceIdRef.current,
          controller.signal,
        );

        if (!mountedRef.current || controller.signal.aborted) return;
        for (const peer of found) addPeer(peer);
      } catch (err) {
        console.warn("[lanclave/subnet] scan error:", err);
      } finally {
        scanInFlightRef.current = false;
        if (mountedRef.current) setIsScanning(false);
      }
    })();
  }, [addPeer]);

  return { peers: discoveredPeers, isScanning, scan };
}
