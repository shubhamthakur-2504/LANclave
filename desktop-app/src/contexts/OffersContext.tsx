import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import type { IncomingOffer, OffersSnapshot, OutgoingOffer, PeerInfo } from "../types";

/**
 * Offers: files sent as "offer, consent, receiver pulls". This context holds
 * both sides -- offers we sent (waiting, accepted, done...) and offers we
 * received -- kept current by the backend's `offers-changed` event.
 */
interface OffersState {
  outgoing: OutgoingOffer[];
  incoming: IncomingOffer[];
  /** Incoming offers still waiting for an answer. */
  pendingIncoming: IncomingOffer[];
  /** Bytes served so far per outgoing offer file: `served[offerId][fileId]`. */
  served: Record<string, Record<string, number>>;
  /** The incoming offer whose prompt is open, if any. */
  promptOffer: IncomingOffer | null;
  openPrompt: (offerId: string) => void;
  closePrompt: () => void;
  /** Offer files to a peer. `"legacy"` means push them the old way. */
  sendFiles: (peer: PeerInfo, localNames: string[]) => Promise<"offer" | "legacy">;
  accept: (offerId: string, fileIds: string[]) => Promise<void>;
  decline: (offerId: string) => Promise<void>;
  cancelOutgoing: (offerId: string) => Promise<void>;
  setOutgoingPaused: (offerId: string, paused: boolean) => Promise<void>;
}

const OffersContext = createContext<OffersState | null>(null);

export function useOffers(): OffersState {
  const ctx = useContext(OffersContext);
  if (!ctx) throw new Error("useOffers must be used within an OffersProvider");
  return ctx;
}

export function OffersProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<OffersSnapshot>({ outgoing: [], incoming: [] });
  const [served, setServed] = useState<Record<string, Record<string, number>>>({});
  const [promptId, setPromptId] = useState<string | null>(null);

  useEffect(() => {
    // The page may load long after an offer arrived (the window is released
    // while hidden): one still waiting opens its prompt now.
    api
      .listOffers()
      .then((snap) => {
        setSnapshot(snap);
        const waiting = snap.incoming.find((o) => o.state === "waiting");
        if (waiting) setPromptId((current) => current ?? waiting.id);
      })
      .catch(() => {});
    const unlisteners: Promise<() => void>[] = [
      listen<OffersSnapshot>("offers-changed", (e) => setSnapshot(e.payload)),
      // A new offer opens its prompt, unless one is already being answered;
      // the rest wait in the Incoming list.
      listen<IncomingOffer>("offer-received", (e) =>
        setPromptId((current) => current ?? e.payload.id),
      ),
      listen<{ offer_id: string; file_id: string; bytes: number }>("offer-progress", (e) => {
        const { offer_id, file_id, bytes } = e.payload;
        setServed((prev) => ({
          ...prev,
          [offer_id]: { ...prev[offer_id], [file_id]: Math.max(bytes, prev[offer_id]?.[file_id] ?? 0) },
        }));
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  const sendFiles = useCallback(async (peer: PeerInfo, localNames: string[]) => {
    const result = await api.sendFiles(peer, localNames);
    return result.kind;
  }, []);

  const accept = useCallback(async (offerId: string, fileIds: string[]) => {
    await api.acceptOffer(offerId, fileIds);
    setPromptId((current) => (current === offerId ? null : current));
  }, []);

  const decline = useCallback(async (offerId: string) => {
    await api.declineOffer(offerId);
    setPromptId((current) => (current === offerId ? null : current));
  }, []);

  const pendingIncoming = snapshot.incoming.filter((o) => o.state === "waiting");
  const promptOffer = pendingIncoming.find((o) => o.id === promptId) ?? null;

  return (
    <OffersContext.Provider
      value={{
        outgoing: snapshot.outgoing,
        incoming: snapshot.incoming,
        pendingIncoming,
        served,
        promptOffer,
        openPrompt: setPromptId,
        closePrompt: () => setPromptId(null),
        sendFiles,
        accept,
        decline,
        cancelOutgoing: api.cancelOffer,
        setOutgoingPaused: api.pauseOffer,
      }}
    >
      {children}
    </OffersContext.Provider>
  );
}
