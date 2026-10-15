import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Pin, PinOff, X } from "lucide-react";

type Stage = "asking" | "connecting" | "showing" | "ended";

interface MirrorInfo {
  peer_id: string;
  peer_name: string;
}

/** Resolve once ICE gathering is done, or after `ms`: on a LAN it is quick. */
function gatheringDone(pc: RTCPeerConnection, ms = 3000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * A paired phone's screen, in a window of its own so a call can share just
 * this window. It opens as the question ("Galaxy A14 wants to share its
 * screen") and becomes the viewer once the user says yes. View-only.
 */
export default function MirrorWindow({ sessionId }: { sessionId: string }) {
  const [info, setInfo] = useState<MirrorInfo | null>(null);
  const [stage, setStage] = useState<Stage>("asking");
  const [problem, setProblem] = useState<string | null>(null);
  const [onTop, setOnTop] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sizedRef = useRef(false);

  const name = info?.peer_name ?? "A paired device";

  useEffect(() => {
    invoke<MirrorInfo | null>("mirror_info", { id: sessionId }).then((found) => {
      if (found) setInfo(found);
      else setStage("ended");
    });
    const unlisten = listen<string>("mirror-ended", (event) => {
      if (event.payload === sessionId) end("The phone stopped sharing.");
    });
    const leaving = () => invoke("mirror_close", { id: sessionId });
    window.addEventListener("beforeunload", leaving);
    return () => {
      unlisten.then((u) => u());
      window.removeEventListener("beforeunload", leaving);
      pcRef.current?.close();
    };
  }, [sessionId]);

  const end = (why?: string) => {
    pcRef.current?.close();
    pcRef.current = null;
    setStage("ended");
    if (why) setProblem(why);
  };

  const accept = async () => {
    setStage("connecting");
    await invoke("mirror_decide", { id: sessionId, accept: true });
    try {
      const offer = await invoke<string>("mirror_take_offer", { id: sessionId });
      // No STUN or TURN: both devices are on the same network.
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      pc.addEventListener("track", (event) => {
        if (videoRef.current) videoRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        setStage("showing");
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") end("The connection to the phone was lost.");
        if (pc.connectionState === "closed" || pc.connectionState === "disconnected") end("Sharing ended.");
      });
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheringDone(pc);
      await invoke("mirror_answer", { id: sessionId, sdp: pc.localDescription?.sdp ?? "" });
    } catch (e) {
      end(typeof e === "string" ? e : "Could not start showing the screen.");
    }
  };

  const decline = async () => {
    await invoke("mirror_decide", { id: sessionId, accept: false });
    getCurrentWindow().close();
  };

  const toggleOnTop = async () => {
    await getCurrentWindow().setAlwaysOnTop(!onTop);
    setOnTop(!onTop);
  };

  // Fit the window to the phone's shape once, when the first frame says it.
  const fitWindow = () => {
    const video = videoRef.current;
    if (!video || sizedRef.current || !video.videoWidth) return;
    sizedRef.current = true;
    const height = Math.min(900, Math.round(window.screen.availHeight * 0.85));
    const width = Math.round((height - 44) * (video.videoWidth / video.videoHeight));
    getCurrentWindow().setSize(new LogicalSize(width, height)).catch(() => {});
  };

  return (
    <div className="flex h-screen flex-col bg-black text-content">
      {stage === "showing" && (
        <div className="flex h-11 shrink-0 items-center gap-2 bg-surface-raised px-3">
          <span className="h-2 w-2 rounded-full bg-ok" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          <button
            onClick={toggleOnTop}
            title={onTop ? "Stop keeping on top" : "Keep on top of other windows"}
            aria-label={onTop ? "Stop keeping on top" : "Keep on top"}
            className="rounded-md p-1.5 text-content-muted hover:bg-surface-active hover:text-content"
          >
            {onTop ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            title="Stop showing"
            aria-label="Stop showing"
            className="rounded-md p-1.5 text-content-muted hover:bg-surface-active hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={fitWindow}
          className={`h-full w-full object-contain ${stage === "showing" ? "" : "hidden"}`}
        />

        {stage !== "showing" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface px-8 text-center">
            {stage === "asking" && (
              <>
                <p className="text-lg font-semibold">{name} wants to show its screen here</p>
                <p className="text-sm text-content-muted">
                  It appears in this window only, which you can share in a call. View-only: nothing you do here
                  reaches the phone.
                </p>
                {/* Equal weight: neither is the default. */}
                <div className="mt-2 flex w-full max-w-xs gap-3">
                  <button
                    onClick={decline}
                    className="flex-1 rounded-lg border border-border-strong px-4 py-2.5 text-sm font-semibold hover:bg-surface-active"
                  >
                    Decline
                  </button>
                  <button
                    onClick={accept}
                    className="flex-1 rounded-lg border border-border-strong px-4 py-2.5 text-sm font-semibold hover:bg-surface-active"
                  >
                    Show it
                  </button>
                </div>
              </>
            )}
            {stage === "connecting" && <p className="text-sm text-content-muted">Waiting for {name}…</p>}
            {stage === "ended" && (
              <>
                <p className="text-base font-semibold">{problem ?? "Sharing ended."}</p>
                <button
                  onClick={() => getCurrentWindow().close()}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:bg-surface-active"
                >
                  Close
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
