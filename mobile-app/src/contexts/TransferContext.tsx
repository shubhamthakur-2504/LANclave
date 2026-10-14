import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { offerFiles } from '@/contexts/OffersContext';
import ExpoNativeServerModule, { type NativeTransfer } from '../../modules/expo-native-server/src/ExpoNativeServerModule';
import { peerIdForAddress } from '@/services/history';

export type TransferStatus = 'pending' | 'in_progress' | 'verifying' | 'paused' | 'completed' | 'failed';
export type TransferDirection = 'download' | 'upload';

export interface Transfer {
  id: string;
  fileName: string;
  fileSize: number;
  peerName: string;
  direction: TransferDirection;
  progress: number; // bytes transferred
  status: TransferStatus;
  speed: number; // bytes per second
  startedAt: string;
  /** Completed without sending anything: the destination already had an identical copy. */
  skipped?: boolean;
  /**
   * Name at the destination. Differs from `fileName` when that was taken
   * (saved as "name (1).ext") or an identical copy lives under another name.
   */
  destName?: string;
  /** Peer address and remote name, so a screen can find its file's row. */
  peerAddr?: string;
  remoteName?: string;
  /** Downloads run in the native engine, which can pause and resume them. */
  native?: boolean;
  /** Why it stopped or is waiting ("Paused by sender", "Waiting for network", errors). */
  message?: string;
  /** Set when the download is a file of an accepted offer. */
  offerId?: string;
}

/** A native job as a transfer row. */
function fromNative(job: NativeTransfer, prev?: Transfer): Transfer {
  const status: TransferStatus =
    job.status === 'queued' ? 'pending'
    : job.status === 'skipped' ? 'completed'
    : job.status;
  return {
    id: job.id,
    fileName: job.fileName,
    fileSize: job.total || prev?.fileSize || 0,
    peerName: job.peerName ?? prev?.peerName ?? 'Unknown device',
    direction: 'download',
    progress: job.bytes,
    status,
    speed: prev?.speed ?? 0,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    skipped: job.status === 'skipped',
    destName: job.destName ?? undefined,
    peerAddr: prev?.peerAddr,
    remoteName: prev?.remoteName ?? job.fileName,
    native: true,
    message: job.pausedBySender ? 'Paused by sender' : job.message ?? placeInLine(job),
    offerId: job.offerId ?? undefined,
  };
}

/** A waiting download's place: "Next in line", "2 ahead". */
function placeInLine(job: NativeTransfer): string | undefined {
  if (job.status !== 'queued' || job.ahead == null) return undefined;
  return job.ahead === 0 ? 'Next in line' : `${job.ahead} ahead`;
}

export interface SelectedPeer {
  ip: string;
  port: number;
  name: string;
  /** Paired device id, for the history log. Looked up by address if absent. */
  id?: string;
}

interface TransferContextState {
  transfers: Transfer[];
  startDownload: (peer: SelectedPeer, fileName: string, fileSize: number, onComplete?: () => void) => Promise<void>;
  startUpload: (peer: SelectedPeer, localUri: string, remoteFileName: string, fileSize: number, onComplete?: () => void) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  /** Native downloads only: stop, keeping what arrived. */
  pauseTransfer: (id: string) => void;
  /** Continue a paused or failed native download from its partial file. */
  resumeTransfer: (id: string) => void;
  /** Drop a failed native download from the list, with what arrived. */
  removeTransfer: (id: string) => void;
}

const useNativeEngine = Platform.OS === 'android';

const TransferContext = createContext<TransferContextState | null>(null);

export const useTransfers = () => {
  const ctx = useContext(TransferContext);
  if (!ctx) throw new Error('useTransfers must be used within TransferProvider');
  return ctx;
};

