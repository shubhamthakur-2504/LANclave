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
import { Platform } from "react-native";
import Zeroconf from "react-native-zeroconf";
import * as Network from "expo-network";
import { getOrCreateDeviceIdentity } from "@/services/identity";
import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredPeer {
  id: string;
  name: string;
  ip: string;
  port: number;
  /** Seen over mDNS, but running a version that cannot be talked to. */
  needsUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_TYPE = "lanclave-portal";
const PROTOCOL = "tcp";
const DOMAIN = "local.";
const LANCLAVE_PORT = 8377;
/** The wire protocol this build speaks; version 1 was plain HTTP. */
const PROTOCOL_VERSION = 2;
/** Addresses handed to the native prober at a time; progress moves per batch. */
const PROBE_BATCH = 32;
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
 * Probe all 254 hosts in the same /24 as the gateway IP on LANCLAVE_PORT.
 * Returns any that respond with a valid LANclave /health response.
 */
async function probeSubnet(
  prefix: string,
  myDeviceId: string | null,
  signal: AbortSignal,
  onProgress: (checked: number) => void,
): Promise<DiscoveredPeer[]> {
  const results: DiscoveredPeer[] = [];

  // Build all 254 host IPs in the subnet
  const allIps: string[] = [];
  for (let i = 1; i <= 254; i++) {
    allIps.push(`${prefix}${i}`);
  }

  // The native module probes a batch at once, over TLS: `fetch` cannot check
  // the certificate a LANclave device presents.
  for (let i = 0; i < allIps.length; i += PROBE_BATCH) {
    if (signal.aborted) break;

    const batch = allIps.slice(i, i + PROBE_BATCH);
    let answers: Record<string, string> = {};
    try {
      answers = await ExpoNativeServerModule.probeHealth(
        batch.map((ip) => `${ip}:${LANCLAVE_PORT}`),
        PROBE_TIMEOUT_MS,
      );
    } catch {
      // older native build, or not Android
    }

    for (const [addr, text] of Object.entries(answers)) {
      let body: { app?: unknown; device_id?: unknown; device_name?: unknown } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: not LANclave
      }
      // Only a LANclave /health counts: an unrelated server on this port
      // must not show up as a device to pair with. Matches the desktop.
      if (body?.app !== "lanclave" || typeof body.device_id !== "string") continue;
      // Skip self
      if (myDeviceId && myDeviceId === body.device_id) continue;

      const ip = addr.slice(0, addr.lastIndexOf(":"));
      results.push({
        id: body.device_id,
        name: (typeof body.device_name === "string" && body.device_name) || `LANclave @ ${ip}`,
        ip,
        port: LANCLAVE_PORT,
      });
    }
    onProgress(batch.length);
  }

  return results;
}

/**
 * The /24 prefixes to sweep: every LAN this phone is on.
 *
 * `expo-network` reports only the Wi-Fi *client* address, which is 0.0.0.0
 * while the phone is itself the hotspot, so the sweep used to have nothing
 * to scan and returned instantly. The native module sees every interface.
 */
async function localSubnets(): Promise<string[]> {
  let ips: string[] = [];
  if (Platform.OS === "android") {
    try {
      ips = ExpoNativeServerModule.getLocalIpv4Addresses();
    } catch {
      // older native build
    }
  }
  if (ips.length === 0) {
    const ip = await Network.getIpAddressAsync().catch(() => "");
    if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") ips = [ip];
  }
  return [...new Set(ips.map(subnetPrefix).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** What the last scan covered, so the screen can say so. */
export interface ScanReport {
  /** The /24s swept, as "192.168.43.x". Empty: not on any local network. */
  networks: string[];
}

export interface ScanProgress {
  checked: number;
  total: number;
}

export interface PeerDiscovery {
  peers: DiscoveredPeer[];
  isScanning: boolean;
  /** Addresses checked so far in the running sweep. */
  progress: ScanProgress | null;
  /** The last finished scan; null until one has run. */
  lastScan: ScanReport | null;
  /** Re-query mDNS and sweep the local networks. No-op while one runs. */
  scan: () => void;
}

/**
 * A scan always runs at least this long. mDNS answers need a moment to
 * arrive, and a scan that finished before the spinner drew looked like the
 * button had not registered the tap.
 */
const MIN_SCAN_MS = 2_500;

export function usePeerDiscovery(): PeerDiscovery {
  const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredPeer[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [lastScan, setLastScan] = useState<ScanReport | null>(null);

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
            // Version 1 advertised no `proto` and only speaks plain HTTP.
            needsUpdate: Number(service.txt?.proto ?? 1) < PROTOCOL_VERSION,
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

    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();

    // Ask again over mDNS too. The browse only queries when it starts, so a
    // device that came up later stayed invisible until the tab was left and
    // re-entered.
    try {
      zeroconfRef.current?.scan(SERVICE_TYPE, PROTOCOL, DOMAIN);
    } catch {
      // unavailable; the sweep still runs
    }

    (async () => {
      let networks: string[] = [];
      try {
        const prefixes = await localSubnets();
        networks = prefixes.map((p) => `${p}x`);
        const total = prefixes.length * 254;
        let checked = 0;
        if (total > 0) setProgress({ checked, total });

        for (const prefix of prefixes) {
          if (controller.signal.aborted) break;
          const hits = await probeSubnet(
            prefix,
            myDeviceIdRef.current,
            controller.signal,
            (n) => {
              checked += n;
              if (mountedRef.current) setProgress({ checked, total });
            },
          );
          // Show each network's finds as soon as it is done.
          for (const peer of hits) addPeer(peer);
        }
      } catch (err) {
        console.warn("[lanclave/subnet] scan error:", err);
      } finally {
        const wait = MIN_SCAN_MS - (Date.now() - startedAt);
        if (wait > 0 && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, wait));
        }
        scanInFlightRef.current = false;
        if (mountedRef.current && !controller.signal.aborted) {
          setIsScanning(false);
          setProgress(null);
          setLastScan({ networks });
        }
      }
    })();
  }, [addPeer]);

  return { peers: discoveredPeers, isScanning, progress, lastScan, scan };
}
