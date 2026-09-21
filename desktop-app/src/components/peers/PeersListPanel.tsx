import { useState } from "react";
import { HelpCircle, Laptop, Smartphone, Tablet } from "lucide-react";
import { colorForDevice, deviceKind, initialForDevice } from "../../lib/identity";
import { useTransfers } from "../../contexts/TransferContext";
import type { PeerInfo, Transfer } from "../../types";

interface PeersListPanelProps {
  peers: PeerInfo[];
  onConnect: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
  onRescanPeer?: (peer: PeerInfo) => void;
  /** device_id of the row files are currently hovering over. */
  dropTargetId?: string | null;
}

const KIND_ICONS = {
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  unknown: HelpCircle,
} as const;

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

/**
 * Live throughput for a peer, shown on its row.
 *
 * This is the moment the app feels fast, and it used to be hidden on another
 * tab (U2.1).
 */
function PeerActivity({ transfers }: { transfers: Transfer[] }) {
  const totalBytes = transfers.reduce((n, t) => n + t.fileSize, 0);
  const moved = transfers.reduce((n, t) => n + t.progress, 0);
  const speed = transfers.reduce((n, t) => n + t.speed, 0);
  const pct = totalBytes > 0 ? Math.min(100, (moved / totalBytes) * 100) : 0;

  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between text-[11px] text-content-muted">
        <span>
          {transfers.length} transfer{transfers.length > 1 ? "s" : ""}
        </span>
        <span className="tabular-nums">{formatSpeed(speed)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-inset">
        <div
          className="h-full rounded-full bg-action transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PeerRow({
  peer,
  activity,
  isDropTarget,
  onConnect,
  onBrowseFiles,
  onRescan,
}: {
  peer: PeerInfo;
  activity: Transfer[];
  isDropTarget: boolean;
  onConnect: () => void;
  onBrowseFiles: (() => void) | undefined;
  onRescan?: () => Promise<void> | void;
}) {
  const isOnline = peer.addr !== "";
  const [retrying, setRetrying] = useState(false);

  // Identity: name initial where there is one, device glyph otherwise, and a
  // colour derived from the device id so a peer looks the same every time.
  const initial = initialForDevice(peer.device_name);
  const identityColor = colorForDevice(peer.device_id);
  const KindIcon = KIND_ICONS[deviceKind(peer.device_type, peer.device_name)];

  const handleRescan = async () => {
    if (!onRescan || retrying) return;
    setRetrying(true);
    try {
      await onRescan();
    } finally {
      setRetrying(false);
    }
  };

  // The row itself is the primary target — opening the peer's sandbox is what
  // people came to do. Actions are secondary and sit to the right.
  const canOpen = peer.paired && isOnline && !!onBrowseFiles;
  const primary = canOpen ? onBrowseFiles : undefined;

  return (
    <div
      // Hit-tested by the window-level drop handler (U3.1).
      data-peer-id={peer.paired && isOnline ? peer.device_id : undefined}
      role={primary ? "button" : undefined}
      tabIndex={primary ? 0 : undefined}
      onClick={primary}
      onKeyDown={(e) => {
        if (!primary) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          primary();
        }
      }}
      aria-label={
        primary ? `Open ${peer.device_name || "peer"}'s files` : undefined
      }
      className={`flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors ${
        primary ? "cursor-pointer hover:bg-surface-active" : ""
      } ${isOnline ? "" : "opacity-60"} ${
        isDropTarget ? "bg-action/10 ring-1 ring-inset ring-action" : ""
      }`}
    >
      <div
        className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        style={{ backgroundColor: `${identityColor}22`, color: identityColor }}
      >
        {initial ?? (
          <KindIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        )}
        <span
          className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface-raised ${
            isOnline ? "bg-ok" : "bg-content-faint"
          }`}
          aria-hidden="true"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-content">
            {peer.device_name || `${peer.device_id.substring(0, 8)}…`}
          </span>
          {!isOnline && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-content-faint">
              Offline
            </span>
          )}
        </div>

        {activity.length > 0 ? (
          <PeerActivity transfers={activity} />
        ) : (
          <p className="truncate text-xs text-content-faint">
            {peer.addr || "Not reachable right now"}
          </p>
        )}
      </div>

      <div
        className="flex shrink-0 gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {peer.paired && !isOnline && onRescan && (
          <button
            onClick={handleRescan}
            disabled={retrying}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-content transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            {retrying ? "Finding…" : "Retry"}
          </button>
        )}
        {!peer.paired && (
          <button
            onClick={onConnect}
            disabled={!isOnline}
            className="rounded-lg bg-action px-4 py-1.5 text-xs font-medium text-on-action transition-colors hover:bg-action-hover disabled:opacity-50"
          >
            Pair
          </button>
        )}
      </div>
    </div>
  );
}

function SectionHeading({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "ok" | "action";
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2">
      <span
        className={`text-[10px] font-semibold uppercase tracking-widest ${
          tone === "ok" ? "text-ok" : "text-content-faint"
        }`}
      >
        {label}
      </span>
      <span className="text-[10px] text-content-faint">{count}</span>
    </div>
  );
}

export default function PeersListPanel({
  peers,
  onConnect,
  onBrowseFiles,
  onRescanPeer,
  dropTargetId = null,
}: PeersListPanelProps) {
  const { transfers } = useTransfers();

  // Three states, weighted differently on purpose: a paired device that is
  // here right now is not the same thing as one that is merely remembered.
  const online = peers.filter((p) => p.paired && p.addr !== "");
  const offline = peers.filter((p) => p.paired && p.addr === "");
  const nearby = peers.filter((p) => !p.paired);

  const activityFor = (peer: PeerInfo) =>
    transfers.filter(
      (t) => t.status === "in_progress" && t.peerId === peer.device_id,
    );

  const rows = (list: PeerInfo[]) =>
    list.map((peer) => (
      <PeerRow
        key={peer.device_id}
        peer={peer}
        activity={activityFor(peer)}
        isDropTarget={dropTargetId === peer.device_id}
        onConnect={() => onConnect(peer)}
        onBrowseFiles={onBrowseFiles ? () => onBrowseFiles(peer) : undefined}
        onRescan={onRescanPeer ? () => onRescanPeer(peer) : undefined}
      />
    ));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {online.length > 0 && (
          <>
            <SectionHeading label="Available now" count={online.length} tone="ok" />
            {rows(online)}
          </>
        )}

        {nearby.length > 0 && (
          <>
            <SectionHeading label="Nearby — not paired" count={nearby.length} tone="action" />
            {rows(nearby)}
          </>
        )}

        {offline.length > 0 && (
          <>
            <SectionHeading label="Paired — offline" count={offline.length} tone="action" />
            {rows(offline)}
          </>
        )}
      </div>
    </div>
  );
}
