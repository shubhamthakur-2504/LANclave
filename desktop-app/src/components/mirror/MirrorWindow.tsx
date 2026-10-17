import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Pin, PinOff, X } from "lucide-react";

type Stage = "asking" | "connecting" | "showing" | "ended";

/** How long a dropped connection may take to come back before sharing ends. */
const RECONNECT_GRACE_MS = 5000;
/** Connected this long with no picture: say so instead of a blank window. */
const FIRST_FRAME_MS = 10000;

/** Connection counters are logged this often, this many times per share. */
const STATS_EVERY_MS = 5000;
const STATS_TIMES = 12;

/** A step of session `id`, to the `tauri dev` console (through Rust) and to devtools. */
function log(id: string, line: string) {
  console.log(`[mirror] ${line}`);
  invoke("mirror_log", { id, line }).catch(() => {});
}

type Stat = Record<string, unknown>;

/** What the connection is doing, from WebRTC's own counters. */
async function logStats(id: string, pc: RTCPeerConnection, why: string) {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return;
  }
  const byId = new Map<string, Stat>();
  report.forEach((s: Stat) => byId.set(s.id as string, s));
  const candidate = (ref: unknown) => {
    const c = byId.get(ref as string);
    return c ? `${c.address ?? c.ip}:${c.port} ${c.candidateType}/${c.protocol}` : "?";
  };
  const lines: string[] = [];
  report.forEach((s: Stat) => {
    if (s.type === "candidate-pair") {
      lines.push(
        `pair ${s.state}${s.nominated ? " nominated" : ""}: ${candidate(s.localCandidateId)} -> ${candidate(s.remoteCandidateId)}, ` +
          `sent ${s.bytesSent} B, received ${s.bytesReceived} B, checks ${s.requestsSent}/${s.responsesReceived}, ` +
          `rtt ${s.currentRoundTripTime} s`,
      );
    }
    if (s.type === "inbound-rtp" && s.kind === "video") {
      const emitted = Number(s.jitterBufferEmittedCount) || 0;
      const buffered = emitted ? Math.round((Number(s.jitterBufferDelay) / emitted) * 1000) : "?";
      lines.push(
        `video in: ${byId.get(s.codecId as string)?.mimeType}, ${s.framesReceived} received, ${s.framesDecoded} decoded, ` +
          `${s.framesDropped} dropped, ${s.framesPerSecond} fps, ${s.bytesReceived} B, ${s.frameWidth}x${s.frameHeight}, ` +
          `decoder ${s.decoderImplementation}, buffered ${buffered} ms on average, ${s.packetsLost} packets lost`,
      );
    }
  });
  log(id, `stats (${why}):`);
  if (lines.length === 0) log(id, "  nothing yet");
  lines.forEach((l) => log(id, `  ${l}`));
}

interface MirrorInfo {
  peer_id: string;
  peer_name: string;
}

