import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Transfer, TransferStatus, PeerInfo, FileEntry } from "../types";

interface TransferProgressEvent {
  id: string;
  bytes_transferred: number;
  total_bytes: number;
  status: string;
}

interface TransferContextState {
  transfers: Transfer[];
  startDownload: (peer: PeerInfo, file: FileEntry) => Promise<void>;
  startUpload: (peer: PeerInfo, localRelativePath: string, fileName: string, fileSize?: number) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
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
      const { id } = event.payload;
      setTransfers((prev) => {
        const exists = prev.some((t) => t.id === id);
        if (!exists) {
          earlyEventsRef.current[id] = { status: "failed", bytes: 0, total: 0 };
          return prev;
        }
        return prev.map((t) => 
          t.id === id ? { ...t, status: "failed", speed: 0 } : t
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
  }, []);

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

    } catch (err) {
      console.error("Failed to start download:", err);
      // We could show a toast here
    }
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    try {
      await invoke("cancel_transfer", { transferId: id });
      setTransfers((prev) => 
        prev.map((t) => (t.id === id ? { ...t, status: "failed", speed: 0 } : t))
      );
    } catch (err) {
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

    } catch (err) {
      console.error("Failed to start upload:", err);
    }
  }, []);

  return (
    <TransferContext.Provider value={{ transfers, startDownload, startUpload, cancelTransfer }}>
      {children}
    </TransferContext.Provider>
  );
};
