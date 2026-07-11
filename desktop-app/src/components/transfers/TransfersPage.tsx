import { useState } from "react";
import type { Transfer, TransferFilter } from "../../mockdata";
import TransferListPanel from "./TransferListPanel";
import TransferDetailPanel from "./TransferDetailPanel";
import EmptyState from "../ui/EmptyState";

interface TransfersPageProps {
  transfers: Transfer[];
}

export default function TransfersPage({ transfers }: TransfersPageProps) {
  const [selectedTransferId, setSelectedTransferId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<TransferFilter>("all");
  const selected = transfers.find((t) => t.id === selectedTransferId) ?? null;

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 border-r border-slate-800">
        <TransferListPanel
          transfers={transfers}
          selectedId={selectedTransferId}
          onSelect={setSelectedTransferId}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
      </div>
      <div className="flex-1">
        {selected ? (
          <TransferDetailPanel transfer={selected} />
        ) : (
          <EmptyState message="Select a transfer to view details" />
        )}
      </div>
    </div>
  );
}
