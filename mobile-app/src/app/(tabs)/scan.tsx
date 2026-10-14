import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Alert,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PeerCard } from "@/components/PeerCard";
import { PairingModal } from "@/components/PairingModal";
import { C } from "@/constants/colors";
import { DiscoveredPeer, usePeerDiscovery } from "@/hooks/use-peer-discovery";
import { getOrCreateDeviceIdentity } from "@/services/identity";
import {
  getPairedPeers,
  savePairedPeer,
  getPairingFingerprintForPeer,
  pairingGuard,
  sendPairingCancel,
  waitPhrase,
} from "@/services/pairing";
import ExpoNativeServerModule from "../../../modules/expo-native-server/src/ExpoNativeServerModule";
import { deviceTag } from "@/constants/device";
import { getSettings } from "@/services/settings";
import { peerFetch } from "@/services/peer-http";
import { rescanPeer } from "@/services/presence";
import { Icon } from "@/components/Icon";
import { ScanAnimation } from "@/components/brand/ScanAnimation";
import * as Network from "expo-network";

/**
 * Why a pairing request failed, as an alert's title and message. The three
 * causes need different fixes, and one catch-all ("make sure its server is
 * running") sent the user to check the one thing that was fine.
 */
function pairingFailure(err: unknown, peer: DiscoveredPeer): [string, string] {
  const where = `${peer.ip}:${peer.port}`;
  const e = err as { name?: string; status?: number } | null;
  if (typeof e?.status === "number") {
    return [
      "Pairing refused",
      `${peer.name} answered but would not start pairing (HTTP ${e.status}). Update LANclave on both devices and try again.`,
    ];
  }
  // It answered, but not as a device this version can talk to.
  if (e?.name === "TlsError") {
    return [
      "Needs update",
      `${peer.name} runs an older LANclave that does not encrypt its connections. Update it there, then pair.`,
    ];
  }
  // Our own 5 s limit: the request went out and nothing came back.
  if (e?.name === "AbortError" || e?.name === "TimeoutError") {
    return [
      "No answer",
      `${peer.name} did not answer at ${where} within 5 seconds. A firewall on that device may be blocking LANclave, or this phone is not sending over the Wi-Fi it shares with it.`,
    ];
  }
  return [
    "Connection Failed",
    `Could not open a connection to ${peer.name} at ${where}. Make sure LANclave is open there and both devices are on the same Wi-Fi or hotspot.`,
  ];
}

