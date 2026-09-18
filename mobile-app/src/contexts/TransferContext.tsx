import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { File, Paths, Directory } from 'expo-file-system';
import type { DownloadTask, UploadTask } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import { getAuthHeaders } from '@/services/identity';
import { getSettings } from '@/services/settings';

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
}

export interface SelectedPeer {
  ip: string;
  port: number;
  name: string;
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
      const encodedPath = fileName.split('/').map(encodeURIComponent).join('/');
      const url = `http://${peer.ip}:${peer.port}/files/${encodedPath}`;
      const headers = await getAuthHeaders();
      const settings = await getSettings();

      let destination: File;

      if (settings.sandboxPath.startsWith("content://")) {
        const createdUri = await StorageAccessFramework.createFileAsync(
          settings.sandboxPath,
          fileName,
          "application/octet-stream"
        );
        destination = new File(createdUri);
      } else {
        destination = new File(new Directory(settings.sandboxPath), fileName);
        if (destination.exists) {
          try { destination.delete(); } catch {}
        }
      }

      setTransfers(prev => prev.map(t => t.id === transferId ? { ...t, status: 'in_progress' } : t));

      const task = File.createDownloadTask(url, destination, {
        headers,
        onProgress: ({ bytesWritten, totalBytes }) => {
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
      
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      
      onComplete?.();

    } catch (err) {
      console.warn('Download failed:', err);
      setTransfers(prev => prev.map(t => 
        t.id === transferId ? { ...t, status: 'failed', speed: 0 } : t
      ));
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
    }
  }, []);

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
      await task.uploadAsync();

      setTransfers(prev => prev.map(t => 
        t.id === transferId 
          ? { ...t, status: 'completed', speed: 0, progress: t.fileSize } 
          : t
      ));
      
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
      
      onComplete?.();

    } catch (err) {
      console.warn('Upload failed:', err);
      setTransfers(prev => prev.map(t => 
        t.id === transferId ? { ...t, status: 'failed', speed: 0 } : t
      ));
      delete tasksRef.current[transferId];
      delete speedTrackerRef.current[transferId];
    }
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    const task = tasksRef.current[id];
    if (task) {
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
