import { ArrowDown, ArrowUp, Download, Loader2 } from "lucide-react";
import FileIcon from "./FileIcon";
import { useState } from "react";
import type { FileEntry } from "../../types";
import { loadSort, nextSort, saveSort, sortFiles, type SortKey, type SortState } from "../../lib/sortFiles";

const SORT_KEYS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date" },
  { key: "size", label: "Size" },
  { key: "type", label: "Type" },
];

function formatDate(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear()
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface FileListPanelProps {
  files: FileEntry[];
  downloadingName?: string | null;
  onDownload?: (name: string) => void;
  onSelect?: (name: string) => void;
  /** Open with the default app: double-click or Enter. */
  onOpen?: (name: string) => void;
  selectedName?: string | null;
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
  onOpen,
  selectedName = null,
}: FileListPanelProps) {
  const [sort, setSort] = useState<SortState>(loadSort);
  const sorted = sortFiles(files, sort);

  const chooseSort = (key: SortKey) => {
    const next = nextSort(sort, key);
    setSort(next);
    saveSort(next);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-content">Files</h2>
        <div className="flex items-center gap-1" role="group" aria-label="Sort files by">
          {SORT_KEYS.map(({ key, label }) => {
            const active = sort.key === key;
            const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
            return (
              <button
                key={key}
                onClick={() => chooseSort(key)}
                aria-pressed={active}
                title={active ? `Sorted by ${label.toLowerCase()}, click to reverse` : `Sort by ${label.toLowerCase()}`}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-action/10 text-action"
                    : "text-content-faint hover:bg-surface-active hover:text-content"
                }`}
              >
                {label}
                {active && <Arrow className="h-3 w-3" aria-label={sort.dir === "asc" ? "ascending" : "descending"} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.map((file) => {
          const isDownloading = file.name === downloadingName;
          return (
            <div
              key={file.name}
              onClick={() => onSelect?.(file.name)}
              onDoubleClick={() => !file.is_directory && onOpen?.(file.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !file.is_directory) onOpen?.(file.name);
                if (e.key === " ") {
                  e.preventDefault();
                  onSelect?.(file.name);
                }
              }}
              tabIndex={onSelect || onOpen ? 0 : undefined}
              role={onSelect ? "option" : undefined}
              aria-selected={onSelect ? file.name === selectedName : undefined}
              className={`flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action ${
                file.name === selectedName ? "bg-action/10" : ""
              } ${onSelect ? 'cursor-pointer hover:bg-surface-active' : 'hover:bg-surface-active'}`}
            >
              <FileIcon name={file.name} isDirectory={file.is_directory} />
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm text-content">{file.name}</p>
              </div>
              <span className="hidden w-24 shrink-0 text-right text-xs text-content-faint md:inline">
                {formatDate(file.modified)}
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-content-faint mr-2">
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
