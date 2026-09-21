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
  onNavigate,
  serverRunning,
  onStartServer,
  onStopServer,
  serverBusy,
}: SidebarProps) {
  return (
    <aside className="flex w-56 flex-col border-r border-border bg-surface-raised">
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = activePage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-action/10 text-action"
                  : "text-content-muted hover:bg-surface-active hover:text-content"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 h-5 w-0.5 rounded-r bg-action" />
              )}
              <item.icon
                className="h-5 w-5"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              {item.label}
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
            className="flex w-full items-center gap-3 rounded-lg border border-danger-border px-3 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
          >
            <Power className="h-4 w-4" aria-hidden="true" />
            Stop Server
          </button>
        ) : (
          <button
            onClick={onStartServer}
            disabled={serverBusy}
            className="flex w-full items-center gap-3 rounded-lg border border-ok-border px-3 py-2.5 text-sm font-medium text-ok transition-colors hover:bg-ok-bg disabled:opacity-40"
          >
            <Power className="h-4 w-4" aria-hidden="true" />
            Start Server
          </button>
        )}
      </div>
    </aside>
  );
}
