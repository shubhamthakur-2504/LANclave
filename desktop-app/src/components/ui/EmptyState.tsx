import { Inbox } from "lucide-react";

interface EmptyStateProps {
  message?: string;
}

export default function EmptyState({
  message = "Select an item to view details",
}: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-strong bg-surface-active">
        <Inbox className="h-8 w-8 text-content-faint" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <p className="text-sm text-content-faint">{message}</p>
    </div>
  );
}
