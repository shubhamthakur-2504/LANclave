import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { C } from "@/constants/colors";

export interface PairingModalProps {
  visible: boolean;
  peerName: string;
  peerIp: string;
  fingerprint: string | null;
  isSubmitting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function PairingModal({
  visible,
  peerName,
  peerIp,
  fingerprint,
  isSubmitting,
  onClose,
  onConfirm,
}: PairingModalProps) {
  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          {/* Header */}
          <Text style={styles.title}>Confirm Security Code</Text>

          <Text style={styles.subtitle}>
            Pairing with <Text style={styles.highlight}>{peerName}</Text> ({peerIp})
          </Text>

          {/* 6-Digit Fingerprint Box */}
          <View style={styles.codeBox}>
            {fingerprint ? (
              <Text style={styles.codeText}>{fingerprint}</Text>
            ) : (
              <ActivityIndicator color={C.action} size="small" />
            )}
          </View>

          {/* Verification Instructions */}
          <Text style={styles.instruction}>
            Compare this 6-digit code with the code displayed on the other device's screen.
            {"\n\n"}
            <Text style={styles.shieldIcon}>🛡️ </Text>
            If both codes match, tap <Text style={styles.boldText}>Confirm & Pair</Text>.
          </Text>

          {/* Action Buttons */}
          <View style={styles.btnRow}>
            <Pressable
              style={({ pressed }) => [
                styles.cancelBtn,
                pressed && styles.btnPressed,
              ]}
              onPress={onClose}
              disabled={isSubmitting}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.confirmBtn,
                pressed && styles.btnPressed,
                isSubmitting && styles.btnDisabled,
              ]}
              onPress={onConfirm}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.confirmText}>Confirm & Pair</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: 24,
    alignItems: "center",
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: C.content,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: C.contentMuted,
    textAlign: "center",
    marginBottom: 20,
  },
  highlight: {
    color: C.content,
    fontWeight: "600",
  },

  // 6-digit fingerprint container
  codeBox: {
    width: "100%",
    borderRadius: 14,
    backgroundColor: "#0C1F38",
    borderWidth: 1,
    borderColor: C.action,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  codeText: {
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: 8,
    color: C.action,
    fontFamily: "monospace",
  },

  instruction: {
    fontSize: 12,
    color: C.contentMuted,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: 24,
  },
  shieldIcon: {
    fontSize: 14,
  },
  boldText: {
    color: C.content,
    fontWeight: "600",
  },

  // Buttons
  btnRow: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.borderStrong,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: C.surface,
  },
  cancelText: {
    fontSize: 13,
    fontWeight: "600",
    color: C.contentMuted,
  },
  confirmBtn: {
    flex: 1.4,
    borderRadius: 12,
    backgroundColor: C.action,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  btnPressed: {
    opacity: 0.8,
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
