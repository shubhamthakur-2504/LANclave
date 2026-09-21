import { FolderOpen, Inbox, Search, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Empty states (U4.3).
 *
 * One generic "Select an item" with an eye icon used to serve every case.
 * "No peers found", "sandbox is empty" and "no transfers yet" are three
 * different situations with three different next steps, so each gets its own
 * icon, sentence and action.
 */
export type EmptyKind = "peers" | "files" | "transfers" | "generic";

const PRESETS: Record<
  EmptyKind,
  { icon: LucideIcon; title: string; hint?: string }
> = {
  peers: {
    icon: Users,
    title: "No devices found yet",
    hint: "Check both devices are on the same Wi-Fi or hotspot and have their server running, then scan.",
  },
  files: {
    icon: FolderOpen,
    title: "Your sandbox is empty",
    hint: "Drop files here, or add them, to make them available to paired devices.",
  },
  transfers: {
    icon: Inbox,
    title: "Nothing transferred yet",
    hint: "Send a file to a peer, or open a peer's sandbox to pull one.",
  },
  generic: {
    icon: Search,
    title: "Select an item to view details",
  },
};

interface EmptyStateProps {
  kind?: EmptyKind;
  /** Overrides the preset title. */
  message?: string;
  hint?: string;
  /** A primary action, e.g. Scan or Add files. */
  action?: ReactNode;
}

export default function EmptyState({
  kind = "generic",
  message,
  hint,
  action,
}: EmptyStateProps) {
  const preset = PRESETS[kind];
  const Icon = preset.icon;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-strong bg-surface-active">
        <Icon
          className="h-8 w-8 text-content-faint"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>
      <p className="text-sm font-medium text-content">
        {message ?? preset.title}
      </p>
      {(hint ?? preset.hint) && (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-content-faint">
          {hint ?? preset.hint}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
