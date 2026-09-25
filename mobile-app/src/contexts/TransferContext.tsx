import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { offerFiles } from '@/contexts/OffersContext';
import ExpoNativeServerModule, { type NativeTransfer } from '../../modules/expo-native-server/src/ExpoNativeServerModule';
import { File, Directory } from 'expo-file-system';
import type { DownloadTask, UploadTask } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import { getAuthHeaders } from '@/services/identity';
import { getSettings } from '@/services/settings';
import { localCopyOf, numberedName, peerCopyOf } from '@/services/dedupe';
import { peerIdForAddress, recordTransfer, type HistoryOutcome } from '@/services/history';

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
    message: job.pausedBySender ? 'Paused by sender' : job.message ?? undefined,
    offerId: job.offerId ?? undefined,
  };
}

/** Last path segment of a SAF document URI, e.g. ".../LANclave%2Fphoto%20(1).jpg" → "photo (1).jpg". */
function nameFromDocumentUri(uri: string): string | undefined {
  try {
    return decodeURIComponent(uri).split(/[/:]/).pop() || undefined;
  } catch {
    return undefined;
  }
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

  // Track Expo FileSystem DownloadTasks and UploadTasks
  const tasksRef = useRef<Record<string, DownloadTask | UploadTask>>({});
  // Track speed calculations
  const speedTrackerRef = useRef<Record<string, { lastBytes: number; lastTime: number }>>({});
  // Latest byte count per transfer, so a failure can be logged with how far it got.
  const bytesRef = useRef<Record<string, number>>({});
  // Ids the user cancelled: their rejection is logged as cancelled, not failed.
  const cancelledRef = useRef<Set<string>>(new Set());

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

  /** Append a finished transfer to the 30-day history. Fire and forget. */
  const logTransfer = useCallback((
    peer: SelectedPeer,
    direction: TransferDirection,
    fileName: string,
    outcome: HistoryOutcome,
    bytes: number,
    extra: { destName?: string; error?: string } = {},
  ) => {
    void (async () => {
      await recordTransfer({
        direction: direction === 'download' ? 'received' : 'sent',
        peer_id: peer.id ?? await peerIdForAddress(peer.ip, peer.port),
        peer_name: peer.name,
        file_name: fileName,
        bytes,
        outcome,
        dest_name: extra.destName,
        error: extra.error,
      });
    })();
  }, []);

  /** How a rejected transfer ended: the user's cancel, or a real failure. */
  const endedAs = (transferId: string): HistoryOutcome =>
    cancelledRef.current.delete(transferId) ? 'cancelled' : 'failed';

  const startDownload = useCallback(async (
    peer: SelectedPeer,
    fileName: string,
    fileSize: number,
    onComplete?: () => void
  ) => {
    if (useNativeEngine) {
      // Native: resumable, verified, survives the app going to the
      // background. The engine logs history itself.
      try {
        const peerAddr = `${peer.ip}:${peer.port}`;
        const peerId = peer.id ?? await peerIdForAddress(peer.ip, peer.port);
        const id = await ExpoNativeServerModule.pull(peerAddr, peerId, peer.name, fileName, fileSize > 0 ? fileSize : null);
        if (onComplete) completionRef.current[id] = onComplete;
        setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, peerAddr, remoteName: fileName } : t)));
      } catch (err) {
        console.warn('Download failed to start:', err);
      }
      return;
    }

    // Generate an ID based on peer and filename
    const transferId = `${peer.ip}-${fileName}`;

    // Prevent duplicate downloads
    if (tasksRef.current[transferId]) return;

    setTransfers(prev => {
      // Remove any previous failed/completed transfer for this file
      const filtered = prev.filter(t => t.id !== transferId);
      return [{
        id: transferId,
        fileName,
        fileSize,
        peerName: peer.name,
        peerAddr: `${peer.ip}:${peer.port}`,
        remoteName: fileName,
        direction: 'download',
        progress: 0,
        status: 'pending',
        speed: 0,
        startedAt: new Date().toISOString(),
      }, ...filtered];
    });

    try {
      // Checked before creating the destination: on SAF, createFileAsync on
      // an existing name would leave a stray "name (1)" behind.
      const existing = await localCopyOf(`${peer.ip}:${peer.port}`, fileName, fileSize);
      if (existing) {
        setTransfers(prev => prev.map(t =>
          t.id === transferId
            ? { ...t, status: 'completed', skipped: true, destName: existing, progress: fileSize, speed: 0 }
            : t
        ));
        logTransfer(peer, 'download', fileName, 'skipped', fileSize, { destName: existing });
        onComplete?.();
        return;
      }

      const encodedPath = fileName.split('/').map(encodeURIComponent).join('/');
      const url = `http://${peer.ip}:${peer.port}/files/${encodedPath}`;
      const headers = await getAuthHeaders();
      const settings = await getSettings();

      // Never overwrite: a different file under this name is kept, and the
      // download saved as "name (1).ext" -- the same rule both servers use.
      let destination: File;
      let destName = fileName;

      if (settings.sandboxPath.startsWith("content://")) {
        // SAF picks the free "name (1)" itself.
        const createdUri = await StorageAccessFramework.createFileAsync(
          settings.sandboxPath,
          fileName,
          "application/octet-stream"
        );
        destination = new File(createdUri);
        destName = nameFromDocumentUri(createdUri) ?? fileName;
      } else {
        const dir = new Directory(settings.sandboxPath);
        let n = 0;
        do {
          destName = numberedName(fileName, n++);
          destination = new File(dir, destName);
        } while (destination.exists);
      }

      setTransfers(prev => prev.map(t => t.id === transferId ? { ...t, status: 'in_progress', destName } : t));

      const task = File.createDownloadTask(url, destination, {
        headers,
        onProgress: ({ bytesWritten, totalBytes }) => {
          bytesRef.current[transferId] = bytesWritten;
          const now = Date.now();
          const tracker = speedTrackerRef.current[transferId];
          let speed = 0;

          if (tracker) {
            const timeDiff = (now - tracker.lastTime) / 1000;
            if (timeDiff > 0) {
              speed = (bytesWritten - tracker.lastBytes) / timeDiff;
            }
          } else {
            speedTrackerRef.current[transferId] = { lastBytes: bytesWritten, lastTime: now };
          }

          if (tracker && now - tracker.lastTime > 500) {
            speedTrackerRef.current[transferId] = { lastBytes: bytesWritten, lastTime: now };
          }

          setTransfers(prev => prev.map(t =>
            t.id === transferId
              ? { ...t, progress: bytesWritten, fileSize: totalBytes > 0 ? totalBytes : t.fileSize, speed: speed > 0 ? speed : t.speed }
              : t
          ));
        }
      });

      tasksRef.current[transferId] = task;
      await task.downloadAsync();

      // On complete
      setTransfers(prev => prev.map(t =>
        t.id === transferId
          ? { ...t, status: 'completed', speed: 0, progress: t.fileSize }
          : t
      ));
      logTransfer(peer, 'download', fileName, 'completed', bytesRef.current[transferId] ?? fileSize, { destName });

      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      delete bytesRef.current[transferId];

      onComplete?.();

    } catch (err) {
      console.warn('Download failed:', err);
      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, status: 'failed', speed: 0 } : t
      ));
      logTransfer(peer, 'download', fileName, endedAs(transferId), bytesRef.current[transferId] ?? 0, {
        error: err instanceof Error ? err.message : String(err),
      });
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      delete bytesRef.current[transferId];
    }
  }, [logTransfer]);

  const startUpload = useCallback(async (
    peer: SelectedPeer,
    localUri: string,
    remoteFileName: string,
    fileSize: number,
    onComplete?: () => void
  ) => {
    // An offer first: the receiver consents, then pulls (resumable,
    // verified). Peers from before offers get the old upload below.
    if (useNativeEngine) {
      try {
        const peerId = peer.id ?? await peerIdForAddress(peer.ip, peer.port);
        const offerId = await offerFiles(
          { ip: peer.ip, port: peer.port, id: peerId, name: peer.name },
          [{ uri: localUri, name: remoteFileName, size: fileSize }],
        );
        if (offerId) return; // shown under Sent on the Transfers tab
      } catch (err) {
        Alert.alert("Couldn't send", err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const transferId = `${peer.ip}-up-${remoteFileName}`;

    if (tasksRef.current[transferId]) return;

    setTransfers(prev => {
      const filtered = prev.filter(t => t.id !== transferId);
      return [{
        id: transferId,
        fileName: remoteFileName,
        fileSize,
        peerName: peer.name,
        direction: 'upload',
        progress: 0,
        status: 'pending',
        speed: 0,
        startedAt: new Date().toISOString(),
      }, ...filtered];
    });

    try {
      const existing = await peerCopyOf(`${peer.ip}:${peer.port}`, localUri, remoteFileName, fileSize);
      if (existing) {
        setTransfers(prev => prev.map(t =>
          t.id === transferId
            ? { ...t, status: 'completed', skipped: true, destName: existing, progress: fileSize, speed: 0 }
            : t
        ));
        logTransfer(peer, 'upload', remoteFileName, 'skipped', fileSize, { destName: existing });
        onComplete?.();
        return;
      }

      const encodedPath = remoteFileName.split('/').map(encodeURIComponent).join('/');
      const url = `http://${peer.ip}:${peer.port}/files/${encodedPath}`;
      const headers = await getAuthHeaders();

      setTransfers(prev => prev.map(t => t.id === transferId ? { ...t, status: 'in_progress' } : t));

      const fileToUpload = new File(localUri);
      const task = fileToUpload.createUploadTask(url, {
        headers,
        httpMethod: 'PUT',
        uploadType: 0, // UploadType.BINARY_CONTENT from expo-file-system is usually 0
        onProgress: ({ totalBytesSent, totalBytesExpectedToSend }: any) => {
          bytesRef.current[transferId] = totalBytesSent;
          const now = Date.now();
          const tracker = speedTrackerRef.current[transferId];
          let speed = 0;

          if (tracker) {
            const timeDiff = (now - tracker.lastTime) / 1000;
            if (timeDiff > 0) {
              speed = (totalBytesSent - tracker.lastBytes) / timeDiff;
            }
          } else {
            speedTrackerRef.current[transferId] = { lastBytes: totalBytesSent, lastTime: now };
          }

          if (tracker && now - tracker.lastTime > 500) {
            speedTrackerRef.current[transferId] = { lastBytes: totalBytesSent, lastTime: now };
          }

          setTransfers(prev => prev.map(t =>
            t.id === transferId
              ? { ...t, progress: totalBytesSent, fileSize: totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : t.fileSize, speed: speed > 0 ? speed : t.speed }
              : t
          ));
        }
      });

      tasksRef.current[transferId] = task;
      // Resolves on any HTTP status -- a rejected upload must not read as done.
      const result = await task.uploadAsync();
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`peer rejected the upload (HTTP ${result.status})`);
      }

      // The peer names the file it saved; older peers send no JSON.
      let destName = remoteFileName;
      try {
        const saved = JSON.parse(result.body) as { name?: unknown };
        if (typeof saved.name === 'string') destName = saved.name;
      } catch {}

      setTransfers(prev => prev.map(t =>
        t.id === transferId
          ? { ...t, status: 'completed', speed: 0, progress: t.fileSize, destName }
          : t
      ));
      logTransfer(peer, 'upload', remoteFileName, 'completed', bytesRef.current[transferId] ?? fileSize, { destName });

      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      delete bytesRef.current[transferId];

      onComplete?.();

    } catch (err) {
      console.warn('Upload failed:', err);
      setTransfers(prev => prev.map(t =>
        t.id === transferId ? { ...t, status: 'failed', speed: 0 } : t
      ));
      logTransfer(peer, 'upload', remoteFileName, endedAs(transferId), bytesRef.current[transferId] ?? 0, {
        error: err instanceof Error ? err.message : String(err),
      });
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      delete bytesRef.current[transferId];
    }
  }, [logTransfer]);

  const pauseTransfer = useCallback((id: string) => {
    ExpoNativeServerModule.pauseTransfer(id);
  }, []);

  const resumeTransfer = useCallback((id: string) => {
    ExpoNativeServerModule.resumeTransfer(id);
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    if (transfersRef.current.find((t) => t.id === id)?.native) {
      ExpoNativeServerModule.cancelTransfer(id);
      return;
    }
    const task = tasksRef.current[id];
    if (task) {
      cancelledRef.current.add(id);
      try {
        task.cancel();
      } catch (err) {
        console.warn('Cancel error', err);
      }
      delete tasksRef.current[id];
      delete speedTrackerRef.current[id];

      setTransfers(prev => prev.map(t =>
        t.id === id ? { ...t, status: 'failed', speed: 0 } : t
      ));
    }
  }, []);

  return (
    <TransferContext.Provider
      value={{ transfers, startDownload, startUpload, cancelTransfer, pauseTransfer, resumeTransfer }}
    >
      {children}
    </TransferContext.Provider>
  );
}
