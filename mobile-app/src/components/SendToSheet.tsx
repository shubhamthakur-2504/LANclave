/**
 * Pick an online paired device to send one sandbox file to. The send goes
 * through `startUpload`, which offers first and falls back to the old
 * upload for devices without offers.
 */

import { useEffect, useState } from "react";
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text } from "react-native";

import { C } from "@/constants/colors";
import { useTransfers } from "@/contexts/TransferContext";
import { getPeerPresence, type PeerPresence } from "@/services/presence";
import type { SandboxFileEntry } from "@/services/storage";

export function SendToSheet({ file, onClose }: { file: SandboxFileEntry | null; onClose: () => void }) {
  const { startUpload } = useTransfers();
  const [peers, setPeers] = useState<PeerPresence[]>([]);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    getPeerPresence()
      .then((all) => alive && setPeers(all.filter((p) => p.isOnline && !p.untrusted)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [file]);

  if (!file) return null;

  const send = async (peer: PeerPresence) => {
    onClose();
    try {
      await startUpload({ ip: peer.ip, port: peer.port, name: peer.name, id: peer.id }, file.uri, file.name, file.size);
    } catch (err) {
      Alert.alert("Couldn't send", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title} numberOfLines={1}>
            Send {file.name}
          </Text>
          {peers.length === 0 ? (
            <Text style={styles.empty}>No paired device is online right now.</Text>
          ) : (
            <FlatList
              data={peers}
              keyExtractor={(p) => p.id}
              renderItem={({ item }) => (
                <Pressable style={styles.row} onPress={() => send(item)}>
                  <Text style={styles.peer}>{item.name}</Text>
                </Pressable>
              )}
            />
          )}
          <Pressable onPress={onClose} style={styles.cancel} hitSlop={8}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: C.surfaceRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: 20,
    maxHeight: "60%",
  },
  title: { fontSize: 16, fontWeight: "700", color: C.content, marginBottom: 12 },
  empty: { fontSize: 14, color: C.contentMuted, paddingVertical: 12 },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  peer: { fontSize: 15, color: C.content },
  cancel: { alignSelf: "center", marginTop: 12 },
  cancelText: { fontSize: 14, color: C.contentMuted },
});
