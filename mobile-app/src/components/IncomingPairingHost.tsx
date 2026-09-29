/**
 * Shows the code-comparison sheet when another device starts pairing with
 * this phone, wherever the user is in the app.
 *
 * The phone-initiated flow lives on the Scan tab; this is its mirror for
 * pairing started on the desktop, so both ends always get the ceremony and
 * both store the pairing only when their own user confirms.
 */

import { useCallback, useEffect, useState } from "react";
import { Alert, Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { PairingModal } from "@/components/PairingModal";
import { pairingGuard, savePairedPeer, sendPairingCancel } from "@/services/pairing";
import { rescanPeer } from "@/services/presence";
import { getSettings } from "@/services/settings";

/** The peer's server port; requests carry only the address. */
const PEER_PORT = 8377;

interface IncomingRequest {
  deviceId: string;
  name: string;
  ip: string | null;
  fingerprint: string;
}

export function IncomingPairingHost() {
  // One that arrived before this mounted (e.g. during app start).
  const [request, setRequest] = useState<IncomingRequest | null>(() => {
    if (Platform.OS !== "android") return null;
    try {
      return ExpoNativeServerModule.consumePairingRequest();
    } catch {
      return null; // older native build
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [selfName, setSelfName] = useState("This phone");

  useEffect(() => {
    if (Platform.OS !== "android") return;
    getSettings()
      .then((s) => setSelfName(s.displayName || "This phone"))
      .catch(() => {});

    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onPairingRequest", (next) => {
        ExpoNativeServerModule.consumePairingRequest(); // shown now; drop the copy
        setSucceeded(false);
        setRequest(next);
      });
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, []);

  // The other device rejected (or gave up): close rather than leave the user
  // comparing digits with a device that already said no.
  useEffect(() => {
    if (!request || succeeded || Platform.OS !== "android") return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onPairingCancelled", ({ deviceId }) => {
        if (deviceId !== request.deviceId) return;
        setRequest(null);
        Alert.alert("Pairing cancelled", `${request.name} cancelled the pairing. Nothing was paired.`);
      });
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, [request, succeeded]);

  const reject = useCallback(() => {
    // Mutes this device for a while, longer after each rejection.
    if (request && !succeeded) pairingGuard.decline(request.deviceId);
    if (request?.ip && !succeeded) {
      // Close its dialog too, and make it drop us if it already confirmed.
      sendPairingCancel(request.ip, PEER_PORT).catch(() => {});
    }
    setRequest(null);
  }, [request, succeeded]);

  const confirm = useCallback(async () => {
    if (!request) return;
    setSubmitting(true);
    try {
      await savePairedPeer({
        id: request.deviceId,
        name: request.name,
        ip: request.ip ?? "",
        port: PEER_PORT,
      });
      pairingGuard.confirmed(request.deviceId);
      // Announce ourselves now rather than on the next heartbeat.
      rescanPeer(request.deviceId).catch(() => {});
      setSucceeded(true);
      setTimeout(() => {
        setRequest(null);
        setSucceeded(false);
      }, 1900);
    } catch (err) {
      console.warn("[pairing] could not save incoming pairing:", err);
      Alert.alert("Pairing failed", "Could not save this device. Try again from either device.");
    } finally {
      setSubmitting(false);
    }
  }, [request]);

  return (
    <PairingModal
      visible={request !== null}
      peerName={request?.name ?? ""}
      peerIp={request?.ip ?? ""}
      fingerprint={request?.fingerprint ?? null}
      isSubmitting={submitting}
      succeeded={succeeded}
      peerId={request?.deviceId}
      selfName={selfName}
      onClose={reject}
      onConfirm={confirm}
    />
  );
}
