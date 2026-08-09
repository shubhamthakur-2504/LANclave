import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { C, short } from "@/constants/colors";
import { getPairedPeers, PairedPeerRecord } from "@/services/pairing";

interface PairedPeerStatus extends PairedPeerRecord {
  isOnline: boolean;
}

export default function PairedPeersScreen() {
  const router = useRouter();
  const [peersWithStatus, setPeersWithStatus] = useState<PairedPeerStatus[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkPeersHealth = useCallback(async () => {
    setIsRefreshing(true);
    const saved = await getPairedPeers();

    const checked = await Promise.all(
      saved.map(async (p): Promise<PairedPeerStatus> => {
        try {
          const res = await fetch(`http://${p.ip}:${p.port}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(1500),
          });
          return { ...p, isOnline: res.ok };
        } catch {
          return { ...p, isOnline: false };
        }
      }),
    );

    setPeersWithStatus(checked);
    setIsRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      checkPeersHealth();
      const interval = setInterval(checkPeersHealth, 8000);
      return () => clearInterval(interval);
    }, [checkPeersHealth]),
  );

  const handleOpenSandbox = (peer: PairedPeerStatus) => {
    router.push({
      pathname: "/peer-sandbox" as any,
      params: {
        ip: peer.ip,
        port: String(peer.port),
        name: peer.name,
      },
    });
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Paired Peers</Text>
            <Pressable
              style={styles.refreshBtn}
              onPress={checkPeersHealth}
              disabled={isRefreshing}
            >
              <Text style={styles.refreshText}>
                {isRefreshing ? "Checking…" : "🔄 Refresh"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Saved devices with confirmed security keys
          </Text>
        </View>

        <View style={styles.divider} />

        {/* Peers List */}
        <FlatList
          data={peersWithStatus}
          showsVerticalScrollIndicator={false}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                {/* Avatar */}
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {item.name[0]?.toUpperCase() ?? "P"}
                  </Text>
                </View>

                {/* Identity */}
                <View style={styles.info}>
                  <Text style={styles.name}>{short(item.name)}</Text>
                  <Text style={styles.ip}>
                    {item.ip}:{item.port}
                  </Text>
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
                    {item.isOnline ? "Online" : "Offline"}
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
                    ]}
                    onPress={() => handleOpenSandbox(item)}
                  >
                    <Text style={styles.openBtnText}>Open Sandbox 📂</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.offlineHint}>
                    Device is offline or unreachable on local network
                  </Text>
                )}
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🤝</Text>
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
  root: { flex: 1, backgroundColor: C.bg },
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
    color: C.accent,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.textSecond },
  refreshBtn: {
    backgroundColor: C.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  refreshText: { fontSize: 11, fontWeight: "600", color: C.accent },

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
    backgroundColor: C.surface,
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
  avatarText: { fontSize: 16, fontWeight: "700", color: C.accent },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: "600", color: C.textPrimary },
  ip: { marginTop: 2, fontSize: 12, color: C.textSecond },

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
    backgroundColor: C.onlineBg,
    borderColor: C.onlineBorder,
  },
  offlineBadge: {
    backgroundColor: C.errorBg,
    borderColor: C.errorBorder,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  onlineDot: { backgroundColor: C.online },
  offlineDot: { backgroundColor: C.errorText },
  statusText: { fontSize: 11, fontWeight: "600" },
  onlineText: { color: C.online },
  offlineText: { color: C.errorText },

  // Action row
  actionRow: { marginTop: 14 },
  openBtn: {
    borderRadius: 10,
    backgroundColor: C.accentBtn,
    paddingVertical: 10,
    alignItems: "center",
  },
  openBtnText: { fontSize: 13, fontWeight: "700", color: "#FFFFFF" },
  btnPressed: { opacity: 0.75 },
  offlineHint: {
    fontSize: 11,
    color: C.textMuted,
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
    backgroundColor: C.surface,
    paddingVertical: 36,
    paddingHorizontal: 20,
    marginTop: 20,
  },
  emptyIcon: { fontSize: 32, marginBottom: 12 },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: C.textPrimary,
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 12,
    color: C.textSecond,
    textAlign: "center",
    lineHeight: 18,
  },
  bold: { color: C.accent, fontWeight: "600" },

  sep: { height: 12 },
});
