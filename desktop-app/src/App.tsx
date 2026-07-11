import { useState } from "react";
import type { PageType } from "./mockdata";
import {
  mockPeers,
  mockFiles,
  mockTransfers,
  mockConnectionRequest,
} from "./mockdata";
import Header from "./components/layout/Header";
import Sidebar from "./components/layout/Sidebar";
import PeersPage from "./components/peers/PeersPage";
import FilesPage from "./components/files/FilesPage";
import TransfersPage from "./components/transfers/TransfersPage";
import ConnectionModal from "./components/connection/ConnectionModal";
import "./App.css";

export default function App() {
  const [activePage, setActivePage] = useState<PageType>("peers");
  const [connectionOpen, setConnectionOpen] = useState(false);

  const pageContent = (() => {
    switch (activePage) {
      case "peers":
        return (
          <PeersPage
            peers={mockPeers}
            onOpenConnection={() => setConnectionOpen(true)}
          />
        );
      case "files":
        return <FilesPage files={mockFiles} />;
      case "transfers":
        return <TransfersPage transfers={mockTransfers} />;
    }
  })();

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activePage={activePage}
          onNavigate={setActivePage}
          onOpenConnection={() => setConnectionOpen(true)}
        />
        <main className="flex-1 overflow-hidden">{pageContent}</main>
      </div>
      <ConnectionModal
        isOpen={connectionOpen}
        peerName={mockConnectionRequest.peerName}
        deviceName={mockConnectionRequest.deviceName}
        ipAddress={mockConnectionRequest.ipAddress}
        onClose={() => setConnectionOpen(false)}
      />
    </div>
  );
}
