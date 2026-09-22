import {
  ArrowLeftRight,
  FolderOpen,
  Power,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PageType } from "../../types";

interface SidebarProps {
  activePage: PageType;
  /** In-flight transfers. Badged so movement is visible without opening the page. */
  activeTransfers: number;
  onNavigate: (page: PageType) => void;
  serverRunning: boolean;
  onStartServer: () => void;
  onStopServer: () => void;
  serverBusy: boolean;
}

const navItems: { id: PageType; label: string; icon: LucideIcon }[] = [
  { id: "peers", label: "Peers", icon: Users },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "transfers", label: "Transfers", icon: ArrowLeftRight },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function Sidebar({
  activePage,
  activeTransfers,
  onNavigate,
  serverRunning,
  onStartServer,
  onStopServer,
  serverBusy,
}: SidebarProps) {
  // Below the `lg` breakpoint the master-detail layout has no room for
  // labels, so the sidebar collapses to icons rather than squeezing the
  // content pane (U4.2).
  return (
    <aside className="flex w-14 flex-col border-r border-border bg-surface-raised lg:w-56">
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = activePage === item.id;
          const badge = item.id === "transfers" ? activeTransfers : 0;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              title={item.label}
              aria-label={
                badge > 0
                  ? `${item.label}, ${badge} in progress`
                  : item.label
              }
              className={`relative flex w-full items-center justify-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:justify-start ${
                isActive
                  ? "bg-action/10 text-action"
                  : "text-content-muted hover:bg-surface-active hover:text-content"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 h-5 w-0.5 rounded-r bg-action" />
              )}
              <span className="relative shrink-0">
                <item.icon
                  className="h-5 w-5"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                {badge > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action px-1 text-[10px] font-bold leading-none text-on-action">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </span>
              <span className="hidden lg:inline">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Server toggle */}
      <div className="border-t border-border px-3 py-3">
        {serverRunning ? (
          <button
            onClick={onStopServer}
            disabled={serverBusy}
            title="Stop Server"
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-danger-border px-3 py-2.5 lg:justify-start text-sm font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
          >
            <Power className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">Stop Server</span>
          </button>
        ) : (
          <button
            onClick={onStartServer}
            disabled={serverBusy}
            title="Start Server"
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-ok-border px-3 py-2.5 lg:justify-start text-sm font-medium text-ok transition-colors hover:bg-ok-bg disabled:opacity-40"
          >
            <Power className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline">Start Server</span>
          </button>
        )}
      </div>
    </aside>
  );
}
