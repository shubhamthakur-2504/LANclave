import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { RemoteFileRow } from "@/components/RemoteFileRow";
import { C } from "@/constants/colors";
import { useRemotePeer } from "@/hooks/use-remote-peer";
import { useSandboxFiles } from "@/hooks/use-sandbox-files";
import { useTransfers } from "@/contexts/TransferContext";
import { Icon } from "@/components/Icon";
import { SortBar } from "@/components/SortBar";
import { getLastSort, rememberSort, sortFiles, type SortState } from "@/utils/sort-files";
import { useMemo, useState } from "react";

import * as DocumentPicker from "expo-document-picker";

export default function PeerSandboxScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ip: string; port: string; name: string; id?: string }>();

  const ip = params.ip ?? "";
  const port = Number(params.port ?? 8377);
  const name = params.name ?? "Peer";
  const id = params.id || undefined;

  const { refreshFiles } = useSandboxFiles();
  const { transfers, startDownload, startUpload } = useTransfers();

  const {
    remoteFiles,
    isFetching,
    error,
    fetchPeerFiles,
  } = useRemotePeer(
    ip ? { ip, port, name } : null,
  );

  const [sort, setSort] = useState<SortState>(getLastSort);
  const sortedRemote = useMemo(
    () =>
      sortFiles(remoteFiles, sort, (f) => ({
        name: f.name,
        size: f.size,
        isDirectory: f.is_directory,
        modified: f.modified,
      })),
    [remoteFiles, sort],
  );
  const changeSort = (next: SortState) => {
    setSort(next);
    rememberSort(next);
  };

  const handleSendFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false });
      if (result.canceled || result.assets.length === 0) return;

      const file = result.assets[0];
      await startUpload({ ip, port, name, id }, file.uri, file.name, file.size || 0, fetchPeerFiles);
    } catch (err) {
      console.warn("Failed to pick or send file:", err);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />

      <SafeAreaView style={styles.safe} edges={["top", "bottom", "left", "right"]}>
        {/* Header with Back Button */}
        <View style={styles.header}>
          <View style={styles.topRow}>
            <Pressable
              style={styles.backBtn}
              onPress={() => router.back()}
            >
              <Text style={styles.backText}>‹ Back</Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                style={styles.refreshBtn}
                onPress={handleSendFile}
              >
                <View style={styles.btnInner}>
                  <Icon name="upload" size={14} color={C.action} />
                  <Text style={styles.refreshText}>Send</Text>
                </View>
              </Pressable>
              <Pressable
                style={styles.refreshBtn}
                onPress={() => fetchPeerFiles()}
                disabled={isFetching}
              >
                <Text style={styles.refreshText}>
                  {isFetching ? "Syncing…" : "Sync"}
                </Text>
              </Pressable>
            </View>
          </View>

          <Text style={styles.title}>{name}&apos;s Sandbox</Text>
          <Text style={styles.subtitle}>
            {ip}:{port} • Connected & Authenticated
          </Text>
        </View>

        <View style={styles.divider} />

        {/* Error Banner */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {remoteFiles.length > 1 && <SortBar sort={sort} onChange={changeSort} />}

        {/* File List */}
        <FlatList
          data={sortedRemote}
          showsVerticalScrollIndicator={false}
          keyExtractor={(f) => f.name}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            isFetching ? (
              <View style={styles.loading}>
                <ActivityIndicator color={C.action} size="small" />
                <Text style={styles.loadingText}>Fetching remote file list…</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            // Native transfer ids are random: match on peer and file.
            const transfer = transfers.find(
              (t) => t.direction === 'download' && t.peerAddr === `${ip}:${port}` && t.remoteName === item.name,
            );
            const progressPct = transfer && transfer.fileSize > 0 && transfer.status === 'in_progress'
              ? Math.round((transfer.progress / transfer.fileSize) * 100)
              : undefined;

            return (
              <RemoteFileRow
                name={item.name}
                size={item.size}
                is_directory={item.is_directory}
                progress={progressPct}
                onDownload={() => startDownload({ ip, port, name, id }, item.name, item.size, refreshFiles)}
              />
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            isFetching ? null : (
              <View style={styles.empty}>
                <Icon name="folder" size={40} color={C.contentFaint} />
                <Text style={styles.emptyTitle}>Remote sandbox is empty</Text>
                <Text style={styles.emptyHint}>
                  No files available on this peer device yet.
                </Text>
              </View>
            )
          }
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  backBtn: {
    backgroundColor: C.surfaceActive,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  backText: { fontSize: 13, fontWeight: "600", color: C.action },
  refreshBtn: {
    backgroundColor: C.borderStrong,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  refreshText: { fontSize: 12, fontWeight: "600", color: C.action },
  btnInner: { flexDirection: "row", alignItems: "center", gap: 6 },

  title: { fontSize: 24, fontWeight: "700", color: C.content },
  subtitle: { marginTop: 2, fontSize: 12, color: C.contentMuted },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },

  // Error Banner
  errorBanner: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.dangerBorder,
    backgroundColor: C.dangerBg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 20,
    marginTop: 12,
  },
  errorText: { fontSize: 12, color: C.danger, lineHeight: 18 },

  // Loading
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 20,
  },
  loadingText: { fontSize: 13, color: C.contentFaint },

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

  sep: { height: 8 },
});
