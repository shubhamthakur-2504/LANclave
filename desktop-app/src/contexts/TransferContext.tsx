import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Transfer, TransferStatus, PeerInfo, FileEntry } from "../types";
import { useToast } from "../components/ui/Toast";

interface TransferProgressEvent {
  id: string;
  bytes_transferred: number;
  total_bytes: number;
  status: string;
  /** Present only on failure. */
  message?: string;
}

interface TransferContextState {
  transfers: Transfer[];
  startDownload: (peer: PeerInfo, file: FileEntry) => Promise<void>;
  startUpload: (peer: PeerInfo, localRelativePath: string, fileName: string, fileSize?: number) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  /** Re-run a failed transfer using the details recorded when it started. */
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

export const TransferProvider = ({ children }: { children: ReactNode }) => {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  // We use a ref to track the latest transfers so the event listeners don't need to be recreated
  const transfersRef = useRef<Transfer[]>([]);
  
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  // Track the previous bytes for speed calculation
  const speedTrackerRef = useRef<Record<string, { lastBytes: number; lastTime: number }>>({});
  
  // Track events that fire before the `invoke` promise resolves
  const earlyEventsRef = useRef<Record<string, { status: TransferStatus; bytes: number; total: number }>>({});

  // A finished transfer is announced with a toast so the Transfers page is
  // somewhere you go to look at detail, not somewhere you have to sit and
  // watch. The provider is mounted inside `ToastProvider` (see App.tsx).
  const toast = useToast();

  // Cancelling is a deliberate act, and the backend reports it as a failure.
  // Toasting it would tell the user something they just did. Ids land here on
  // cancel so the failure handler can stay quiet.
  const cancelledRef = useRef<Set<string>>(new Set());

  /** Name the file and the peer -- "done" alone is not worth interrupting for. */
  const announceFinished = useCallback(
    (t: Transfer | undefined) => {
      if (!t) {
        toast.success("Transfer complete.");
        return;
      }
      const verb = t.direction === "download" ? "Saved" : "Sent";
      const preposition = t.direction === "download" ? "from" : "to";
      toast.success(`${verb} ${t.fileName}.`, `${preposition} ${t.peerName}`);
    },
    [toast],
  );

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    const handleProgress = (event: { payload: TransferProgressEvent }) => {
      const { id, bytes_transferred, total_bytes, status } = event.payload;
      
      const now = Date.now();
      const tracker = speedTrackerRef.current[id];
      let speed = 0;
      
      if (tracker) {
        const timeDiff = (now - tracker.lastTime) / 1000; // seconds
        if (timeDiff > 0) {
          const bytesDiff = bytes_transferred - tracker.lastBytes;
          speed = bytesDiff / timeDiff;
        }
      } else {
        speedTrackerRef.current[id] = { lastBytes: bytes_transferred, lastTime: now };
      }
      
      // Update tracker
      if (tracker && now - tracker.lastTime > 500) {
          speedTrackerRef.current[id] = { lastBytes: bytes_transferred, lastTime: now };
      }

      setTransfers((prev) => {
        const exists = prev.some((t) => t.id === id);
        if (!exists) {
          earlyEventsRef.current[id] = { status: status as TransferStatus, bytes: bytes_transferred, total: total_bytes };
          return prev;
        }
        return prev.map((t) => 
          t.id === id 
            ? { 
                ...t, 
                progress: bytes_transferred, 
                fileSize: total_bytes > 0 ? total_bytes : t.fileSize,
                status: status as TransferStatus,
                speed: speed > 0 ? speed : t.speed // keep last speed if 0 to avoid jitter
              } 
            : t
        );
      });
    };

    const handleCompleted = (event: { payload: TransferProgressEvent }) => {
      const { id, bytes_transferred, total_bytes } = event.payload;
      cancelledRef.current.delete(id);
      announceFinished(transfersRef.current.find((t) => t.id === id));
      setTransfers((prev) => {
        const exists = prev.some((t) => t.id === id);
        if (!exists) {
          earlyEventsRef.current[id] = { status: "completed", bytes: bytes_transferred, total: total_bytes };
          return prev;
        }
        return prev.map((t) => 
          t.id === id 
            ? { ...t, progress: bytes_transferred, fileSize: total_bytes, status: "completed", speed: 0 } 
            : t
        );
      });
      delete speedTrackerRef.current[id];
    };

    const handleFailed = (event: { payload: TransferProgressEvent }) => {
      const { id, message } = event.payload;
      // A cancel is reported as a failure. `delete` returns true when this id
      // was one, and clears it in the same step.
      if (!cancelledRef.current.delete(id)) {
        const t = transfersRef.current.find((x) => x.id === id);
        toast.error(message ?? "Transfer failed", t?.peerName);
      }
      setTransfers((prev) => {
        const exists = prev.some((t) => t.id === id);
        if (!exists) {
          earlyEventsRef.current[id] = { status: "failed", bytes: 0, total: 0 };
          return prev;
        }
        return prev.map((t) => 
          t.id === id
            ? { ...t, status: "failed", speed: 0, error: message }
            : t
        );
      });
      delete speedTrackerRef.current[id];
    };

    listen<TransferProgressEvent>("transfer-progress", handleProgress).then(unsub => unlisteners.push(unsub));
    listen<TransferProgressEvent>("transfer-completed", handleCompleted).then(unsub => unlisteners.push(unsub));
    listen<TransferProgressEvent>("transfer-failed", handleFailed).then(unsub => unlisteners.push(unsub));

    return () => {
      unlisteners.forEach(unsub => unsub());
    };
  }, [announceFinished, toast]);

  const startDownload = useCallback(async (peer: PeerInfo, file: FileEntry) => {
    try {
      // Create a temporary ID, it will be replaced by the backend UUID immediately
      const tempId = Math.random().toString();
      
      const newTransfer: Transfer = {
        id: tempId,
        fileName: file.name,
        fileSize: file.size,
        peerId: peer.device_id,
        peerName: peer.device_name || peer.device_id, // Use device_name if available, else ID
        peerAddr: peer.addr,
        remotePath: file.name,
        localPath: file.name,
        direction: "download",
        progress: 0,
        status: "pending",
        speed: 0,
        startedAt: new Date().toISOString(),
      };
      
      setTransfers((prev) => [newTransfer, ...prev]);

      const transferId = await invoke<string>("pull_file", {
        peerAddr: peer.addr,
        remotePath: file.name, // Remote path is just the filename for now
        localFilename: file.name,
      });

      // Check if we already received events for this transferId before the promise resolved
      const earlyEvent = earlyEventsRef.current[transferId];
      if (earlyEvent) {
        delete earlyEventsRef.current[transferId];
      }

      // Update the ID and status
      setTransfers((prev) => 
        prev.map((t) => {
          if (t.id === tempId) {
            return {
              ...t,
              id: transferId,
              status: earlyEvent ? earlyEvent.status : "in_progress",
              progress: earlyEvent ? earlyEvent.bytes : t.progress,
              fileSize: earlyEvent && earlyEvent.total > 0 ? earlyEvent.total : t.fileSize,
            };
          }
          return t;
        })
      );

      // A small file can finish before `invoke` returns, so the listener had
      // no row to name. Announce it from here instead, where we do.
      if (earlyEvent) {
        const finished = { ...newTransfer, id: transferId };
        if (earlyEvent.status === "completed") {
          announceFinished(finished);
        } else if (earlyEvent.status === "failed") {
          toast.error("Transfer failed", peer.device_name);
        }
      }
    } catch (err) {
      console.error("Failed to start download:", err);
      toast.error(err, peer.device_name);
    }
  }, [announceFinished, toast]);

  const cancelTransfer = useCallback(async (id: string) => {
    try {
      cancelledRef.current.add(id);
      await invoke("cancel_transfer", { transferId: id });
      setTransfers((prev) => 
        prev.map((t) => (t.id === id ? { ...t, status: "failed", speed: 0 } : t))
      );
    } catch (err) {
      cancelledRef.current.delete(id);
      console.error("Failed to cancel transfer:", err);
    }
  }, []);

  const startUpload = useCallback(async (peer: PeerInfo, localRelativePath: string, fileName: string, fileSize: number = 0) => {
    try {
      const tempId = Math.random().toString();
      
      const newTransfer: Transfer = {
        id: tempId,
        fileName,
        fileSize,
        peerId: peer.device_id,
        peerName: peer.device_name || peer.device_id,
        peerAddr: peer.addr,
        remotePath: fileName,
        localPath: localRelativePath,
        direction: "upload",
        progress: 0,
        status: "pending",
        speed: 0,
        startedAt: new Date().toISOString(),
      };
      
      setTransfers((prev) => [newTransfer, ...prev]);

      const transferId = await invoke<string>("push_file", {
        peerAddr: peer.addr,
        localRelativePath,
        remotePath: fileName,
      });

      const earlyEvent = earlyEventsRef.current[transferId];
      if (earlyEvent) {
        delete earlyEventsRef.current[transferId];
      }

      setTransfers((prev) => 
        prev.map((t) => {
          if (t.id === tempId) {
            return {
              ...t,
              id: transferId,
              status: earlyEvent ? earlyEvent.status : "in_progress",
              progress: earlyEvent ? earlyEvent.bytes : t.progress,
              fileSize: earlyEvent && earlyEvent.total > 0 ? earlyEvent.total : t.fileSize,
            };
          }
          return t;
        })
      );

      // A small file can finish before `invoke` returns, so the listener had
      // no row to name. Announce it from here instead, where we do.
      if (earlyEvent) {
        const finished = { ...newTransfer, id: transferId };
        if (earlyEvent.status === "completed") {
          announceFinished(finished);
        } else if (earlyEvent.status === "failed") {
          toast.error("Transfer failed", peer.device_name);
        }
      }
    } catch (err) {
      console.error("Failed to start upload:", err);
      toast.error(err, peer.device_name);
    }
  }, [announceFinished, toast]);

  /**
   * Retry replays the original request rather than resuming: there is no
   * HTTP Range support yet, so a failed transfer starts over.
   */
  const retryTransfer = useCallback(
    async (id: string) => {
      const t = transfersRef.current.find((x) => x.id === id);
      if (!t || !t.peerAddr || !t.remotePath) return;

      const peer: PeerInfo = {
        addr: t.peerAddr,
        device_id: t.peerId,
        device_name: t.peerName,
        paired: true,
      };

      setTransfers((prev) => prev.filter((x) => x.id !== id));

      if (t.direction === "download") {
        await startDownload(peer, {
          name: t.remotePath,
          size: t.fileSize,
          is_directory: false,
        } as FileEntry);
      } else {
        await startUpload(peer, t.localPath ?? t.remotePath, t.remotePath, t.fileSize);
      }
    },
    [startDownload, startUpload],
  );

  return (
    <TransferContext.Provider
      value={{ transfers, startDownload, startUpload, cancelTransfer, retryTransfer }}
    >
      {children}
    </TransferContext.Provider>
  );
};
