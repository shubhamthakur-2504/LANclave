import {
  Alert,
  ActivityIndicator,
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AddFileButton } from "@/components/AddFileButton";
import { LocalFileRow } from "@/components/LocalFileRow";
import { C } from "@/constants/colors";
import { useSandboxFiles } from "@/hooks/use-sandbox-files";
import { startServer, stopServer, isServerRunning } from "@/services/server";
import { Icon } from "@/components/Icon";
import { Wordmark } from "@/components/brand/Mark";
import { SortBar } from "@/components/SortBar";
import { SendToSheet } from "@/components/SendToSheet";
import { openSandboxFile, shareSandboxFile } from "@/services/open-file";
import type { SandboxFileEntry } from "@/services/storage";
import { getLastSort, rememberSort, sortFiles, type SortState } from "@/utils/sort-files";
import { useState, useEffect, useMemo } from "react";

export default function MySandboxScreen() {
  const { files, isLoading: filesLoading, refreshFiles } = useSandboxFiles();
  const [serverVisible, setServerVisible] = useState(false);
  const [sort, setSort] = useState<SortState>(getLastSort);
  const [sendingFile, setSendingFile] = useState<SandboxFileEntry | null>(null);

  /** Long-press: the other things to do with a file. */
  const showActions = (file: SandboxFileEntry) => {
    if (file.isDirectory) return;
    Alert.alert(file.name, undefined, [
      { text: "Open", onPress: () => openSandboxFile(file) },
      { text: "Share", onPress: () => shareSandboxFile(file) },
      { text: "Send to a device", onPress: () => setSendingFile(file) },
    ], { cancelable: true });
  };
  const sortedFiles = useMemo(() => sortFiles(files, sort, (f) => f), [files, sort]);
  const changeSort = (next: SortState) => {
    setSort(next);
    rememberSort(next);
  };

  useEffect(() => {
    startServer()
      .then(() => setServerVisible(true))
      .catch((e) => {
        console.warn("[auto-start] Server start error:", e);
        setServerVisible(isServerRunning());
      });
  }, []);

  const toggleServer = async (val: boolean) => {
    try {
      if (val) {
        await startServer();
      } else {
        stopServer();
      }
    } catch (e) {
      console.warn("[toggle] Server toggle error:", e);
    }
    // Always reflect actual state — startServer may have silently failed
    setServerVisible(isServerRunning() || val);
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />

      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <Wordmark markSize={26} color={C.action} textColor={C.content} />
          </View>
          <View style={styles.headerRow}>
            <Text style={styles.title}>My Sandbox</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{files.length} Files</Text>
            </View>
          </View>
          <View style={styles.headerRow2}>
            <Text style={styles.subtitle}>Local sandboxed storage on this device</Text>
            <View style={styles.toggleRow}>
               <Text style={styles.toggleLabel}>Visible</Text>
               <Switch 
                  value={serverVisible} 
                  onValueChange={toggleServer} 
                  trackColor={{ false: C.borderStrong, true: C.action }}
                  thumbColor={C.content}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
               />
            </View>
          </View>
        </View>

        <View style={styles.divider} />

        {files.length > 1 && <SortBar sort={sort} onChange={changeSort} />}

        {/* File List */}
        <FlatList
          data={sortedFiles}
          showsVerticalScrollIndicator={false}
          keyExtractor={(f) => f.uri}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            filesLoading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={C.action} size="small" />
                <Text style={styles.loadingText}>Loading files…</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <LocalFileRow
              file={item}
              onPress={() => openSandboxFile(item)}
              onLongPress={() => showActions(item)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            filesLoading ? null : (
              <View style={styles.empty}>
                <Icon name="sandbox" size={40} color={C.contentFaint} />
                <Text style={styles.emptyTitle}>Your sandbox is empty</Text>
                <Text style={styles.emptyHint}>
                  Tap the + button below to pick photos or documents to store securely on this device.
                </Text>
              </View>
            )
          }
        />
      </SafeAreaView>

      <AddFileButton onFileAdded={refreshFiles} />
      <SendToSheet file={sendingFile} onClose={() => setSendingFile(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  brand: { marginBottom: 12 },
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
  headerRow2: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toggleLabel: {
    fontSize: 12,
    color: C.contentMuted,
    fontWeight: "600",
  },
  subtitle: { fontSize: 13, color: C.contentMuted },
  badge: {
    backgroundColor: C.surfaceActive,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: C.content,
  },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 110 },

  // Loading
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 20,
  },
  loadingText: { fontSize: 13, color: C.contentFaint },

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

  sep: { height: 8 },
});
