import { Download, File, FileText, Folder, Image, Loader2, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import type { FileEntry } from "../../types";

interface FileListPanelProps {
  files: FileEntry[];
  downloadingName?: string | null;
  onDownload?: (name: string) => void;
  onSelect?: (name: string) => void;
}

function iconForFile(file: FileEntry): ReactNode {
  if (file.is_directory) {
    return (
      <Folder className="h-5 w-5 text-warn" strokeWidth={1.75} aria-hidden="true" />
    );
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return (
        <FileText className="h-5 w-5 text-danger" strokeWidth={1.75} aria-hidden="true" />
      );
    case "mp4":
    case "mov":
      return (
        <Volume2 className="h-5 w-5 text-ok" strokeWidth={1.75} aria-hidden="true" />
      );
    case "jpeg":
    case "jpg":
    case "png":
    case "gif":
      return (
        <Image className="h-5 w-5 text-action" strokeWidth={1.75} aria-hidden="true" />
      );
    default:
      return (
        <File className="h-5 w-5 text-content-muted" strokeWidth={1.75} aria-hidden="true" />
      );
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function FileListPanel({
  files,
  downloadingName,
  onDownload,
  onSelect,
}: FileListPanelProps) {
  const sorted = [...files].sort((a, b) => {
    if (a.is_directory && !b.is_directory) return -1;
    if (!a.is_directory && b.is_directory) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-content">Files</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.map((file) => {
          const isDownloading = file.name === downloadingName;
          return (
            <div
              key={file.name}
              onClick={() => onSelect?.(file.name)}
              className={`flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors ${onSelect ? 'cursor-pointer hover:bg-surface-active' : 'hover:bg-surface-active'}`}
            >
              <span className="shrink-0">{iconForFile(file)}</span>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm text-content">{file.name}</p>
              </div>
              <span className="shrink-0 text-xs text-content-faint mr-2">
                {formatSize(file.size)}
              </span>
              {onDownload && !file.is_directory && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload(file.name);
                  }}
                  disabled={isDownloading || downloadingName !== null}
                  className="p-1.5 rounded-lg hover:bg-action/20 text-action disabled:opacity-50 transition-colors"
                  title="Download"
                >
                  {isDownloading ? (
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
