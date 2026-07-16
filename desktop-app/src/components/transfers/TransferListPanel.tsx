import type React from "react";
import type { ReactNode } from "react";
import type { Transfer, TransferFilter } from "../../types";

interface TransferListPanelProps {
  transfers: Transfer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  activeFilter: TransferFilter;
  onFilterChange: (filter: TransferFilter) => void;
}

const filters: { key: TransferFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function iconForTransfer(direction: "upload" | "download"): ReactNode {
  return (
    <svg className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      {direction === "upload" ? (
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 12 12 16.5m0 0L16.5 12M12 16.5V3" />
      )}
    </svg>
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

function statusBadge(status: Transfer["status"]): React.ReactNode {
  switch (status) {
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          Done
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-400/10 px-2 py-0.5 text-[11px] font-medium text-red-400">
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Failed
        </span>
      );
    case "in_progress":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-400">
          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
          </svg>
          Active
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-400/10 px-2 py-0.5 text-[11px] font-medium text-slate-400">
          Pending
        </span>
      );
  }
}

export default function TransferListPanel({
  transfers,
  selectedId,
  onSelect,
  activeFilter,
  onFilterChange,
}: TransferListPanelProps) {
  const filtered =
    activeFilter === "all"
      ? transfers
      : activeFilter === "active"
        ? transfers.filter((t) => t.status === "in_progress" || t.status === "pending")
        : transfers.filter((t) => t.status === activeFilter);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-200">Transfers</h2>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-4 border-b border-slate-800 px-5 py-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => onFilterChange(f.key)}
            className={`text-xs font-medium transition-colors ${
              activeFilter === f.key
                ? "text-sky-400"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Transfer list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-600">
            No transfers
          </div>
        ) : (
          filtered.map((t) => {
            const isSelected = t.id === selectedId;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={`flex w-full items-center gap-3 border-b border-slate-800/50 px-5 py-3 text-left transition-colors ${
                  isSelected ? "bg-sky-500/10" : "hover:bg-slate-800/30"
                }`}
              >
                <span className="shrink-0">{iconForTransfer(t.direction)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-200">
                      {t.fileName}
                    </span>
                    {statusBadge(t.status)}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {t.direction === "upload" ? "To" : "From"} {t.peerName}
                    {" · "}
                    {formatSize(t.fileSize)}
                    {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
                  </p>
                  {(t.status === "in_progress" || t.status === "pending") && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-700">
                      <div
                        className="h-full rounded-full bg-sky-400 transition-all duration-300"
                        style={{ width: `${t.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
