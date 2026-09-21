/**
 * Toasts.
 *
 * Replaces the permanent red div that rendered `String(e)` and never went
 * away. Toasts dismiss themselves, stack, and can be dismissed by hand.
 *
 * Errors are deliberately given a longer life than successes: you are more
 * likely to have looked away when something failed.
 */

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { humanizeError } from "../../lib/errors";

type ToastTone = "error" | "success" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  hint?: string;
}

interface ToastApi {
  success: (message: string, hint?: string) => void;
  info: (message: string, hint?: string) => void;
  /** Runs the raw error through `humanizeError` — never shows an exception. */
  error: (err: unknown, peerName?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFETIME_MS: Record<ToastTone, number> = {
  error: 8000,
  success: 4000,
  info: 5000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, hint?: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, tone, message, hint }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME_MS[tone]),
      );
    },
    [dismiss],
  );

  // Never leave a timer running past unmount.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, h) => push("success", m, h),
      info: (m, h) => push("info", m, h),
      error: (err, peerName) => {
        const { message, hint } = humanizeError(err, peerName);
        push("error", message, hint);
      },
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_STYLES: Record<ToastTone, { ring: string; icon: ReactNode }> = {
  error: {
    ring: "border-danger-border",
    icon: <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />,
  },
  success: {
    ring: "border-ok-border",
    icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-hidden="true" />,
  },
  info: {
    ring: "border-border-strong",
    icon: <Info className="h-4 w-4 shrink-0 text-action" aria-hidden="true" />,
  },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border ${TONE_STYLES[t.tone].ring} bg-surface-raised px-3 py-2.5 shadow-lg`}
        >
          {TONE_STYLES[t.tone].icon}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-content">{t.message}</p>
            {t.hint && (
              <p className="mt-0.5 text-[11px] leading-snug text-content-muted">
                {t.hint}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-content-faint transition-colors hover:text-content"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
