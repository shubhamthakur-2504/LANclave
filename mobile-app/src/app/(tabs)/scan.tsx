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
  sendPairingCancel,
} from "@/services/pairing";
import ExpoNativeServerModule from "../../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getSettings } from "@/services/settings";
import { rescanPeer } from "@/services/presence";
import { Icon } from "@/components/Icon";
import * as Network from "expo-network";

export default function ScanScreen() {
  const router = useRouter();
  const { peers: allDiscovered, isScanning, scan } = usePeerDiscovery();

  // Keep a live set of paired IDs so we can filter them out of the scan list
  const [pairedIds, setPairedIds] = useState<Set<string>>(new Set());
  /** Our own name, so the pairing sheet can show both ends of the pair. */
  const [selfName, setSelfName] = useState("This phone");

  // Refresh paired IDs every time this screen gains focus
  useFocusEffect(
    useCallback(() => {
      getPairedPeers().then((saved) =>
        setPairedIds(new Set(saved.map((p) => p.id)))
      );
      getSettings()
        .then((s) => setSelfName(s.displayName || "This phone"))
        .catch(() => {});
    }, []),
  );

  // Only show devices that are NOT yet paired
  const peers = allDiscovered.filter((p) => !pairedIds.has(p.id));

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
      fetch(`http://${peer.ip}:${peer.port}/api/pairing/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: identity.deviceId,
          name: settings.displayName,
          ip: myIp,
        }),
        signal: AbortSignal.timeout(5_000),
      })
        .then((res) => {
          if (!res.ok) throw new Error("Server rejected pairing request");
          return res.json();
        })
        .then((data) => {
          // The peer computes the same code; a mismatch means something is
          // wrong, and showing its value makes the codes visibly disagree.
          if (data?.fingerprint && data.fingerprint !== localFp) {
            setPairingFingerprint(data.fingerprint);
          }
        })
        .catch(() => {
          setPairingTarget(null);
          Alert.alert("Connection Failed", "Could not connect to the peer. Make sure its server is running.");
        });
    } catch {
      setPairingTarget(null);
      Alert.alert("Error", "An error occurred while initiating pairing.");
    }
  }, []);

  /**
   * Leaving while the code is on screen is a rejection. Tell the peer, so
   * its dialog closes too and -- if it already accepted -- it drops a key
   * this user did not vouch for.
   */
  const handleRejectPairing = useCallback(() => {
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
      }, 1200);
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
                <ActivityIndicator size="small" color={C.action} />
              ) : (
                <Text style={styles.scanBtnText}>Scan</Text>
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Content */}
        <View style={styles.content}>
          {peers.length === 0 ? (
            <View style={styles.empty}>
              <Icon name="scan" size={40} color={C.contentFaint} />
              <Text style={styles.emptyTitle}>
                {isScanning ? "Scanning local network…" : "No devices found"}
              </Text>
              <Text style={styles.emptyHint}>
                {isScanning
                  ? "Checking every address on this network."
                  : "Tap Scan to search. Make sure both devices are on the same Wi-Fi network or hotspot and the LANclave server is active."}
              </Text>
            </View>
          ) : (
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
  scanBtnDisabled: { opacity: 0.5 },
  scanBtnText: { color: C.action, fontSize: 13, fontWeight: "600" },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.action,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.contentMuted },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
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
