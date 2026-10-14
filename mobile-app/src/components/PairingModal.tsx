/**
 * The security ceremony.
 *
 * This is the one screen where the user must genuinely stop and compare
 * something, so it is deliberately the most designed surface in the app:
 *
 * - The six digits are the largest thing on screen, monospaced and grouped
 *   as `428 106`, which is far easier to read aloud and compare than a run
 *   of six.
 * - Both devices are named side by side, so it is obvious what is being
 *   paired with what.
 * - Confirm and reject carry equal visual weight. A pairing dialog where
 *   confirm is the big accent button trains people to tap it without
 *   reading, which defeats the entire point of the fingerprint.
 * - The stakes are one plain sentence, not a paragraph.
 */

import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { C, idColor } from "@/constants/colors";
import { Icon } from "@/components/Icon";
import { PairedAnimation } from "@/components/brand/PairedAnimation";

export interface PairingModalProps {
  visible: boolean;
  peerName: string;
  peerIp: string;
  fingerprint: string | null;
  isSubmitting?: boolean;
  /** Shown after a successful pair, before the modal closes. */
  succeeded?: boolean;
  /** This device's own name, so both sides of the pair are named. */
  selfName?: string;
  /** The other device's id: its identity colour is its stream in the paired animation. */
  peerId?: string;
  onClose: () => void;
  onConfirm: () => void;
  /** Reject and refuse this device from now on. Only for requests that came to us. */
  onBlock?: () => void;
}

/** Group the six digits as `428 106`. */
function groupFingerprint(fp: string): string {
  const digits = fp.replace(/\s+/g, "");
  if (digits.length !== 6) return fp;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function PairingModal({
  visible,
  peerName,
  peerIp,
  fingerprint,
  isSubmitting,
  succeeded,
  selfName = "This phone",
  peerId,
  onClose,
  onBlock,
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
          {succeeded ? (
            <View style={styles.successWrap}>
              {/* The payoff for the only friction in the product: this
                  phone's stream (the accent) and the peer's (its identity
                  colour) meet and become the folder. */}
              <PairedAnimation
                size={180}
                colors={[C.actionHover, peerId ? idColor(peerId) : C.actionHover]}
                bg={C.surfaceRaised}
              />
              <Text style={styles.successTitle}>Paired with {peerName}</Text>
              <Text style={styles.successSub}>
                You can now browse and send files between these two devices.
              </Text>
            </View>
          ) : (
            <>
              <Text style={styles.title}>Check the code</Text>

              {/* Both ends of the pair, named. */}
              <View style={styles.pairRow}>
                <Text style={styles.pairName} numberOfLines={1}>
                  {selfName}
                </Text>
                <Icon name="shield" size={16} color={C.contentFaint} />
                <Text style={styles.pairName} numberOfLines={1}>
                  {peerName}
                </Text>
              </View>
              <Text style={styles.pairIp}>{peerIp}</Text>

              <View style={styles.codeBox}>
                {fingerprint ? (
                  <Text style={styles.codeText} accessibilityLabel={
                    `Security code ${fingerprint.split("").join(" ")}`
                  }>
                    {groupFingerprint(fingerprint)}
                  </Text>
                ) : (
                  <ActivityIndicator color={C.action} size="small" />
                )}
              </View>

              <Text style={styles.stakes}>
                Only confirm if the same six digits appear on the other device.
              </Text>
              <Text style={styles.stakesSub}>
                If they differ, reject — someone else may be trying to pair.
              </Text>

              <View style={styles.btnRow}>
                <Pressable
                  style={({ pressed }) => [
                    styles.rejectBtn,
                    pressed && styles.btnPressed,
                  ]}
                  onPress={onClose}
                  disabled={isSubmitting}
                  accessibilityRole="button"
                  accessibilityLabel="Codes do not match, reject pairing"
                >
                  <Text style={styles.rejectText}>They don&apos;t match</Text>
                </Pressable>

                <Pressable
                  style={({ pressed }) => [
                    styles.confirmBtn,
                    pressed && styles.btnPressed,
                    isSubmitting && styles.btnDisabled,
                  ]}
                  onPress={onConfirm}
                  disabled={isSubmitting || !fingerprint}
                  accessibilityRole="button"
                  accessibilityLabel="Codes match, confirm pairing"
                >
                  {isSubmitting ? (
                    <ActivityIndicator color={C.ok} size="small" />
                  ) : (
                    <Text style={styles.confirmText}>They match</Text>
                  )}
                </Pressable>
              </View>
              {onBlock && (
                <Pressable
                  onPress={onBlock}
                  disabled={isSubmitting}
                  accessibilityRole="button"
                  accessibilityLabel="Block this device and refuse its pairing requests"
                  style={({ pressed }) => [styles.blockBtn, pressed && styles.btnPressed]}
                >
                  <Text style={styles.blockText}>Block this device</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.78)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 20,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: 24,
    alignItems: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: C.content,
    marginBottom: 14,
  },

  pairRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: "100%",
  },
  pairName: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "600",
    color: C.content,
  },
  pairIp: {
    marginTop: 4,
    fontSize: 11,
    color: C.contentFaint,
  },

  codeBox: {
    width: "100%",
    borderRadius: 14,
    backgroundColor: C.surfaceInset,
    borderWidth: 1,
    borderColor: C.action,
    paddingVertical: 22,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
    marginBottom: 16,
  },
  codeText: {
    fontSize: 40,
    fontWeight: "700",
    letterSpacing: 6,
    color: C.action,
    fontFamily: "monospace",
  },

  stakes: {
    fontSize: 14,
    color: C.content,
    textAlign: "center",
    lineHeight: 20,
  },
  stakesSub: {
    marginTop: 6,
    fontSize: 12,
    color: C.contentFaint,
    textAlign: "center",
    marginBottom: 22,
  },

  btnRow: { flexDirection: "row", gap: 12, width: "100%" },
  // Equal flex on both: neither option is the default.
  rejectBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.dangerBorder,
    backgroundColor: C.dangerBg,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  rejectText: { fontSize: 13, fontWeight: "700", color: C.danger },
  confirmBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.okBorder,
    backgroundColor: C.okBg,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmText: { fontSize: 13, fontWeight: "700", color: C.ok },
  btnPressed: { opacity: 0.75 },
  blockBtn: { marginTop: 14, paddingVertical: 6 },
  blockText: { fontSize: 12, color: C.contentMuted, textAlign: "center" },
  btnDisabled: { opacity: 0.6 },

  successWrap: { alignItems: "center", paddingVertical: 8 },
  successTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: C.content,
    textAlign: "center",
  },
  successSub: {
    marginTop: 6,
    fontSize: 12,
    color: C.contentMuted,
    textAlign: "center",
    lineHeight: 18,
  },
});
