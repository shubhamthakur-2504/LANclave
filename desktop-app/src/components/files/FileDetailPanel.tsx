import { ExternalLink, FolderOpen, Send, X } from "lucide-react";
import type { FileEntry, PeerInfo } from "../../types";
import { formatBytes } from "../../lib/stats";

interface FileDetailPanelProps {
  file: FileEntry;
  /** Paired devices that are online right now: where it can be sent. */
  sendTargets: PeerInfo[];
  onOpen: () => void;
  onReveal: () => void;
  onSend: (peer: PeerInfo) => void;
  onClose: () => void;
}

/** "PDF document", "JPG image"... from the extension; plain "File" if none. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "File";
  const ext = name.slice(dot + 1).toLowerCase();
  const groups: [string[], string][] = [
    [["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp", "svg", "avif"], "image"],
    [["mp4", "mov", "mkv", "webm", "avi", "m4v"], "video"],
    [["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"], "audio"],
    [["pdf"], "document"],
    [["doc", "docx", "odt", "rtf", "txt", "md"], "document"],
    [["xls", "xlsx", "ods", "csv"], "spreadsheet"],
    [["ppt", "pptx", "odp"], "presentation"],
    [["zip", "7z", "rar", "tar", "gz"], "archive"],
  ];
  const group = groups.find(([exts]) => exts.includes(ext))?.[1] ?? "file";
  return `${ext.toUpperCase()} ${group}`;
}

function formatDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The selected sandbox file: what it is, and what can be done with it. */
export default function FileDetailPanel({ file, sendTargets, onOpen, onReveal, onSend, onClose }: FileDetailPanelProps) {
  return (
    <div className="flex h-full flex-col" aria-label={`Details for ${file.name}`}>
      <div className="flex items-start gap-2 border-b border-border px-5 py-4">
        <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-content">{file.name}</h3>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="rounded-md p-1 text-content-faint hover:bg-surface-active hover:text-content"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <dl className="space-y-2 px-5 py-4 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-content-faint">Type</dt>
          <dd className="text-right text-content">{kindOf(file.name)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-content-faint">Size</dt>
          <dd className="text-right tabular-nums text-content">{formatBytes(file.size)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-content-faint">Modified</dt>
          <dd className="text-right text-content">{formatDate(file.modified)}</dd>
        </div>
      </dl>

      <div className="space-y-2 px-5">
        <button
          onClick={onOpen}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-action px-4 py-2 text-sm font-medium text-on-action hover:bg-action-hover"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Open
        </button>
        <button
          onClick={onReveal}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-content hover:bg-surface-active"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          Show in folder
        </button>
      </div>

      <div className="mt-5 border-t border-border px-5 py-4">
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-faint">Send to</h4>
        {sendTargets.length === 0 ? (
          <p className="text-xs text-content-faint">No paired device is online right now.</p>
        ) : (
          <ul className="space-y-1">
            {sendTargets.map((peer) => (
              <li key={peer.device_id}>
                <button
                  onClick={() => onSend(peer)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-content hover:bg-surface-active"
                >
                  <Send className="h-3.5 w-3.5 shrink-0 text-content-muted" aria-hidden="true" />
                  <span className="truncate">{peer.device_name || `${peer.device_id.slice(0, 8)}…`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
