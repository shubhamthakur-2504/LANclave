import { ChevronLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { PeerInfo, FileEntry } from "../../types";
import * as api from "../../api";
import FileListPanel from "./FileListPanel";
import { useTransfers } from "../../contexts/TransferContext";

interface RemoteFilesPageProps {
  peer: PeerInfo;
  /** Files are being dragged over the window: a drop here goes to this peer. */
  isDropping?: boolean;
  onBack: () => void;
  onFileDownloaded: () => void;
}

export default function RemoteFilesPage({ peer, isDropping = false, onBack, onFileDownloaded }: RemoteFilesPageProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  /** Where we are in the peer's sandbox: `a/b`, or empty for the top. */
  const [folder, setFolder] = useState("");
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
        const fetched = await api.listPeerFiles(peer.addr, folder);
        if (active) setFiles(fetched);
      } catch (err) {
        if (active) setError(String(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchFiles();
    return () => { active = false; };
  }, [peer.addr, folder]);

  const handleDownload = async (name: string) => {
    const file = files.find(f => f.name === name);
    if (!file) return;
    
    setDownloadingName(name); // just for brief UI feedback
    setError(null);
    try {
      await startDownload(peer, file, folder);
      onFileDownloaded(); // this just refreshes local sandbox view
    } catch (err) {
      setError(`Failed to start download: ${err}`);
    } finally {
      setTimeout(() => setDownloadingName(null), 500); // clear after half second
    }
  };

  const who = peer.device_name || `${peer.device_id.slice(0, 10)}...`;
  const crumbs = folder ? folder.split("/") : [];
  const openFolder = (name: string) => setFolder(folder ? `${folder}/${name}` : name);

  return (
    <div className={`flex h-full flex-col ${isDropping ? "ring-2 ring-inset ring-action" : ""}`}>
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong bg-surface-active text-content transition-colors hover:bg-border-strong"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="truncate text-lg font-semibold text-content">
            Browsing {who}
          </h2>
          {/* Where in its sandbox we are; each step is a way back up. */}
          <nav className="flex min-w-0 items-center gap-1 truncate text-xs text-content-muted" aria-label="Folder">
            <button onClick={() => setFolder("")} className="shrink-0 hover:text-content hover:underline">
              Sandbox
            </button>
            {crumbs.map((name, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true">/</span>
                <button
                  onClick={() => setFolder(crumbs.slice(0, i + 1).join("/"))}
                  className="truncate hover:text-content hover:underline"
                >
                  {name}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
            api.listPeerFiles(peer.addr, folder).then(setFiles).catch((err) => setError(String(err))).finally(() => setLoading(false));
          }}
          className="shrink-0 flex h-8 items-center gap-2 rounded-lg border border-border-strong bg-surface-active px-3 text-xs font-medium text-content transition-colors hover:bg-border-strong"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
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
        {isDropping ? (
          // Say where the files will go before they are let go: with this
          // device's files open, a drop sends to it, not to the local sandbox.
          <div className="flex h-full items-center justify-center text-sm text-action">
            Drop files to send them to {who}
          </div>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-sm text-content-faint">
            Loading files...
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-content-faint">
            {folder ? "This folder is empty." : "No files found on remote device."}
          </div>
        ) : (
          <FileListPanel
            files={files}
            downloadingName={downloadingName}
            onDownload={handleDownload}
            onOpenFolder={openFolder}
          />
        )}
      </div>
    </div>
  );
}
