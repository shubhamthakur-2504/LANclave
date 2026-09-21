import { useEffect, useState, useCallback, useRef } from "react";
import type { PageType, PeerInfo, FileEntry } from "./types";
import * as api from "./api";
import Header from "./components/layout/Header";
import Sidebar from "./components/layout/Sidebar";
import PeersPage from "./components/peers/PeersPage";
import FilesPage from "./components/files/FilesPage";
import TransfersPage from "./components/transfers/TransfersPage";
import ConnectionModal from "./components/connection/ConnectionModal";
import RemoteFilesPage from "./components/files/RemoteFilesPage";
import { SettingsPage } from "./components/settings/SettingsPage";
import { TransferProvider } from "./contexts/TransferContext";
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

  const [viewingPeer, setViewingPeer] = useState<PeerInfo | null>(null);
  const peerFailsRef = useRef<Record<string, number>>({});
  const [isScanning, setIsScanning] = useState(false);
  const scanInFlightRef = useRef(false);

  const refreshServerStatus = useCallback(async () => {
    try {
      setServerRunning(await api.isServerRunning());
    } catch {
      setServerRunning(false);
    }
  }, []);

  const refreshPeers = useCallback(async () => {
    // Discovery is a full subnet sweep: expensive, and never run on a timer.
    // Guard here too so rapid clicks cannot stack sweeps.
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setIsScanning(true);
    try {
      const livePeers = await api.discoverPeers();
      
      setPeers((prevPeers) => {
        const fails = peerFailsRef.current;
        return livePeers.map(peer => {
          const prev = prevPeers.find(p => p.device_id === peer.device_id);
          if (!peer.addr && prev?.addr) {
            fails[peer.device_id] = (fails[peer.device_id] || 0) + 1;
            if (fails[peer.device_id] < 3) {
              return { ...peer, addr: prev.addr };
            }
          } else if (peer.addr) {
            fails[peer.device_id] = 0;
          }
          return peer;
        });
      });
    } catch {
      // Scan failed or was already running -- keep the previous peer list.
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
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
    api
      .isServerRunning()
      .then(async (running) => {
        if (!running) {
          try {
            await api.startServer();
            setServerRunning(true);
          } catch {
            // ignore
          }
        } else {
          setServerRunning(true);
        }
      })
      .catch(() => {});

    refreshPeers();
    refreshFiles();
  }, [refreshPeers, refreshFiles]);

  // Only the local sandbox listing is polled. Peer discovery is user-driven --
  // see the Scan button on the Peers page.
  useEffect(() => {
    const id = setInterval(() => {
      refreshFiles();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshFiles]);

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
    if (viewingPeer) {
      return (
        <RemoteFilesPage
          peer={viewingPeer}
          onBack={() => setViewingPeer(null)}
          onFileDownloaded={() => refreshFiles()}
        />
      );
    }

    switch (activePage) {
      case "peers":
        return (
          <PeersPage
            peers={peers}
            isScanning={isScanning}
            onScan={refreshPeers}
            onOpenConnection={(peer) => {
              setPairPeer(peer);
              setIsConnectModalOpen(true);
            }}
            onBrowseFiles={(peer) => setViewingPeer(peer)}
          />
        );
      case "files":
        return <FilesPage files={localFiles} />;
      case "transfers":
        return <TransfersPage />; // removed transfers={[]} 
      case "settings":
        return <SettingsPage />;
    }
  })();

  return (
    <TransferProvider>
      <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            activePage={activePage}
            onNavigate={(page) => {
              setActivePage(page);
              setViewingPeer(null);
            }}
            serverRunning={serverRunning}
            onStartServer={handleStartServer}
            onStopServer={handleStopServer}
            serverBusy={serverBusy}
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
    </TransferProvider>
  );
}
