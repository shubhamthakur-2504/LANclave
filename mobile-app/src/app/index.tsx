import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { AddFileButton } from "@/components/AddFileButton";
import { LocalFileRow } from "@/components/LocalFileRow";
import { PeerCard } from "@/components/PeerCard";
import { RemoteFileRow } from "@/components/RemoteFileRow";
import { C } from "@/constants/colors";
import { DiscoveredPeer } from "@/hooks/use-peer-discovery";
import { usePeerDiscovery } from "@/hooks/use-peer-discovery";
import { useRemotePeer } from "@/hooks/use-remote-peer";
import { useSandboxFiles } from "@/hooks/use-sandbox-files";

export default function HomeScreen() {
  const peers = usePeerDiscovery();
  const { files, isLoading: filesLoading, refreshFiles } = useSandboxFiles();
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);

  // Manual IP input toggle
  const [showIpInput, setShowIpInput] = useState(false);
  const [manualIp, setManualIp] = useState("");

  const {
    remoteFiles,
    isFetching,
    downloadProgress,
    error: peerError,
    fetchPeerFiles,
    downloadFile,
  } = useRemotePeer(
    selectedPeer
      ? { ip: selectedPeer.ip, port: selectedPeer.port, name: selectedPeer.name }
      : null,
    refreshFiles,
  );

  const handleConnect = useCallback((peer: DiscoveredPeer) => {
    setSelectedPeer(peer);
  }, []);

  const handleManualConnect = () => {
    if (!manualIp.trim()) return;
    const ip = manualIp.trim();
    const port = 8377;
    const customPeer: DiscoveredPeer = {
      id: `manual-${ip}`,
      name: `LANclave (${ip})`,
      ip,
      port,
    };
    handleConnect(customPeer);
    setShowIpInput(false);
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>LANclave</Text>
            <View style={styles.badge}>
              <View style={styles.dot} />
              <Text style={styles.badgeText}>Active</Text>
            </View>
          </View>
          <Text style={styles.subtitle}>Secure local-network file transfer</Text>
        </View>

        <View style={styles.divider} />

        {/* Scrollable body */}
        <FlatList
          data={files}
          showsVerticalScrollIndicator={false}
          keyExtractor={(f) => f.uri}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <>
              {/* ── Peers section header ─────────────────────── */}
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionLabel}>NEARBY LANCLAVE PEERS</Text>
                <Pressable
                  style={styles.connectIpBtn}
                  onPress={() => setShowIpInput((prev) => !prev)}
                >
                  <Text style={styles.connectIpText}>
                    {showIpInput ? "Cancel" : "+ Add IP"}
                  </Text>
                </Pressable>
              </View>

              {/* ── Manual IP Input Box ──────────────────────── */}
              {showIpInput && (
                <View style={styles.manualIpBox}>
                  <Text style={styles.manualIpTitle}>Connect via IP Address</Text>
                  <View style={styles.ipInputRow}>
                    <TextInput
                      style={styles.ipInput}
                      placeholder="e.g. 192.168.43.142"
                      placeholderTextColor={C.textMuted}
                      value={manualIp}
                      onChangeText={setManualIp}
                      keyboardType="decimal-pad"
                      autoCapitalize="none"
                    />
                    <Pressable
                      style={styles.ipSubmitBtn}
                      onPress={handleManualConnect}
                    >
                      <Text style={styles.ipSubmitText}>Connect</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {peers.length === 0 && !showIpInput ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyIcon}>📡</Text>
                  <Text style={styles.emptyTitle}>Scanning local network…</Text>
                  <Text style={styles.emptyHint}>
                    Open LANclave on another device (desktop or mobile) or tap "+ Add IP" above.
                  </Text>
                </View>
              ) : (
                peers.length > 0 && (
                  <FlatList
                    data={peers}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.peerList}
                    keyExtractor={(p) => p.id}
                    renderItem={({ item }) => (
                      <PeerCard
                        peer={item}
                        isSelected={selectedPeer?.id === item.id}
                        onConnect={handleConnect}
                      />
                    )}
                  />
                )
              )}

              {/* ── Connected peer's files ─────────────────── */}
              {selectedPeer !== null && (
                <>
                  <Text style={styles.sectionLabel}>
                    {selectedPeer.name.toUpperCase()}'S FILES
                  </Text>

                  {peerError !== null && (
                    <View style={styles.errorBanner}>
                      <Text style={styles.errorText}>{peerError}</Text>
                    </View>
                  )}

                  {isFetching ? (
                    <View style={styles.loading}>
                      <ActivityIndicator color={C.accent} size="small" />
                      <Text style={styles.loadingText}>Loading files…</Text>
                    </View>
                  ) : remoteFiles.length === 0 ? (
                    <View style={styles.empty}>
                      <Text style={styles.emptyIcon}>📂</Text>
                      <Text style={styles.emptyTitle}>No files found</Text>
                      <Text style={styles.emptyHint}>
                        The connected peer's sandbox is empty.
                      </Text>
                    </View>
                  ) : (
                    <FlatList
                      data={remoteFiles}
                      scrollEnabled={false}
                      keyExtractor={(f) => f.name}
                      ItemSeparatorComponent={() => (
                        <View style={styles.sep} />
                      )}
                      renderItem={({ item }) => (
                        <RemoteFileRow
                          name={item.name}
                          size={item.size}
                          is_directory={item.is_directory}
                          progress={downloadProgress[item.name]}
                          onDownload={downloadFile}
                        />
                      )}
                    />
                  )}
                </>
              )}

              {/* ── Local sandbox files ────────────────────── */}
              <Text style={styles.sectionLabel}>MY SANDBOXED STORAGE</Text>
              {filesLoading && (
                <View style={styles.loading}>
                  <ActivityIndicator color={C.accent} size="small" />
                  <Text style={styles.loadingText}>Loading files…</Text>
                </View>
              )}
            </>
          }
          renderItem={({ item }) => <LocalFileRow file={item} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            filesLoading ? null : (
              <Text style={styles.emptyLocalText}>
                No files yet — tap + to add one.
              </Text>
            )
          }
        />
      </SafeAreaView>

      <AddFileButton onFileAdded={refreshFiles} />
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
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.onlineBg,
    borderWidth: 1,
    borderColor: C.onlineBorder,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.online },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: C.online,
    letterSpacing: 0.3,
  },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 110 },

  // Section headers
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
    marginBottom: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: C.textMuted,
  },
  connectIpBtn: {
    backgroundColor: C.borderStrong,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  connectIpText: {
    fontSize: 11,
    fontWeight: "600",
    color: C.accent,
  },

  // Manual IP Box
  manualIpBox: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
  },
  manualIpTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: C.textPrimary,
    marginBottom: 8,
  },
  ipInputRow: {
    flexDirection: "row",
    gap: 8,
  },
  ipInput: {
    flex: 1,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    color: C.textPrimary,
    fontSize: 13,
  },
  ipSubmitBtn: {
    backgroundColor: C.accentBtn,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  ipSubmitText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  // Peer list
  peerList: { gap: 12, paddingBottom: 4 },

  // Empty states
  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    paddingVertical: 28,
    paddingHorizontal: 20,
    marginBottom: 4,
  },
  emptyIcon: { fontSize: 28, marginBottom: 10 },
  emptyTitle: {
    fontSize: 14,
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
  emptyLocalText: {
    fontSize: 13,
    color: C.textMuted,
    textAlign: "center",
    paddingVertical: 24,
  },

  // Error banner
  errorBanner: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.errorBorder,
    backgroundColor: C.errorBg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  errorText: { fontSize: 12, color: C.errorText, lineHeight: 18 },

  // Loading row
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 20,
  },
  loadingText: { fontSize: 13, color: C.textMuted },

  // Separator
  sep: { height: 8 },
});
