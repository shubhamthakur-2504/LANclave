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
import { ToastProvider, useToast } from "./components/ui/Toast";
import "./App.css";

function AppInner() {
  const [activePage, setActivePage] = useState<PageType>("peers");
  const [serverRunning, setServerRunning] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const toast = useToast();

  // Pairing state
  const [pairPeer, setPairPeer] = useState<PeerInfo | null>(null);
  const [pairFingerprint, setPairFingerprint] = useState<string | null>(null);

  const [viewingPeer, setViewingPeer] = useState<PeerInfo | null>(null);
  // Unpaired devices from the most recent manual scan. Paired peers come from
  // presence instead, so they stay current without any scanning.
  const nearbyRef = useRef<PeerInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const scanInFlightRef = useRef(false);

  const refreshServerStatus = useCallback(async () => {
    try {
      setServerRunning(await api.isServerRunning());
    } catch {
      setServerRunning(false);
    }
  }, []);

  /** Rebuild the list from presence (paired) + last scan (nearby). No network. */
  const loadPeers = useCallback(async () => {
    try {
      const paired = await api.listPeers();
      const pairedIds = new Set(paired.map((p) => p.device_id));
      const nearby = nearbyRef.current.filter((p) => !pairedIds.has(p.device_id));
      setPeers([...paired, ...nearby]);
    } catch {
      // keep the previous list
    }
  }, []);

  /** Manual discovery: one full subnet sweep, guarded against re-entry. */
  const refreshPeers = useCallback(async () => {
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    setIsScanning(true);
    try {
      const found = await api.discoverPeers();
      nearbyRef.current = found.filter((p) => !p.paired && p.addr);
    } catch {
      // Scan failed or was already running -- keep what we had.
    } finally {
      scanInFlightRef.current = false;
      setIsScanning(false);
      await loadPeers();
    }
  }, [loadPeers]);

  const rescanPeer = useCallback(
    async (peer: PeerInfo) => {
      try {
        await api.rescanPeer(peer.device_id);
      } catch {
        // fall through to reload
      }
      await loadPeers();
    },
    [loadPeers],
  );

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

    // Paired peers come from presence -- no sweep needed at launch.
    loadPeers();
    refreshFiles();
  }, [loadPeers, refreshFiles]);

  // The backend emits this whenever a peer comes online or goes offline
  // (heartbeat, hello, bye), so the list updates without polling.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("presence-changed", () => loadPeers()))
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [loadPeers]);

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
    try {
      await api.startServer();
      setServerRunning(true);
      toast.success("Server started", "Other devices on this network can reach you.");
    } catch (e: unknown) {
      toast.error(e);
      await refreshServerStatus();
    } finally {
      setServerBusy(false);
    }
  }, [toast, refreshServerStatus]);

  const handleStopServer = useCallback(async () => {
    setServerBusy(true);
    try {
      await api.stopServer();
      setServerRunning(false);
      toast.info("Server stopped", "This device is no longer reachable.");
    } catch (e: unknown) {
      toast.error(e);
      await refreshServerStatus();
    } finally {
      setServerBusy(false);
    }
  }, [toast, refreshServerStatus]);

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
            onRescanPeer={rescanPeer}
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
      <div className="flex h-screen flex-col bg-surface text-content">
        <Header serverRunning={serverRunning} serverBusy={serverBusy} />
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

/**
 * The app proper is a child of ToastProvider so it can call useToast().
 */
export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
