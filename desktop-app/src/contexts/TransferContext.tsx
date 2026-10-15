import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import { Transfer, TransferRow, PeerInfo, FileEntry } from "../types";
import { useToast } from "../components/ui/Toast";

/** A progress tick from a running transfer. Endings come as rows. */
interface TransferProgressEvent {
  id: string;
  bytes_transferred: number;
  total_bytes: number;
  status: string;
}

interface TransferContextState {
  transfers: Transfer[];
  /** `folder`: where the file is in the peer's sandbox, `a/b`; empty for the top. */
  startDownload: (peer: PeerInfo, file: FileEntry, folder?: string) => Promise<void>;
  startUpload: (peer: PeerInfo, localRelativePath: string, fileName: string) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  /** Stop a download, keeping what arrived; a waiting one leaves the queue. */
  pauseTransfer: (id: string) => Promise<void>;
  /** Continue a paused download from where it stopped. */
  resumeTransfer: (id: string) => Promise<void>;
  /** Drop a paused download and its partial file. */
  discardTransfer: (id: string) => Promise<void>;
  /** Try a failed transfer again. */
  retryTransfer: (id: string) => Promise<void>;
}

const TransferContext = createContext<TransferContextState | null>(null);

export const useTransfers = () => {
  const context = useContext(TransferContext);
  if (!context) {
    throw new Error("useTransfers must be used within a TransferProvider");
  }
  return context;
};

/** A backend row as the page's transfer, keeping the speed the page measured. */
function fromRow(r: TransferRow, speed = 0): Transfer {
  return {
    id: r.id,
    fileName: r.file_name,
    fileSize: r.file_size,
    peerId: r.peer_id,
    peerName: r.peer_name ?? "Unknown device",
    direction: r.direction,
    progress: r.progress,
    status: r.status,
    speed: r.status === "in_progress" ? speed : 0,
    startedAt: new Date(r.started_ms).toISOString(),
    skipped: r.skipped,
    destName: r.dest_name ?? undefined,
    error: r.error ?? undefined,
    message: r.message ?? undefined,
    ahead: r.ahead ?? undefined,
    offerId: r.offer_id ?? undefined,
    offerFileId: r.offer_file_id ?? undefined,
    peerAddr: r.peer_addr ?? undefined,
    remotePath: r.remote_path ?? undefined,
    localPath: r.local_path ?? undefined,
  };
}

/**
 * The Transfers list. The backend holds it and runs the queue
 * (`transfers.rs`); this reads it when the page loads and then follows its
 * events, so the page can come and go without losing anything.
 */
