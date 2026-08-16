import { useState } from "react";
import type { TransferFilter } from "../../types";
import { useTransfers } from "../../contexts/TransferContext";
import TransferListPanel from "./TransferListPanel";

export default function TransfersPage() {
  const { transfers } = useTransfers();
  const [activeFilter, setActiveFilter] = useState<TransferFilter>("all");

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 border-r border-slate-800">
        <TransferListPanel
          transfers={transfers}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
      </div>
    </div>
  );
}
