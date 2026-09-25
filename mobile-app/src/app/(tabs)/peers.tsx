import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { C, idColor, short } from "@/constants/colors";
import { Icon } from "@/components/Icon";
import { deviceKind, initialForDevice, KIND_ICON } from "@/constants/device";
import {
  clearPendingShares,
  collectIncomingShares,
  getPendingShares,
  PendingShare,
  subscribeShares,
} from "@/services/share";
import { uploadRemoteFile } from "@/services/peer-api";
import { recordTransfer } from "@/services/history";
import { offerFiles, readAutoAccept, setAutoAccept } from "@/contexts/OffersContext";
import { unpairPeer } from "@/services/pairing";
import {
  getPeerPresence,
  PeerPresence,
  rescanPeer,
  subscribePresence,
} from "@/services/presence";

type PairedPeerStatus = PeerPresence;

/**
 * Local re-read interval. Reads in-memory presence only (no network) so the
 * list notices a TTL expiring, which by nature emits no event.
 */
const LOCAL_REFRESH_MS = 5_000;

export default function PairedPeersScreen() {
  const router = useRouter();
  const [peersWithStatus, setPeersWithStatus] = useState<PairedPeerStatus[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** Files handed to us by the share sheet, waiting for a destination (U3.2). */
  const [shares, setShares] = useState<PendingShare[]>([]);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  /** Peers whose offers are taken without asking. */
  const [autoAccept, setAutoAcceptIds] = useState<Set<string>>(readAutoAccept);

  const load = useCallback(async () => {
    setPeersWithStatus(await getPeerPresence());
    setAutoAcceptIds(readAutoAccept());
  }, []);

  const toggleAutoAccept = (peer: PairedPeerStatus) => {
    try {
      setAutoAccept(peer.id, !autoAccept.has(peer.id));
    } catch (err) {
      Alert.alert("Couldn't change that", err instanceof Error ? err.message : String(err));
    }
    setAutoAcceptIds(readAutoAccept());
  };

  // Presence is maintained by the background heartbeat. This screen only
  // reads it -- it no longer sends any requests of its own.
  // A share can arrive while the app is already open, so check on focus.
  useFocusEffect(
    useCallback(() => {
      setShares(collectIncomingShares());
      const unsubShares = subscribeShares(() => setShares([...getPendingShares()]));
      return unsubShares;
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      load();
      const unsubscribe = subscribePresence(() => {
        load();
      });
      const timer = setInterval(load, LOCAL_REFRESH_MS);
      return () => {
        unsubscribe();
        clearInterval(timer);
      };
    }, [load]),
  );

  /** Targeted re-find of offline peers only -- never a subnet sweep. */
  const refreshOffline = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const offline = peersWithStatus.filter((p) => !p.isOnline);
      await Promise.all(offline.map((p) => rescanPeer(p.id)));
      await load();
    } finally {
      setIsRefreshing(false);
    }
  }, [peersWithStatus, load]);

  /** Send everything pending to this peer, then clear the queue. */
  const handleSendShares = useCallback(
    async (peer: PairedPeerStatus) => {
      if (shares.length === 0) return;
      setSendingTo(peer.id);
      const addr = `${peer.ip}:${peer.port}`;
      let sent = 0;

      // One offer for everything shared: one prompt on the other side.
      try {
        const offerId = await offerFiles(peer, shares);
        if (offerId) {
          clearPendingShares();
          setShares([]);
          Alert.alert(
            "Offered",
            `${shares.length} file${shares.length === 1 ? "" : "s"} offered to ${peer.name}. They'll be sent once accepted.`,
          );
          setSendingTo(null);
          return;
        }
      } catch (err) {
        Alert.alert("Couldn't send", err instanceof Error ? err.message : String(err));
        setSendingTo(null);
        return;
      }

      // A peer from before offers: upload them the old way.
      try {
        for (const share of shares) {
          try {
            const result = await uploadRemoteFile(addr, share.uri, share.name);
            void recordTransfer({
              direction: "sent",
              peer_id: peer.id,
              peer_name: peer.name,
              file_name: share.name,
              dest_name: result.savedAs,
              bytes: result.bytes,
              outcome: "completed",
            });
          } catch (err) {
            void recordTransfer({
              direction: "sent",
              peer_id: peer.id,
              peer_name: peer.name,
              file_name: share.name,
              bytes: 0,
              outcome: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
          sent += 1;
        }
        clearPendingShares();
        setShares([]);
        Alert.alert(
          "Sent",
          `${sent} file${sent === 1 ? "" : "s"} sent to ${peer.name}.`,
        );
      } catch (err) {
        Alert.alert(
          "Couldn't send",
          `Sent ${sent} of ${shares.length}. Check ${peer.name} is still reachable and try again.`,
        );
        console.warn("[share] upload failed:", err);
      } finally {
        setSendingTo(null);
      }
    },
    [shares],
  );

  /** Forget a peer on both sides (best effort for the other side). */
  const handleUnpair = (peer: PairedPeerStatus) => {
    const message = peer.untrusted
      ? `${peer.name} no longer trusts this phone. Remove it, then pair again to reconnect.`
      : `Both devices will forget each other, and you'll need to pair again to share files.`;
    Alert.alert(peer.untrusted ? `Remove ${peer.name}?` : `Unpair ${peer.name}?`, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: peer.untrusted ? "Remove" : "Unpair",
        style: "destructive",
        onPress: async () => {
          await unpairPeer(peer);
          await load();
        },
      },
    ]);
  };

  const handleOpenSandbox = (peer: PairedPeerStatus) => {
    router.push({
      pathname: "/peer-sandbox" as any,
      params: {
        ip: peer.ip,
        port: String(peer.port),
        name: peer.name,
        id: peer.id,
      },
    });
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />

      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Paired Peers</Text>
            <Pressable
              style={styles.refreshBtn}
              onPress={refreshOffline}
              disabled={isRefreshing}
              accessibilityRole="button"
              accessibilityLabel="Look for offline devices again"
              hitSlop={8}
            >
              {isRefreshing ? (
                <Text style={styles.refreshText}>Checking…</Text>
              ) : (
                <View style={styles.refreshInner}>
                  <Icon name="refresh" size={14} color={C.action} />
                  <Text style={styles.refreshText}>Refresh</Text>
                </View>
              )}
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Saved devices with confirmed security keys
          </Text>
        </View>

        {shares.length > 0 && (
          <View style={styles.shareBanner}>
            <Icon name="send" size={18} color={C.action} />
            <Text style={styles.shareText} numberOfLines={2}>
              Choose a device to send{" "}
              <Text style={styles.shareStrong}>
                {shares.length === 1 ? shares[0].name : `${shares.length} files`}
              </Text>
            </Text>
            <Pressable
              onPress={() => {
                clearPendingShares();
                setShares([]);
              }}
              accessibilityLabel="Cancel sending"
            >
              <Icon name="close" size={18} color={C.contentFaint} />
            </Pressable>
          </View>
        )}

        <View style={styles.divider} />

        {/* Peers List */}
        <FlatList
          data={peersWithStatus}
          showsVerticalScrollIndicator={false}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <View style={[styles.card, !item.isOnline && styles.cardOffline]}>
              <View style={styles.cardHeader}>
                {/* Avatar: initial, or a device glyph, on the peer's own
                    identity colour (stable across launches). */}
                <View
                  style={[
                    styles.avatar,
                    { backgroundColor: `${idColor(item.id)}22` },
                  ]}
                >
                  {initialForDevice(item.name) ? (
                    <Text style={[styles.avatarText, { color: idColor(item.id) }]}>
                      {initialForDevice(item.name)}
                    </Text>
                  ) : (
                    <Icon
                      name={KIND_ICON[deviceKind(undefined, item.name)]}
                      size={20}
                      color={idColor(item.id)}
                    />
                  )}
                </View>

                {/* Identity */}
                <View style={styles.info}>
                  <Text style={styles.name}>{short(item.name)}</Text>
                  <Text style={styles.ip}>
                    {item.ip}:{item.port}
                  </Text>
                  {autoAccept.has(item.id) && !item.untrusted && (
                    <Text style={styles.autoAcceptNote}>Accepts files without asking</Text>
                  )}
                </View>

                {/* Online/Offline Badge */}
                <View
                  style={[
                    styles.statusBadge,
                    item.isOnline ? styles.onlineBadge : styles.offlineBadge,
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      item.isOnline ? styles.onlineDot : styles.offlineDot,
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      item.isOnline ? styles.onlineText : styles.offlineText,
                    ]}
                  >
                    {item.untrusted ? "Not paired there" : item.isOnline ? "Online" : "Offline"}
                  </Text>
                </View>
              </View>

              {/* Action Button */}
              <View style={styles.actionRow}>
                {item.isOnline ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.openBtn,
                      pressed && styles.btnPressed,
                      sendingTo === item.id && styles.btnDisabled,
                    ]}
                    disabled={sendingTo !== null}
                    accessibilityRole="button"
                    accessibilityLabel={
                      shares.length > 0
                        ? `Send ${shares.length} file${shares.length === 1 ? "" : "s"} to ${item.name}`
                        : `Open ${item.name}'s sandbox`
                    }
                    onPress={() =>
                      shares.length > 0
                        ? handleSendShares(item)
                        : handleOpenSandbox(item)
                    }
                  >
                    {sendingTo === item.id ? (
                      <ActivityIndicator size="small" color={C.onAction} />
                    ) : (
                      <>
                        <Icon
                          name={shares.length > 0 ? "send" : "folder"}
                          size={16}
                          color={C.onAction}
                        />
                        <Text style={styles.openBtnText}>
                          {shares.length > 0 ? "Send here" : "Open sandbox"}
                        </Text>
                      </>
                    )}
                  </Pressable>
                ) : (
                  <Text style={styles.offlineHint}>
                    {item.untrusted
                      ? "It rejected the pairing or unpaired this phone."
                      : "Device is offline or unreachable on local network"}
                  </Text>
                )}
                <View style={styles.footer}>
                  {!item.untrusted && (
                    <Pressable
                      onPress={() => toggleAutoAccept(item)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={
                        autoAccept.has(item.id)
                          ? `Ask before taking files from ${item.name}`
                          : `Always accept files from ${item.name}`
                      }
                    >
                      <Text style={styles.footerText}>
                        {autoAccept.has(item.id) ? "Ask first" : "Always accept"}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => handleUnpair(item)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={item.untrusted ? `Remove ${item.name}` : `Unpair ${item.name}`}
                  >
                    <Text style={styles.unpairText}>{item.untrusted ? "Remove" : "Unpair"}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="peers" size={40} color={C.contentFaint} />
              <Text style={styles.emptyTitle}>No paired peers yet</Text>
              <Text style={styles.emptyHint}>
                Go to the <Text style={styles.bold}>Scan & Pair</Text> tab to discover and confirm 6-digit security codes with nearby devices.
              </Text>
            </View>
          }
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  cardOffline: { opacity: 0.6 },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 10 },
  footerText: { fontSize: 13, fontWeight: "600", color: C.contentMuted },
  autoAcceptNote: { fontSize: 11, color: C.ok, marginTop: 2 },
  unpairText: { fontSize: 13, fontWeight: "600", color: C.danger },
  btnDisabled: { opacity: 0.6 },
  shareBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.action,
    backgroundColor: C.surfaceRaised,
  },
  shareText: { flex: 1, fontSize: 13, color: C.contentMuted, lineHeight: 18 },
  shareStrong: { color: C.content, fontWeight: "700" },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.action,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.contentMuted },
  refreshBtn: {
    backgroundColor: C.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 14,
    // 44pt minimum touch target (U4.5).
    minHeight: 44,
    justifyContent: "center",
  },
  refreshText: { fontSize: 11, fontWeight: "600", color: C.action },
  refreshInner: { flexDirection: "row", alignItems: "center", gap: 6 },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },

  // Card
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    padding: 16,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#0C2344",
    borderWidth: 1,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 16, fontWeight: "700", color: C.action },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: "600", color: C.content },
  ip: { marginTop: 2, fontSize: 12, color: C.contentMuted },

  // Status badges
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  onlineBadge: {
    backgroundColor: C.okBg,
    borderColor: C.okBorder,
  },
  offlineBadge: {
    backgroundColor: C.dangerBg,
    borderColor: C.dangerBorder,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  onlineDot: { backgroundColor: C.ok },
  offlineDot: { backgroundColor: C.danger },
  statusText: { fontSize: 11, fontWeight: "600" },
  onlineText: { color: C.ok },
  offlineText: { color: C.danger },

  // Action row
  actionRow: { marginTop: 14 },
  openBtn: {
    flexDirection: "row",
    gap: 8,
    borderRadius: 10,
    backgroundColor: C.action,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  openBtnText: { fontSize: 13, fontWeight: "700", color: C.onAction },
  btnPressed: { opacity: 0.75 },
  offlineHint: {
    fontSize: 11,
    color: C.contentFaint,
    fontStyle: "italic",
    textAlign: "center",
  },

  // Empty state
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
  bold: { color: C.action, fontWeight: "600" },

  sep: { height: 12 },
});