export function TransferProvider({ children }: { children: React.ReactNode }) {
  // Native downloads still running from before this mounted (e.g. after
  // the JS side restarted while the engine kept going).
  const [transfers, setTransfers] = useState<Transfer[]>(() => {
    if (!useNativeEngine) return [];
    try {
      return ExpoNativeServerModule.getTransfers().map((j) => fromNative(j));
    } catch {
      return []; // older native build
    }
  });
  const transfersRef = useRef<Transfer[]>([]);
  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  // Track speed calculations
  const speedTrackerRef = useRef<Record<string, { lastBytes: number; lastTime: number }>>({});

  // Native downloads: rows follow the engine's events; `onComplete`
  // callbacks fire when their job ends well.
  const completionRef = useRef<Record<string, () => void>>({});

  useEffect(() => {
    if (!useNativeEngine) return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener('onTransferProgress', (job) => {
        const now = Date.now();
        setTransfers((prev) => {
          const old = prev.find((t) => t.id === job.id);
          const row = fromNative(job, old);
          const tracker = speedTrackerRef.current[job.id];
          if (job.status === 'in_progress' && tracker && now > tracker.lastTime) {
            row.speed = ((job.bytes - tracker.lastBytes) * 1000) / (now - tracker.lastTime);
          }
          if (!tracker || now - tracker.lastTime > 500) {
            speedTrackerRef.current[job.id] = { lastBytes: job.bytes, lastTime: now };
          }
          if (job.status !== 'in_progress') row.speed = 0;
          return old ? prev.map((t) => (t.id === job.id ? row : t)) : [row, ...prev];
        });
        if (job.status === 'completed' || job.status === 'skipped') {
          completionRef.current[job.id]?.();
        }
        if (['completed', 'skipped', 'failed'].includes(job.status)) {
          delete completionRef.current[job.id];
          delete speedTrackerRef.current[job.id];
        }
      });
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, []);

  // Files move through the native engine only: downloads are resumable,
  // verified and survive the app going to the background, and sending is an
  // offer the receiver pulls. The engine logs history itself. The JS
  // transfers these replaced could not check a peer's certificate.

  const startDownload = useCallback(async (
    peer: SelectedPeer,
    fileName: string,
    fileSize: number,
    onComplete?: () => void
  ) => {
    if (!useNativeEngine) {
      Alert.alert("Not supported", "Downloading needs the Android app.");
      return;
    }
    try {
      const peerAddr = `${peer.ip}:${peer.port}`;
      const peerId = peer.id ?? await peerIdForAddress(peer.ip, peer.port);
      const id = await ExpoNativeServerModule.pull(peerAddr, peerId, peer.name, fileName, fileSize > 0 ? fileSize : null);
      if (onComplete) completionRef.current[id] = onComplete;
      setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, peerAddr, remoteName: fileName } : t)));
    } catch (err) {
      console.warn('Download failed to start:', err);
    }
  }, []);

  const startUpload = useCallback(async (
    peer: SelectedPeer,
    localUri: string,
    remoteFileName: string,
    fileSize: number,
  ) => {
    if (!useNativeEngine) {
      Alert.alert("Not supported", "Sending needs the Android app.");
      return;
    }
    try {
      const peerId = peer.id ?? await peerIdForAddress(peer.ip, peer.port);
      const offerId = await offerFiles(
        { ip: peer.ip, port: peer.port, id: peerId, name: peer.name },
        [{ uri: localUri, name: remoteFileName, size: fileSize }],
      );
      // Shown under Sent on the Transfers tab. No id: too old to take offers.
      if (!offerId) {
        Alert.alert("Couldn't send", `${peer.name} needs a newer LANclave to receive files.`);
      }
    } catch (err) {
      Alert.alert("Couldn't send", err instanceof Error ? err.message : String(err));
    }
  }, []);

  const pauseTransfer = useCallback((id: string) => {
    ExpoNativeServerModule.pauseTransfer(id);
  }, []);

  const resumeTransfer = useCallback((id: string) => {
    ExpoNativeServerModule.resumeTransfer(id);
  }, []);

  // Failed downloads are kept across restarts, so one that will never
  // work needs a way out of the list.
  const removeTransfer = useCallback((id: string) => {
    ExpoNativeServerModule.removeTransfer(id);
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    ExpoNativeServerModule.cancelTransfer(id);
  }, []);

  return (
    <TransferContext.Provider
      value={{ transfers, startDownload, startUpload, cancelTransfer, pauseTransfer, resumeTransfer, removeTransfer }}
    >
      {children}
    </TransferContext.Provider>
  );
}
