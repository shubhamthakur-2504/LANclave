import { useEffect, useState } from "react";
import type { PeerInfo, FileEntry } from "../../types";
import * as api from "../../api";
import FileListPanel from "./FileListPanel";
import { useTransfers } from "../../contexts/TransferContext";

interface RemoteFilesPageProps {
  peer: PeerInfo;
  onBack: () => void;
  onFileDownloaded: () => void;
}

export default function RemoteFilesPage({ peer, onBack, onFileDownloaded }: RemoteFilesPageProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { startDownload } = useTransfers();
  // We no longer track downloadingName locally since transfers are backgrounded globally
  const [downloadingName, setDownloadingName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const fetchFiles = async () => {
      try {
        setLoading(true);
        setError(null);
        const fetched = await api.listPeerFiles(peer.addr);
        if (active) setFiles(fetched);
      } catch (err) {
        if (active) setError(String(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchFiles();
    return () => { active = false; };
  }, [peer.addr]);

  const handleDownload = async (name: string) => {
    const file = files.find(f => f.name === name);
    if (!file) return;
    
    setDownloadingName(name); // just for brief UI feedback
    setError(null);
    try {
      await startDownload(peer, file);
      onFileDownloaded(); // this just refreshes local sandbox view
    } catch (err) {
      setError(`Failed to start download: ${err}`);
    } finally {
      setTimeout(() => setDownloadingName(null), 500); // clear after half second
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong bg-surface-active text-content transition-colors hover:bg-border-strong"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="truncate text-lg font-semibold text-content">
            Browsing {peer.device_name || `${peer.device_id.slice(0, 10)}...`}
          </h2>
          <p className="truncate text-xs text-content-muted">{peer.addr}</p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
            api.listPeerFiles(peer.addr).then(setFiles).catch((err) => setError(String(err))).finally(() => setLoading(false));
          }}
          className="shrink-0 flex h-8 items-center gap-2 rounded-lg border border-border-strong bg-surface-active px-3 text-xs font-medium text-content transition-colors hover:bg-border-strong"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          Refresh
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger flex items-center justify-between">
          <span>{error}</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-content-faint">
            Loading files...
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-content-faint">
            No files found on remote device.
          </div>
        ) : (
          <FileListPanel
            files={files}
            downloadingName={downloadingName}
            onDownload={handleDownload}
          />
        )}
      </div>
    </div>
  );
}
