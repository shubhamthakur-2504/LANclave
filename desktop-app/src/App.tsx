import { useEffect, useState, useCallback } from "react";
import type { PageType, PeerInfo, FileEntry } from "./types";
import { mockTransfers } from "./mockdata";
import * as api from "./api";
import Header from "./components/layout/Header";
import Sidebar from "./components/layout/Sidebar";
import PeersPage from "./components/peers/PeersPage";
import FilesPage from "./components/files/FilesPage";
import TransfersPage from "./components/transfers/TransfersPage";
import ConnectionModal from "./components/connection/ConnectionModal";
import "./App.css";

export default function App() {
  const [activePage, setActivePage] = useState<PageType>("peers");
  const [serverRunning, setServerRunning] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Pairing state
  const [pairPeer, setPairPeer] = useState<PeerInfo | null>(null);
  const [pairFingerprint, setPairFingerprint] = useState<string | null>(null);

  const refreshServerStatus = useCallback(async () => {
    try {
      setServerRunning(await api.isServerRunning());
    } catch {
      setServerRunning(false);
    }
  }, []);

  const refreshPeers = useCallback(async () => {
    try {
      const p = await api.discoverPeers();
      setPeers(p);
    } catch {
      // silent
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      setLocalFiles(await api.listSandboxFiles());
    } catch {
      setLocalFiles([]);
    }
  }, []);

  useEffect(() => {
    refreshServerStatus();
    refreshPeers();
    refreshFiles();
  }, [refreshServerStatus, refreshPeers, refreshFiles]);

  useEffect(() => {
    const id = setInterval(refreshPeers, 10_000);
    return () => clearInterval(id);
  }, [refreshPeers]);

  // Listen for pairing requests initiated by mobile peers
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen<{ device_id: string; ip: string; name: string; fingerprint: string }>(
          "pairing-request",
          (event) => {
            setPairPeer({
              addr: event.payload.ip,
              device_id: event.payload.device_id,
              paired: false,
            });
            if (event.payload.fingerprint) {
              setPairFingerprint(event.payload.fingerprint);
            }
            setIsConnectModalOpen(true);
          }
        ).then((unsub) => {
          unlistenFn = unsub;
        });
      })
      .catch(() => {});

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const handleStartServer = useCallback(async () => {
    setServerBusy(true);
    setError(null);
    try {
      await api.startServer();
      setServerRunning(true);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setServerBusy(false);
    }
  }, []);

  const handleStopServer = useCallback(async () => {
    setServerBusy(true);
    setError(null);
    try {
      await api.stopServer();
      setServerRunning(false);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setServerBusy(false);
    }
  }, []);

  const handlePaired = useCallback(() => {
    refreshPeers();
  }, [refreshPeers]);

  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);

  const pageContent = (() => {
    switch (activePage) {
      case "peers":
        return (
          <PeersPage
            peers={peers}
            onOpenConnection={(peer) => {
              setPairPeer(peer);
              setIsConnectModalOpen(true);
            }}
          />
        );
      case "files":
        return <FilesPage files={localFiles} />;
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
          serverRunning={serverRunning}
          onStartServer={handleStartServer}
          onStopServer={handleStopServer}
          serverBusy={serverBusy}
          onOpenConnection={() => {
            const target = peers.find((p) => !p.paired) ?? null;
            setPairPeer(target);
            setIsConnectModalOpen(true);
          }}
        />
        <main className="flex-1 overflow-hidden">
          {error && (
            <div className="mx-4 mt-2 rounded-lg bg-red-950/50 px-4 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
          {pageContent}
        </main>
      </div>
      <ConnectionModal
        isOpen={isConnectModalOpen || pairPeer !== null}
        peerAddr={pairPeer?.addr ?? ""}
        peerDeviceId={pairPeer?.device_id ?? ""}
        initialFingerprint={pairFingerprint}
        onClose={() => {
          setPairPeer(null);
          setPairFingerprint(null);
          setIsConnectModalOpen(false);
        }}
        onPaired={handlePaired}
      />
    </div>
  );
}
