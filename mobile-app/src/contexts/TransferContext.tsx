import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { File, Directory } from 'expo-file-system';
import type { DownloadTask, UploadTask } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import { getAuthHeaders } from '@/services/identity';
import { getSettings } from '@/services/settings';
import { localCopyOf, numberedName, peerCopyOf } from '@/services/dedupe';
import { peerIdForAddress, recordTransfer, type HistoryOutcome } from '@/services/history';

export type TransferStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
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
}

const TransferContext = createContext<TransferContextState | null>(null);

export const useTransfers = () => {
  const ctx = useContext(TransferContext);
  if (!ctx) throw new Error('useTransfers must be used within TransferProvider');
  return ctx;
};

export function TransferProvider({ children }: { children: React.ReactNode }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  // Track Expo FileSystem DownloadTasks and UploadTasks
  const tasksRef = useRef<Record<string, DownloadTask | UploadTask>>({});
  // Track speed calculations
  const speedTrackerRef = useRef<Record<string, { lastBytes: number; lastTime: number }>>({});
  // Latest byte count per transfer, so a failure can be logged with how far it got.
  const bytesRef = useRef<Record<string, number>>({});
  // Ids the user cancelled: their rejection is logged as cancelled, not failed.
  const cancelledRef = useRef<Set<string>>(new Set());

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

  const cancelTransfer = useCallback(async (id: string) => {
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
    <TransferContext.Provider value={{ transfers, startDownload, startUpload, cancelTransfer }}>
      {children}
    </TransferContext.Provider>
  );
}
