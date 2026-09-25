/**
 * Offers on the phone: files sent as "offer, consent, receiver pulls".
 * Mirrors the desktop's OffersContext. State lives in native code (the
 * server receives offers, the engine pulls them); this follows its events.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";

export type OfferState = "waiting" | "accepted" | "declined" | "cancelled" | "expired" | "done";

export interface OfferFile {
  id: string;
  name: string;
  size: number;
}

export interface OfferResult {
  outcome: "completed" | "skipped" | "failed" | "cancelled";
  dest_name?: string | null;
  error?: string | null;
}

export interface OutgoingOffer {
  id: string;
  peer_id: string;
  peer_name: string | null;
  files: OfferFile[];
  state: OfferState;
  paused: boolean;
  accepted: string[];
  served: Record<string, number>;
  results: Record<string, OfferResult>;
  created_ms: number;
  expires_ms: number;
}

export interface IncomingOffer {
  id: string;
  peer_id: string;
  peer_name: string | null;
  files: OfferFile[];
  state: OfferState;
  accepted: string[];
  results: Record<string, OfferResult>;
  receiving: boolean;
  received_ms: number;
  expires_ms: number;
}

interface Snapshot {
  outgoing: OutgoingOffer[];
  incoming: IncomingOffer[];
}

interface OffersState extends Snapshot {
  pendingIncoming: IncomingOffer[];
  /** Bytes the receiver has pulled per outgoing offer file. */
  served: Record<string, Record<string, number>>;
  promptOffer: IncomingOffer | null;
  openPrompt: (offerId: string) => void;
  closePrompt: () => void;
  accept: (offerId: string, fileIds: string[]) => Promise<void>;
  decline: (offerId: string) => Promise<void>;
  cancelOutgoing: (offerId: string) => Promise<void>;
  setOutgoingPaused: (offerId: string, paused: boolean) => void;
}

const OffersContext = createContext<OffersState | null>(null);

export function useOffers(): OffersState {
  const ctx = useContext(OffersContext);
  if (!ctx) throw new Error("useOffers must be used within OffersProvider");
  return ctx;
}

const EMPTY: Snapshot = { outgoing: [], incoming: [] };

function parse(json: string): Snapshot {
  try {
    return JSON.parse(json) as Snapshot;
  } catch {
    return EMPTY;
  }
}

function readSnapshot(): Snapshot {
  if (Platform.OS !== "android") return EMPTY;
  try {
    return parse(ExpoNativeServerModule.listOffers());
  } catch {
    return EMPTY; // older native build
  }
}

export function OffersProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(readSnapshot);
  const [served, setServed] = useState<Record<string, Record<string, number>>>({});
  const [promptId, setPromptId] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subs: { remove: () => void }[] = [];
    try {
      subs.push(ExpoNativeServerModule.addListener("onOffersChanged", ({ json }) => setSnapshot(parse(json))));
      // A new offer opens its prompt unless one is already being answered.
      subs.push(
        ExpoNativeServerModule.addListener("onOfferReceived", ({ json }) => {
          try {
            const offer = JSON.parse(json) as IncomingOffer;
            setPromptId((current) => current ?? offer.id);
          } catch {
            // ignore a malformed event
          }
        }),
      );
      subs.push(
        ExpoNativeServerModule.addListener("onOfferProgress", ({ offerId, fileId, bytes }) =>
          setServed((prev) => ({
            ...prev,
            [offerId]: { ...prev[offerId], [fileId]: Math.max(bytes, prev[offerId]?.[fileId] ?? 0) },
          })),
        ),
      );
    } catch {
      // older native build
    }
    return () => subs.forEach((s) => s.remove());
  }, []);

  const accept = useCallback(async (offerId: string, fileIds: string[]) => {
    await ExpoNativeServerModule.acceptOffer(offerId, fileIds);
    setPromptId((current) => (current === offerId ? null : current));
  }, []);

  const decline = useCallback(async (offerId: string) => {
    await ExpoNativeServerModule.declineOffer(offerId);
    setPromptId((current) => (current === offerId ? null : current));
  }, []);

  const pendingIncoming = snapshot.incoming.filter((o) => o.state === "waiting");
  const promptOffer = pendingIncoming.find((o) => o.id === promptId) ?? null;

  return (
    <OffersContext.Provider
      value={{
        ...snapshot,
        pendingIncoming,
        served,
        promptOffer,
        openPrompt: setPromptId,
        closePrompt: () => setPromptId(null),
        accept,
        decline,
        cancelOutgoing: (id) => ExpoNativeServerModule.cancelOffer(id),
        setOutgoingPaused: (id, paused) => ExpoNativeServerModule.pauseOffer(id, paused),
      }}
    >
      {children}
    </OffersContext.Provider>
  );
}

/**
 * Offer files to a peer. Resolves to the offer id, or null when the peer
 * predates offers and the caller should push the old way.
 */
export async function offerFiles(
  peer: { ip: string; port: number; id: string; name: string },
  files: { uri: string; name: string; size?: number }[],
): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  return await ExpoNativeServerModule.sendFiles(
    `${peer.ip}:${peer.port}`,
    peer.id,
    peer.name,
    JSON.stringify(files.map((f) => ({ uri: f.uri, name: f.name, size: f.size ?? 0 }))),
  );
}
