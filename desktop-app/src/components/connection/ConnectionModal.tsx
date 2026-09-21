import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../api";

/**
 * Group the six digits as `428 106`.
 *
 * Two groups of three is markedly easier to read aloud and compare against
 * another screen than one run of six, and comparing is the entire job of this
 * screen.
 */
function groupFingerprint(fp: string): string {
  const digits = fp.replace(/\s+/g, "");
  if (digits.length !== 6) return fp;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

interface ConnectionModalProps {
  isOpen: boolean;
  peerAddr: string;
  peerDeviceId: string;
  peerDeviceName?: string;
  initialFingerprint?: string | null;
  onClose: () => void;
  onPaired: () => void;
}

export default function ConnectionModal({
  isOpen,
  peerAddr: initialAddr,
  peerDeviceId: initialDeviceId,
  peerDeviceName: initialDeviceName,
  initialFingerprint,
  onClose,
  onPaired,
}: ConnectionModalProps) {
  const [customAddr, setCustomAddr] = useState(initialAddr);
  const [fingerprint, setFingerprint] = useState<string | null>(initialFingerprint || null);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (initialFingerprint) {
        setFingerprint(initialFingerprint);
      } else {
        setFingerprint(null);
      }
      setConfirmed(false);
      setError(null);
    }
  }, [isOpen, initialFingerprint]);

  // Esc closes the modal (U3.4). Registered before the early return so the
  // hook order stays stable across renders.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const targetAddr = customAddr || initialAddr;

  const handleInitiate = async () => {
    if (!targetAddr) {
      setError("Please enter a valid IP address.");
      return;
    }

    setLoading(true);
    setError(null);

    let devId = initialDeviceId;
    let devName = initialDeviceName;
    let normalizedAddr = targetAddr.trim();

    // Ensure port is present
    if (!normalizedAddr.includes(":")) {
      normalizedAddr += ":8377";
    }

    try {
      // If device_id is missing, probe /health or check connection
      if (!devId) {
        const res = await fetch(`http://${normalizedAddr}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = await res.json();
          if (body.device_id) devId = body.device_id;
          if (body.device_name) devName = body.device_name;
        }
      }

      if (!devId) {
        // Fallback: try initiating with address
        devId = normalizedAddr;
      }

      const fp = await api.initiatePairing(normalizedAddr, devId, devName);
      setFingerprint(fp);
    } catch (e: unknown) {
      setError(
        `Failed to reach ${normalizedAddr}. Check IP & ensure server is active.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    setLoading(true);
    setError(null);
    try {
      let normalizedAddr = targetAddr.trim();
      if (!normalizedAddr.includes(":")) normalizedAddr += ":8377";

      await api.confirmPairing(normalizedAddr, initialDeviceId || normalizedAddr, initialDeviceName);
      setConfirmed(true);
      onPaired();
      setTimeout(onClose, 1500);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border-strong bg-surface-raised shadow-2xl shadow-action/5">
        <div className="flex justify-end px-4 pt-4">
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-full text-content-faint transition-colors hover:bg-surface-active hover:text-content"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="px-8 pb-8 pt-2 text-center">
          <h2 className="text-lg font-semibold text-content">
            {confirmed
              ? "Paired Successfully"
              : fingerprint
                ? "Confirm Fingerprint"
                : "Pair Device"}
          </h2>

          {!fingerprint && !confirmed && (
            <>
              {initialAddr ? (
                <>
                  <div className="mx-auto mt-5 flex h-16 w-16 items-center justify-center rounded-full bg-action/20 text-xl font-bold text-action">
                    {initialAddr[0]?.toUpperCase() ?? "?"}
                  </div>
                  <p className="mt-3 text-sm text-content-muted">{initialAddr}</p>
                </>
              ) : (
                /*
                 * PRD 3.1 promises no manual IP typing: devices are meant to
                 * find each other. Kept as a debug escape hatch behind a
                 * disclosure rather than as the primary path.
                 */
                <div className="mt-4 text-left">
                  <p className="text-sm text-content-muted">
                    Pick a device from the Peers list to pair with it.
                  </p>
                  <details className="mt-4 rounded-lg border border-border bg-surface-inset px-3 py-2">
                    <summary className="cursor-pointer text-xs text-content-faint select-none">
                      Connect manually
                    </summary>
                    <label
                      htmlFor="manual-addr"
                      className="mt-3 block text-xs font-medium text-content-muted"
                    >
                      Peer address
                    </label>
                    <input
                      id="manual-addr"
                      type="text"
                      placeholder="e.g. 192.168.43.1:8377"
                      value={customAddr}
                      onChange={(e) => setCustomAddr(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-content outline-none focus:border-action"
                    />
                    <p className="mt-2 text-[11px] text-content-faint">
                      Only needed when discovery cannot see the device.
                    </p>
                  </details>
                </div>
              )}

              {loading && (
                <p className="mt-4 text-sm text-content-faint">
                  Connecting to peer…
                </p>
              )}

              {error && <p className="mt-4 text-sm text-danger">{error}</p>}

              <div className="mt-6 flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-border-strong px-4 py-2.5 text-sm font-medium text-content transition-colors hover:bg-surface-active"
                >
                  Cancel
                </button>
                <button
                  onClick={handleInitiate}
                  disabled={loading}
                  className="flex-1 rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-on-action transition-colors hover:bg-action-hover disabled:opacity-40"
                >
                  {loading ? "Connecting…" : "Connect"}
                </button>
              </div>
            </>
          )}

          {fingerprint && !confirmed && (
            <>
              {/*
                * The security ceremony. This is the one moment the user must
                * genuinely stop and compare something, so the digits are the
                * largest thing on screen and the two devices are named side
                * by side to make it obvious what is being paired.
                */}
              <div className="mt-5 flex items-center justify-center gap-3 text-xs">
                <span className="max-w-[9rem] truncate font-medium text-content">
                  This device
                </span>
                <ShieldCheck
                  className="h-4 w-4 shrink-0 text-content-faint"
                  aria-hidden="true"
                />
                <span className="max-w-[9rem] truncate font-medium text-content">
                  {initialDeviceName || targetAddr || "Other device"}
                </span>
              </div>

              <div className="mx-auto mt-4 w-fit rounded-xl border border-action/20 bg-action/10 px-8 py-5">
                <span className="font-mono text-5xl font-bold tracking-[0.2em] text-action tabular-nums">
                  {groupFingerprint(fingerprint)}
                </span>
              </div>

              <p className="mx-auto mt-4 max-w-[19rem] text-sm leading-relaxed text-content">
                Only confirm if the same six digits appear on the other device.
              </p>
              <p className="mt-1.5 text-xs text-content-faint">
                If they differ, reject — someone else may be trying to pair.
              </p>

              {error && <p className="mt-3 text-sm text-danger">{error}</p>}

              {/*
                * Equal weight on purpose. A pairing dialog where confirm is
                * the big blue button trains people to click it without
                * reading, which defeats the fingerprint entirely.
                */}
              <div className="mt-6 flex gap-3">
                <button
                  onClick={onClose}
                  disabled={loading}
                  className="flex-1 rounded-lg border border-danger-border bg-danger-bg/40 px-4 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
                >
                  They don't match
                </button>
                <button
                  onClick={handleAccept}
                  disabled={loading}
                  className="flex-1 rounded-lg border border-ok-border bg-ok/10 px-4 py-2.5 text-sm font-semibold text-ok transition-colors hover:bg-ok/20 disabled:opacity-40"
                >
                  {loading ? "Confirming…" : "They match"}
                </button>
              </div>
            </>
          )}

          {confirmed && (
            <>
              {/* The payoff for the only friction in the product. */}
              <div className="mx-auto mt-6 flex h-16 w-16 animate-[ping_0.6s_ease-out_1] items-center justify-center rounded-full bg-ok/20">
                <Check className="h-8 w-8 text-ok" strokeWidth={2.5} aria-hidden="true" />
              </div>
              <p className="mt-4 text-base font-semibold text-content">
                Paired with {initialDeviceName || targetAddr || "this device"}
              </p>
              <p className="mt-1 text-xs text-content-muted">
                You can now browse and send files between these two devices.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
