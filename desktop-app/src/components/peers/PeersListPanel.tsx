import { useState } from "react";
import type { PeerInfo } from "../../types";

interface PeersListPanelProps {
  peers: PeerInfo[];
  onConnect: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
  onRescanPeer?: (peer: PeerInfo) => void;
}

function shortId(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 8)}…`;
}

function PeerRow({
  peer,
  onConnect,
  onBrowseFiles,
  onRescan,
}: {
  peer: PeerInfo;
  onConnect: () => void;
  onBrowseFiles: (() => void) | undefined;
  onRescan?: () => Promise<void> | void;
}) {
  const isOnline = peer.addr !== "";
  const [retrying, setRetrying] = useState(false);

  const handleRescan = async () => {
    if (!onRescan || retrying) return;
    setRetrying(true);
    try {
      await onRescan();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="flex w-full items-center gap-3 border-b border-border px-5 py-3 text-left transition-colors hover:bg-surface-active">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-action/20 text-sm font-semibold text-action">
        {shortId(peer.device_id)[0].toUpperCase()}
        {/* Online dot */}
        <span
          className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-border ${
            isOnline ? "bg-ok" : "bg-content-faint"
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-content">
            {peer.device_name || `${peer.device_id.substring(0, 8)}...`}
          </span>
          {peer.paired && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok">
              Paired
            </span>
          )}
        </div>
        <p className="truncate text-xs text-content-faint">
          {peer.addr || "Offline / unreachable"}
        </p>
      </div>
      
      {/* Actions */}
      <div className="shrink-0 flex gap-2">
        {peer.paired && !isOnline && onRescan && (
          <button
            onClick={handleRescan}
            disabled={retrying}
            className="rounded-lg border border-border-strong bg-surface-active px-3 py-1.5 text-xs font-medium text-content transition-colors hover:bg-border-strong disabled:opacity-50"
          >
            {retrying ? "Finding..." : "Retry"}
          </button>
        )}
        {peer.paired ? (
          <button
            onClick={onBrowseFiles}
            disabled={!isOnline}
            className="rounded-lg bg-action px-4 py-1.5 text-xs font-medium text-on-action transition-colors hover:bg-action-hover disabled:opacity-50"
          >
            Browse Files
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={!isOnline}
            className="rounded-lg border border-border-strong bg-surface-active px-4 py-1.5 text-xs font-medium text-content transition-colors hover:bg-border-strong disabled:opacity-50"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

export default function PeersListPanel({
  peers,
  onConnect,
  onBrowseFiles,
  onRescanPeer,
}: PeersListPanelProps) {
  const paired = peers.filter((p) => p.paired);
  const nearby = peers.filter((p) => !p.paired);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* ── Paired Devices ── */}
        {paired.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1 border-b border-border">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-ok">
                Paired Devices
              </span>
            </div>
            {paired.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                onConnect={() => onConnect(peer)}
                onBrowseFiles={() => onBrowseFiles?.(peer)}
                onRescan={onRescanPeer ? () => onRescanPeer(peer) : undefined}
              />
            ))}
          </>
        )}

        {/* ── Nearby (unpaired) ── */}
        {nearby.length > 0 && (
          <>
            <div className="px-5 pt-4 pb-1 border-b border-border mt-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-action">
                Nearby (unpaired)
              </span>
            </div>
            {nearby.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                onConnect={() => onConnect(peer)}
                onBrowseFiles={() => onBrowseFiles?.(peer)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