export default function ScanScreen() {
  const router = useRouter();
  const { peers: allDiscovered, isScanning, progress, lastScan, scan } = usePeerDiscovery();

  // Keep a live set of paired IDs so we can filter them out of the scan list
  const [pairedIds, setPairedIds] = useState<Set<string>>(new Set());
  /** Our own name, so the pairing sheet can show both ends of the pair. */
  const [selfName, setSelfName] = useState("This phone");
  /** The short tag other devices show beside this phone's name. */
  const [selfTag, setSelfTag] = useState("");

  // Refresh paired IDs every time this screen gains focus
  useFocusEffect(
    useCallback(() => {
      getPairedPeers().then((saved) =>
        setPairedIds(new Set(saved.map((p) => p.id)))
      );
      getSettings()
        .then((s) => setSelfName(s.displayName || "This phone"))
        .catch(() => {});
      getOrCreateDeviceIdentity()
        .then((identity) => setSelfTag(deviceTag(identity.deviceId)))
        .catch(() => {});
    }, []),
  );

  // Only show devices that are NOT yet paired
  const peers = allDiscovered.filter((p) => !pairedIds.has(p.id));

  // Say what the scan is doing and what it covered: a scan with no visible
  // outcome read as a button that did nothing.
  const progressText = progress
    ? `Checked ${progress.checked} of ${progress.total} addresses`
    : "Listening for nearby devices…";
  const coveredText = lastScan?.networks.length
    ? `Checked every address on ${lastScan.networks.join(", ")}.`
    : null;
  const notOnNetwork = !isScanning && lastScan !== null && lastScan.networks.length === 0;

  // Interactive 6-Digit Pairing Modal state
  const [pairingTarget, setPairingTarget] = useState<DiscoveredPeer | null>(
    null,
  );
  const [pairingFingerprint, setPairingFingerprint] = useState<string | null>(
    null,
  );
  const [isPairingSubmitting, setIsPairingSubmitting] = useState(false);
  const [pairingSucceeded, setPairingSucceeded] = useState(false);

  /**
   * Called when user taps "Pair & Connect" on a discovered peer.
   */
  const handleInitiatePairing = useCallback(async (peer: DiscoveredPeer) => {
    setPairingTarget(peer);
    setPairingFingerprint(null);
    // Our code is about to be on screen: other devices asking now are told
    // we are busy, instead of a second sheet making the codes look wrong.
    pairingGuard.beginOutgoing(peer.id);
    const giveUp = (title: string, message: string) => {
      pairingGuard.decline(peer.id); // frees the screen; no strike, we asked
      setPairingTarget(null);
      Alert.alert(title, message);
    };
    try {
      // Everything the request needs, fetched in parallel rather than one
      // after another. The IP is only a hint: the desktop uses the address
      // the request arrives from.
      const [localFp, identity, settings, myIp] = await Promise.all([
        getPairingFingerprintForPeer(peer.id),
        getOrCreateDeviceIdentity(),
        getSettings(),
        Network.getIpAddressAsync().catch(() => "Unknown IP"),
      ]);

      // The code is derived from both public keys, so ours is already the
      // answer -- show it now instead of waiting on the network.
      setPairingFingerprint(localFp);

      // Ask the desktop to open its side of the ceremony. Bounded: without a
      // timeout an unreachable peer left the sheet up until the OS gave up.
      // Not paired yet, so any device that proves its identity is accepted;
      // comparing the codes is what decides whether to trust it. Signed, so
      // it knows the request really is from this phone.
      peerFetch(`${peer.ip}:${peer.port}`, "/api/pairing/request", {
        method: "POST",
        anyone: true,
        body: {
          device_id: identity.deviceId,
          name: settings.displayName,
          ip: myIp,
        },
        timeoutMs: 5_000,
      })
        .then((res) => {
          if (res.status === 403) {
            giveUp("Not accepted", `${peer.name} is not accepting pairing requests from this phone.`);
            return null;
          }
          if (res.status === 409) {
            giveUp("Busy", `${peer.name} is pairing with another device right now. Try again in a moment.`);
            return null;
          }
          if (res.status === 429) {
            const secs = Number(res.json()?.retry_after_secs) || 60;
            giveUp("Declined recently", `${peer.name} declined recently. You can ask again in ${waitPhrase(secs)}.`);
            return null;
          }
          if (!res.ok) throw Object.assign(new Error("pairing request rejected"), { status: res.status });
          return res.json();
        })
        .then((data) => {
          // The peer computes the same code; a mismatch means something is
          // wrong, and showing its value makes the codes visibly disagree.
          if (data?.fingerprint && data.fingerprint !== localFp) {
            setPairingFingerprint(data.fingerprint);
          }
        })
        .catch((err) => {
          giveUp(...pairingFailure(err, peer));
        });
    } catch {
      giveUp("Error", "An error occurred while initiating pairing.");
    }
  }, []);

  /**
   * Leaving while the code is on screen is a rejection. Tell the peer, so
   * its dialog closes too and -- if it already accepted -- it drops a key
   * this user did not vouch for.
   */
  const handleRejectPairing = useCallback(() => {
    if (pairingTarget && !pairingSucceeded) pairingGuard.decline(pairingTarget.id);
    if (pairingTarget && pairingFingerprint && !pairingSucceeded) {
      sendPairingCancel(pairingTarget.ip, pairingTarget.port).catch(() => {});
    }
    setPairingTarget(null);
  }, [pairingTarget, pairingFingerprint, pairingSucceeded]);

  // The other device rejected the codes: close our sheet and say so, rather
  // than leave the user comparing digits with a device that already said no.
  useEffect(() => {
    if (!pairingTarget || Platform.OS !== "android") return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onPairingCancelled", ({ deviceId }) => {
        if (deviceId !== pairingTarget.id) return;
        setPairingTarget(null);
        setPairingSucceeded(false);
        Alert.alert(
          "Pairing rejected",
          `${pairingTarget.name} said the codes don't match. Nothing was paired.`,
        );
      });
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, [pairingTarget]);

  /**
   * Called when user confirms the 6-digit code in the PairingModal.
   * Saves peer to SecureStore and redirects to the Paired Peers tab.
   */
  const handleConfirmPairing = useCallback(async () => {
    if (!pairingTarget) return;

    setIsPairingSubmitting(true);
    try {
      await savePairedPeer(pairingTarget);
      pairingGuard.confirmed(pairingTarget.id);
      // Announce ourselves now instead of on the next 20s heartbeat. If the
      // desktop has confirmed too, both sides show online straight away; if
      // not, its confirm says hello back to us.
      rescanPeer(pairingTarget.id).catch(() => {});
      // Refresh paired IDs so this device disappears from the scan list immediately
      const saved = await getPairedPeers();
      setPairedIds(new Set(saved.map((p) => p.id)));

      // Let the success state land before leaving: this is the payoff for the
      // only friction in the product, and it confirms WHICH device paired.
      setPairingSucceeded(true);
      setTimeout(() => {
        setPairingTarget(null);
        setPairingSucceeded(false);
        router.replace("/peers" as any);
      }, 1900);
    } catch (err) {
      console.warn("[scan] pairing confirmation failed:", err);
      Alert.alert(
        "Pairing failed",
        "Could not save this device. Check both devices are still on the same network and try again.",
      );
    } finally {
      setIsPairingSubmitting(false);
    }
  }, [pairingTarget, router]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />

      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Scan &amp; Pair</Text>
              <Text style={styles.subtitle}>
                Discover nearby LANclave devices on local network
              </Text>
              <Text style={styles.subtitle}>
                You appear as <Text style={styles.selfName}>{selfName}</Text>
                {selfTag ? ` · ${selfTag}` : ""}
              </Text>
            </View>
            <Pressable
              onPress={scan}
              disabled={isScanning}
              accessibilityRole="button"
              accessibilityLabel={
                isScanning ? "Scanning for devices" : "Scan for devices"
              }
              hitSlop={8}
              style={[styles.scanBtn, isScanning && styles.scanBtnDisabled]}
            >
              {isScanning ? (
                <View style={styles.scanBtnBusy}>
                  <ActivityIndicator size="small" color={C.action} />
                  <Text style={styles.scanBtnText}>Scanning</Text>
                </View>
              ) : (
                <Text style={styles.scanBtnText}>{lastScan ? "Scan again" : "Scan"}</Text>
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Content */}
        <View style={styles.content}>
          {peers.length === 0 ? (
            <View style={styles.empty}>
              {isScanning ? (
                <ScanAnimation size={200} />
              ) : (
                <Icon name="scan" size={40} color={C.contentFaint} />
              )}
              <Text style={styles.emptyTitle}>
                {isScanning
                  ? "Scanning local network…"
                  : notOnNetwork
                    ? "Not on a local network"
                    : "No devices found"}
              </Text>
              <Text style={styles.emptyHint}>
                {isScanning
                  ? progressText
                  : notOnNetwork
                    ? "Connect to Wi-Fi or turn on your hotspot, then scan again."
                    : lastScan
                      ? `${coveredText ?? ""} Make sure LANclave is open and visible on the other device, on the same Wi-Fi or hotspot.`.trim()
                      : "Tap Scan to search. Make sure both devices are on the same Wi-Fi network or hotspot and the LANclave server is active."}
              </Text>
            </View>
          ) : (
            <>
              {(isScanning || coveredText) && (
                <Text style={styles.status}>
                  {isScanning ? progressText : coveredText}
                </Text>
              )}
              <FlatList
                data={peers}
                numColumns={2}
                columnWrapperStyle={styles.columnWrapper}
                contentContainerStyle={styles.list}
                showsVerticalScrollIndicator={false}
                keyExtractor={(p) => p.id}
                renderItem={({ item }) => (
                  <PeerCard
                    peer={item}
                    isSelected={pairingTarget?.id === item.id}
                    onConnect={handleInitiatePairing}
                  />
                )}
              />
            </>
          )}
        </View>
      </SafeAreaView>

      {/* 6-Digit Interactive Pairing Modal */}
      <PairingModal
        visible={pairingTarget !== null}
        peerName={pairingTarget?.name ?? "Peer Device"}
        peerIp={pairingTarget?.ip ?? ""}
        fingerprint={pairingFingerprint}
        isSubmitting={isPairingSubmitting}
        succeeded={pairingSucceeded}
        peerId={pairingTarget?.id}
        selfName={selfName}
        onClose={handleRejectPairing}
        onConfirm={handleConfirmPairing}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  headerRow: { flexDirection: "row", alignItems: "center" },
  headerText: { flex: 1 },
  scanBtn: {
    minWidth: 72,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  scanBtnDisabled: { opacity: 0.7 },
  scanBtnBusy: { flexDirection: "row", alignItems: "center", gap: 8 },
  scanBtnText: { color: C.action, fontSize: 13, fontWeight: "600" },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.action,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.contentMuted },
  selfName: { color: C.content, fontWeight: "600" },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  status: { fontSize: 12, color: C.contentMuted, marginBottom: 12 },
  // Keep the last row of cards clear of the tab bar.
  list: { paddingBottom: 24 },

  columnWrapper: { gap: 12, marginBottom: 12 },

  // Empty State
  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    paddingVertical: 36,
    paddingHorizontal: 20,
    marginTop: 20,
  },
  emptyIcon: { fontSize: 32, marginBottom: 12 },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: C.content,
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 12,
    color: C.contentMuted,
    textAlign: "center",
    lineHeight: 18,
  },
});