export const TransferProvider = ({ children }: { children: ReactNode }) => {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const transfersRef = useRef<Transfer[]>([]);
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  // Speed is measured here, from progress ticks.
  const speedRef = useRef<Record<string, { bytes: number; at: number; speed: number }>>({});

  // A finished transfer is announced with a toast so the Transfers page is
  // somewhere you go to look at detail, not somewhere you have to sit and
  // watch. The provider is mounted inside `ToastProvider` (see App.tsx).
  const toast = useToast();

  /** Name the file and the peer -- "done" alone is not worth interrupting for. */
  const announceFinished = useCallback(
    (t: Transfer) => {
      if (t.skipped) {
        const where = t.direction === "download" ? "You already have" : `${t.peerName} already has`;
        const as = t.destName && t.destName !== t.fileName ? ` as ${t.destName}` : "";
        toast.info(`${where} ${t.fileName}${as}.`, "Identical copy, nothing sent");
        return;
      }
      const verb = t.direction === "download" ? "Saved" : "Sent";
      const preposition = t.direction === "download" ? "from" : "to";
      const renamed =
        t.destName && t.destName !== t.fileName ? ` Name was taken, saved as ${t.destName}.` : "";
      toast.success(`${verb} ${t.fileName}.${renamed}`, `${preposition} ${t.peerName}`);
    },
    [toast],
  );

  useEffect(() => {
    // An event can beat the initial read; the event is newer, so it wins.
    let heardEvent = false;
    const apply = (rows: TransferRow[]) =>
      setTransfers(rows.map((r) => fromRow(r, speedRef.current[r.id]?.speed)));

    api
      .listTransfers()
      .then((rows) => {
        if (!heardEvent) apply(rows);
      })
      .catch(() => {});

    const unlisteners = [
      listen<TransferRow[]>("transfers-changed", (e) => {
        heardEvent = true;
        apply(e.payload);
      }),
      listen<TransferProgressEvent>("transfer-progress", (e) => {
        const { id, bytes_transferred, total_bytes, status } = e.payload;
        const now = Date.now();
        const last = speedRef.current[id];
        let speed = last?.speed ?? 0;
        if (!last) {
          speedRef.current[id] = { bytes: bytes_transferred, at: now, speed: 0 };
        } else if (now - last.at > 500) {
          speed = ((bytes_transferred - last.bytes) * 1000) / (now - last.at);
          speedRef.current[id] = { bytes: bytes_transferred, at: now, speed };
        }
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  progress: bytes_transferred,
                  fileSize: total_bytes > 0 ? total_bytes : t.fileSize,
                  status: status === "verifying" ? "verifying" : "in_progress",
                  message: undefined,
                  speed: speed > 0 ? speed : t.speed,
                }
              : t,
          ),
        );
      }),
      // Completed or failed. A cancel or a pause is the user's own doing
      // and is not announced.
      listen<TransferRow>("transfer-ended", (e) => {
        delete speedRef.current[e.payload.id];
        const t = fromRow(e.payload);
        if (t.status === "completed") announceFinished(t);
        else toast.error(t.error ?? "Transfer failed", t.peerName);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [announceFinished, toast]);

  /** Run an action, toasting what went wrong. */
  const attempt = useCallback(
    async (action: () => Promise<unknown>, who?: string) => {
      try {
        await action();
      } catch (err) {
        toast.error(err, who);
      }
    },
    [toast],
  );

  const startDownload = useCallback(
    (peer: PeerInfo, file: FileEntry, folder = "") => attempt(() => api.pullFile(peer, file, folder), peer.device_name),
    [attempt],
  );

  const startUpload = useCallback(
    (peer: PeerInfo, localRelativePath: string, fileName: string) =>
      attempt(() => api.pushFile(peer, localRelativePath, fileName), peer.device_name),
    [attempt],
  );

  const cancelTransfer = useCallback((id: string) => attempt(() => api.cancelTransfer(id)), [attempt]);
  const pauseTransfer = useCallback((id: string) => attempt(() => api.pauseTransfer(id)), [attempt]);
  const resumeTransfer = useCallback((id: string) => attempt(() => api.resumeTransfer(id)), [attempt]);
  const discardTransfer = useCallback((id: string) => attempt(() => api.discardTransfer(id)), [attempt]);

  const retryTransfer = useCallback(
    async (id: string) => {
      const t = transfersRef.current.find((x) => x.id === id);
      if (!t) return;
      // A download continues from its partial file, at the front of the queue.
      if (t.direction === "download") return resumeTransfer(id);
      // A legacy push cannot resume: send it again.
      const { peerAddr, remotePath } = t;
      if (!peerAddr || !remotePath) return;
      const peer: PeerInfo = { addr: peerAddr, device_id: t.peerId, device_name: t.peerName, paired: true };
      await attempt(async () => {
        await api.discardTransfer(id);
        await api.pushFile(peer, t.localPath ?? remotePath, remotePath);
      }, t.peerName);
    },
    [attempt, resumeTransfer],
  );

  return (
    <TransferContext.Provider
      value={{
        transfers,
        startDownload,
        startUpload,
        cancelTransfer,
        pauseTransfer,
        resumeTransfer,
        discardTransfer,
        retryTransfer,
      }}
    >
      {children}
    </TransferContext.Provider>
  );
};
