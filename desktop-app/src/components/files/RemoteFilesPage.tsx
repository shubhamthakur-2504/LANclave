import { useEffect, useState } from "react";
import type { PeerInfo, FileEntry } from "../../types";
import * as api from "../../api";
import FileListPanel from "./FileListPanel";
import EmptyState from "../ui/EmptyState";

interface RemoteFilesPageProps {
  peer: PeerInfo;
  onBack: () => void;
  onFileDownloaded: () => void;
}

export default function RemoteFilesPage({ peer, onBack, onFileDownloaded }: RemoteFilesPageProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [downloading, setDownloading] = useState(false);

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

  const handleDownload = async () => {
    if (!selectedFile) return;
    setDownloading(true);
    setError(null);
    try {
      await api.pullFile(peer.addr, selectedFile.name, selectedFile.name);
      onFileDownloaded();
      // Temporarily show success (or rely on the user seeing it in the local files)
    } catch (err) {
      setError(`Download failed: ${err}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/50 px-6 py-4">
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 transition-colors hover:bg-slate-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Browsing {peer.device_id.slice(0, 10)}...
          </h2>
          <p className="text-xs text-slate-400">{peer.addr}</p>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-lg bg-red-950/50 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-96 shrink-0 border-r border-slate-800">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Loading files...
            </div>
          ) : (
            <FileListPanel
              files={files}
              selectedName={selectedFile?.name ?? null}
              onSelect={(name) => {
                const f = files.find((x) => x.name === name) ?? null;
                setSelectedFile(f);
              }}
            />
          )}
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          {selectedFile ? (
            <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-800 text-slate-400 mx-auto">
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              </div>
              <h3 className="mb-1 text-base font-semibold text-slate-100">{selectedFile.name}</h3>
              <p className="mb-6 text-sm text-slate-400">
                {(selectedFile.size / 1024).toFixed(1)} KB
              </p>
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="w-full rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
              >
                {downloading ? "Downloading..." : "Download to Local Sandbox"}
              </button>
            </div>
          ) : (
            <EmptyState message="Select a remote file to download" />
          )}
        </div>
      </div>
    </div>
  );
}