/** Resolve once ICE gathering is done (true), or after `ms` (false): on a LAN it is quick. */
function gatheringDone(pc: RTCPeerConnection, ms = 3000): Promise<boolean> {
  if (pc.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve(true);
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
  /** What "connecting" is waiting on, in words. */
  const [detail, setDetail] = useState<string | null>(null);
  const [onTop, setOnTop] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sizedRef = useRef(false);
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      if (graceRef.current) clearTimeout(graceRef.current);
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [sessionId]);

  const end = (why?: string) => {
    if (why) log(sessionId, `ended: ${why}`);
    if (graceRef.current) clearTimeout(graceRef.current);
    graceRef.current = null;
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setStage("ended");
    if (why) setProblem(why);
  };

  const accept = async () => {
    setStage("connecting");
    if (!(await invoke<boolean>("mirror_decide", { id: sessionId, accept: true }))) {
      end(`${name} stopped asking.`);
      return;
    }
    const id = sessionId;
    try {
      log(id, "waiting for the phone's offer");
      const offer = await invoke<string>("mirror_take_offer", { id });
      log(id, `offer received (${offer.length} bytes)`);
      // No STUN or TURN: both devices are on the same network.
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      let ticks = 0;
      tickerRef.current = setInterval(() => {
        if (++ticks > STATS_TIMES && tickerRef.current) clearInterval(tickerRef.current);
        else logStats(id, pc, `${(ticks * STATS_EVERY_MS) / 1000} s`);
      }, STATS_EVERY_MS);
      pc.addEventListener("signalingstatechange", () => log(id, `signaling ${pc.signalingState}`));
      pc.addEventListener("icegatheringstatechange", () => log(id, `ICE gathering ${pc.iceGatheringState}`));
      pc.addEventListener("iceconnectionstatechange", () => log(id, `ICE connection ${pc.iceConnectionState}`));
      pc.addEventListener("icecandidate", (event) => {
        if (event.candidate) log(id, `gathered ${event.candidate.candidate}`);
      });
      pc.addEventListener("icecandidateerror", (event) => {
        const e = event as RTCPeerConnectionIceErrorEvent;
        log(id, `candidate error ${e.errorCode} ${e.errorText} at ${e.address}:${e.port} ${e.url}`);
      });
      // The track arrives with the offer, long before any picture: the
      // window becomes the viewer on the first frame (`onLoadedMetadata`).
      pc.addEventListener("track", (event) => {
        log(id, `track arrived: ${event.track.kind}, ${event.streams.length} stream(s)`);
        // Show each frame as it arrives: a LAN barely jitters, and what the
        // phone does should appear here at once, not after a cushion.
        const receiver = event.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
        receiver.jitterBufferTarget = 0;
        receiver.playoutDelayHint = 0;
        if (videoRef.current) videoRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      });
      pc.addEventListener("connectionstatechange", () => {
        const state = pc.connectionState;
        log(id, `connection ${state}`);
        if (state === "connecting") setDetail(`Connecting to ${name}…`);
        if (state === "connected") {
          logStats(id, pc, "connected");
          setDetail(`Connected. Waiting for the first picture from ${name}…`);
          setTimeout(() => {
            if (pcRef.current === pc && !videoRef.current?.videoWidth) {
              log(id, `connected ${FIRST_FRAME_MS / 1000} s ago and still no picture`);
              logStats(id, pc, "no picture");
              setDetail(`Connected, but no picture is arriving from ${name}. Stop and share again from the phone.`);
            }
          }, FIRST_FRAME_MS);
        }
        if (state === "failed" || state === "disconnected") logStats(id, pc, state);
        if (state === "failed") end("The connection to the phone was lost.");
        if (state === "closed") end("Sharing ended.");
        // A Wi-Fi blip passes; give it a moment before calling it over.
        if (state === "disconnected" && !graceRef.current) {
          graceRef.current = setTimeout(() => {
            graceRef.current = null;
            if (pc.connectionState === "disconnected") end("The connection to the phone was lost.");
          }, RECONNECT_GRACE_MS);
        }
        if (state === "connected" && graceRef.current) {
          clearTimeout(graceRef.current);
          graceRef.current = null;
        }
      });
      setDetail(`Connecting to ${name}…`);
      await pc.setRemoteDescription({ type: "offer", sdp: offer });
      log(id, "offer applied");
      await pc.setLocalDescription(await pc.createAnswer());
      log(id, "answer created");
      if (!(await gatheringDone(pc))) log(id, "ICE gathering not done after 3 s; answering with what there is");
      const handed = await invoke<boolean>("mirror_answer", { id, sdp: pc.localDescription?.sdp ?? "" });
      log(id, handed ? "answer handed to the phone" : "answer not taken: the phone had stopped waiting");
    } catch (e) {
      log(id, `setup threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
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
    log(sessionId, `video metadata: ${video?.videoWidth}x${video?.videoHeight}`);
    if (video?.videoWidth) setStage((stage) => (stage === "connecting" ? "showing" : stage));
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
          onPlaying={() => log(sessionId, "video playing")}
          onError={() => log(sessionId, `video error: ${videoRef.current?.error?.message ?? "unknown"}`)}
          // Laid out (not display:none) while connecting, so it decodes
          // and reports the first frame behind the overlay.
          className={`h-full w-full object-contain ${stage === "showing" ? "" : "opacity-0"}`}
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
            {stage === "connecting" && <p className="text-sm text-content-muted">{detail ?? `Waiting for ${name}…`}</p>}
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
