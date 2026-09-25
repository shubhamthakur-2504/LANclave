import { useState } from "react";
import type { TransferFilter } from "../../types";
import { useTransfers } from "../../contexts/TransferContext";
import TransferListPanel from "./TransferListPanel";
import HistoryPanel from "./HistoryPanel";
import OffersSection from "../offers/OffersSection";

type View = "activity" | "history";

export default function TransfersPage() {
  const { transfers } = useTransfers();
  const [activeFilter, setActiveFilter] = useState<TransferFilter>("all");
  // "Activity" is this session's live transfers; "History" is the 30-day log.
  const [view, setView] = useState<View>("activity");

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex gap-1 border-b border-border px-4 pt-3">
        {(
          [
            ["activity", "Activity"],
            ["history", "History"],
          ] as [View, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`-mb-px border-b-2 px-3 pb-2 text-sm font-medium transition-colors ${
              view === key
                ? "border-action text-action"
                : "border-transparent text-content-muted hover:text-content"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === "activity" ? (
          <div className="flex h-full flex-col">
            <OffersSection />
            <div className="min-h-0 flex-1">
              <TransferListPanel
                transfers={transfers}
                activeFilter={activeFilter}
                onFilterChange={setActiveFilter}
              />
            </div>
          </div>
        ) : (
          <HistoryPanel />
        )}
      </div>
    </div>
  );
}
