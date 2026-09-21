import { Check, ChevronDown, Download, Loader2, Upload, X } from "lucide-react";
import { useState } from "react";
import type React from "react";
import type { ReactNode } from "react";
import type { Transfer, TransferFilter } from "../../types";
import { useTransfers } from "../../contexts/TransferContext";

interface TransferListPanelProps {
  transfers: Transfer[];
  activeFilter: TransferFilter;
  onFilterChange: (filter: TransferFilter) => void;
}

const filters: { key: TransferFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

/**
 * Direction is carried by both the glyph and its colour, so up and down are
 * distinguishable at a glance rather than by reading the label (U2.2).
 */
function iconForTransfer(direction: "upload" | "download"): ReactNode {
  return direction === "upload" ? (
    <Upload className="h-5 w-5 text-action" strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <Download className="h-5 w-5 text-ok" strokeWidth={1.75} aria-hidden="true" />
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "";
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function calcEta(transfer: Transfer): string {
  if (transfer.status !== "in_progress" || transfer.speed === 0) return "—";
  const remaining = transfer.fileSize - transfer.progress;
  if (remaining <= 0) return "Almost done";
  const seconds = remaining / transfer.speed;
  if (seconds < 60) return `~${Math.round(seconds)}s remaining`;
  return `~${Math.round(seconds / 60)}m remaining`;
}

function statusBadge(status: Transfer["status"]): React.ReactNode {
  switch (status) {
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">
          <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Done
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
          <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Failed
        </span>
      );
    case "in_progress":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-action/10 px-2 py-0.5 text-[11px] font-medium text-action">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Active
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-content-muted/10 px-2 py-0.5 text-[11px] font-medium text-content-muted">
          Pending
        </span>
      );
  }
}

export default function TransferListPanel({
  transfers,
  activeFilter,
  onFilterChange,
}: TransferListPanelProps) {
  const { cancelTransfer } = useTransfers();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered =
    activeFilter === "all"
      ? transfers
      : activeFilter === "active"
        ? transfers.filter((t) => t.status === "in_progress" || t.status === "pending")
        : transfers.filter((t) => t.status === activeFilter);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-content">Transfers</h2>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-4 border-b border-border px-5 py-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => onFilterChange(f.key)}
            className={`text-xs font-medium transition-colors ${
              activeFilter === f.key
                ? "text-action"
                : "text-content-faint hover:text-content"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Transfer list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-content-faint">
            No transfers
          </div>
        ) : (
          filtered.map((t) => {
            const isExpanded = t.id === expandedId;
            const percent = t.fileSize > 0 ? Math.round((t.progress / t.fileSize) * 100) : 0;
            
            return (
              <div 
                key={t.id}
                className="rounded-xl border border-border bg-surface-raised overflow-hidden transition-colors hover:border-border-strong"
              >
                {/* Header row (clickable) */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : t.id)}
                  className="flex w-full items-center gap-4 p-4 text-left focus:outline-none"
                >
                  <span className="shrink-0">{iconForTransfer(t.direction)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-content">
                        {t.fileName}
                      </span>
                      {statusBadge(t.status)}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-content-faint">
                      <span className="truncate">
                        {t.direction === "upload" ? "To" : "From"} {t.peerName.length > 20 ? `${t.peerName.substring(0, 8)}...` : t.peerName}
                      </span>
                      <span className="shrink-0 pl-2">
                        {formatSize(t.fileSize)}
                        {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
                      </span>
                    </div>
                    
                    {(t.status === "in_progress" || t.status === "pending") && (
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-active">
                        <div
                          className="h-full rounded-full bg-action transition-all duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    )}
                  </div>
                  
                  {/* Expand icon */}
                  <div className="shrink-0 text-content-faint pl-2">
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </div>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-border bg-surface-raised px-4 py-3">
                    <div className="grid grid-cols-2 gap-y-2 text-xs">
                      <div className="text-content-faint">Speed</div>
                      <div className="text-content text-right">{formatSpeed(t.speed) || "—"}</div>
                      
                      <div className="text-content-faint">Time Remaining</div>
                      <div className="text-content text-right">{calcEta(t)}</div>
                      
                      <div className="text-content-faint">Started</div>
                      <div className="text-content text-right">{formatTime(t.startedAt)}</div>
                    </div>
                    
                    {/* Actions */}
                    <div className="mt-4 flex gap-2">
                      {t.status === "in_progress" && (
                        <>
                          <button disabled className="flex-1 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-content-faint transition-colors opacity-50 cursor-not-allowed" title="Pause requires HTTP Range support">
                            Pause
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); cancelTransfer(t.id); }}
                            className="flex-1 rounded-lg border border-danger-border px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger-bg"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                      {t.status === "completed" && (
                        <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-action/10 border border-action/20 px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action/20">
                          Open File Location
                        </button>
                      )}
                      {t.status === "failed" && (
                        <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-content transition-colors hover:bg-surface-active">
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
