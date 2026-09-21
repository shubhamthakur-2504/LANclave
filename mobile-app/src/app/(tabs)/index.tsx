import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Switch,
} from "react-native";

import { AddFileButton } from "@/components/AddFileButton";
import { LocalFileRow } from "@/components/LocalFileRow";
import { C } from "@/constants/colors";
import { useSandboxFiles } from "@/hooks/use-sandbox-files";
import { startServer, stopServer, isServerRunning } from "@/services/server";
import { useState, useEffect } from "react";

export default function MySandboxScreen() {
  const { files, isLoading: filesLoading, refreshFiles } = useSandboxFiles();
  const [serverVisible, setServerVisible] = useState(false);

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
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
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
                  trackColor={{ false: C.borderStrong, true: C.accent }}
                  thumbColor={C.textPrimary}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
               />
            </View>
          </View>
        </View>

        <View style={styles.divider} />

        {/* File List */}
        <FlatList
          data={files}
          showsVerticalScrollIndicator={false}
          keyExtractor={(f) => f.uri}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            filesLoading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={C.accent} size="small" />
                <Text style={styles.loadingText}>Loading files…</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => <LocalFileRow file={item} />}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            filesLoading ? null : (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>📦</Text>
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
    color: C.textSecond,
    fontWeight: "600",
  },
  subtitle: { fontSize: 13, color: C.textSecond },
  badge: {
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: C.textPrimary,
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
  loadingText: { fontSize: 13, color: C.textMuted },

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

  sep: { height: 8 },
});
