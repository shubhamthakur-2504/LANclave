import { useState } from "react";
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { mockLocalFiles } from "@/constants/mockdata";
import { usePeerDiscovery } from "@/hooks/use-peer-discovery";

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:           "#080C14",   // deepest background
  surface:      "#0F1520",   // card surface
  border:       "#1E2A3F",   // subtle border – visible against bg
  borderStrong: "#2A3A58",   // slightly brighter border for emphasis

  // Text – all WCAG AA-compliant on bg
  textPrimary:  "#E8EDF5",   // headings, file names
  textSecond:   "#94A3B8",   // secondary labels (slate-400)
  textMuted:    "#64748B",   // placeholder / section labels (slate-500)

  // Accent
  accent:       "#38BDF8",   // sky-400 — interactive colour
  accentBtn:    "#0EA5E9",   // sky-500 — button fill

  // Status
  online:       "#34D399",   // emerald-400
  onlineBg:     "#052E16",   // dark green badge bg
  onlineBorder: "#064E3B",   // green badge border
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mb(bytes: number): string {
  if (bytes === 0) return "—";
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function short(s: string, max = 16): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop();
  if (ext === "jpg" || ext === "png") return "🖼";
  if (ext === "pdf") return "📄";
  if (ext === "m4a") return "🎙";
  if (ext === "txt") return "📝";
  return "📁";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children.toUpperCase()}</Text>;
}

function PeerCard({ name, ip }: { name: string; ip: string }) {
  return (
    <View style={styles.peerCard}>
      <View style={styles.peerAvatar}>
        <Text style={styles.peerAvatarLetter}>{name[0]?.toUpperCase() ?? "?"}</Text>
      </View>
      <Text style={styles.peerName}>{short(name)}</Text>
      <Text style={styles.peerIp}>{ip}</Text>
      <Pressable
        style={({ pressed }) => [styles.peerBtn, pressed && styles.peerBtnPressed]}
      >
        <Text style={styles.peerBtnText}>Pair & Connect</Text>
      </Pressable>
    </View>
  );
}

function FileRow({
  name,
  size,
  is_directory,
}: {
  name: string;
  size: number;
  is_directory: boolean;
}) {
  return (
    <View style={styles.fileRow}>
      <View style={styles.fileIconWrap}>
        <Text style={styles.fileIconText}>{fileIcon(name)}</Text>
      </View>
      <View style={styles.fileMeta}>
        <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
        <Text style={styles.fileSize}>{is_directory ? "Folder" : mb(size)}</Text>
      </View>
      {!is_directory && (
        <Pressable
          style={({ pressed }) => [styles.downloadBtn, pressed && styles.downloadBtnPressed]}
        >
          <Text style={styles.downloadBtnText}>↓</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const peers = usePeerDiscovery();
  const [files] = useState(mockLocalFiles);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <SafeAreaView style={styles.safe}>
        {/* ── Header ─────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>LANclave</Text>
            <View style={styles.statusBadge}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>Active</Text>
            </View>
          </View>
          <Text style={styles.headerSubtitle}>
            Secure local-network file transfer
          </Text>
        </View>

        <View style={styles.divider} />

        {/* ── Scrollable content ─────────────────────────────── */}
        <FlatList
          data={files}
          showsVerticalScrollIndicator={false}
          keyExtractor={(f) => f.name}
          contentContainerStyle={styles.scrollContent}
          ListHeaderComponent={
            <>
              {/* Peers */}
              <SectionLabel>Discovered Desktop Peers</SectionLabel>

              {peers.length === 0 ? (
                <View style={styles.emptyPeers}>
                  <Text style={styles.emptyPeersIcon}>📡</Text>
                  <Text style={styles.emptyPeersTitle}>Scanning local network…</Text>
                  <Text style={styles.emptyPeersHint}>
                    Open the LANclave desktop app{"\n"}on the same Wi-Fi network.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={peers}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.peerList}
                  keyExtractor={(p) => p.id}
                  renderItem={({ item }) => (
                    <PeerCard name={item.name} ip={item.ip} />
                  )}
                />
              )}

              <SectionLabel>My Sandboxed Storage</SectionLabel>
            </>
          }
          renderItem={({ item }) => (
            <FileRow name={item.name} size={item.size} is_directory={item.is_directory} />
          )}
          ItemSeparatorComponent={() => <View style={styles.fileSeparator} />}
        />
      </SafeAreaView>

      {/* ── FAB ────────────────────────────────────────────────── */}
      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => {
          // TODO: open document picker
        }}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </View>
  );
}

// ─── StyleSheet ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  // Header
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: "700",
    color: C.accent,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    marginTop: 4,
    fontSize: 13,
    color: C.textSecond,
  },
  statusBadge: {
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
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.online,
  },
  statusText: {
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

  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 100,
  },

  // Section labels
  sectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: C.textMuted,
    marginBottom: 10,
    marginTop: 8,
  },

  // Empty peers
  emptyPeers: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    paddingVertical: 28,
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  emptyPeersIcon: { fontSize: 28, marginBottom: 10 },
  emptyPeersTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: C.textPrimary,
    marginBottom: 6,
  },
  emptyPeersHint: {
    fontSize: 12,
    color: C.textSecond,
    textAlign: "center",
    lineHeight: 18,
  },

  // Peer cards
  peerList: { gap: 12, paddingBottom: 20 },
  peerCard: {
    width: 172,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    padding: 16,
  },
  peerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#0C2344",
    borderWidth: 1,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  peerAvatarLetter: { fontSize: 16, fontWeight: "700", color: C.accent },
  peerName: { fontSize: 14, fontWeight: "600", color: C.textPrimary },
  peerIp: { marginTop: 2, fontSize: 11, color: C.textSecond },
  peerBtn: {
    marginTop: 14,
    borderRadius: 10,
    backgroundColor: C.accentBtn,
    paddingVertical: 9,
    alignItems: "center",
  },
  peerBtnPressed: { opacity: 0.75 },
  peerBtnText: { fontSize: 12, fontWeight: "700", color: "#FFFFFF" },

  // File rows
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  fileSeparator: { height: 8 },
  fileIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  fileIconText: { fontSize: 18 },
  fileMeta: { flex: 1 },
  fileName: { fontSize: 14, fontWeight: "600", color: C.textPrimary },
  fileSize: { marginTop: 2, fontSize: 11, color: C.textSecond },
  downloadBtn: {
    marginLeft: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#0C2040",
    borderWidth: 1,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  downloadBtnPressed: { backgroundColor: "#0EA5E920" },
  downloadBtnText: { fontSize: 16, color: C.accent, fontWeight: "600" },

  // FAB
  fab: {
    position: "absolute",
    bottom: 28,
    right: 22,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.accentBtn,
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
  },
  fabPressed: { opacity: 0.8, transform: [{ scale: 0.95 }] },
  fabIcon: {
    fontSize: 28,
    color: "#FFFFFF",
    fontWeight: "300",
    lineHeight: 30,
  },
});
