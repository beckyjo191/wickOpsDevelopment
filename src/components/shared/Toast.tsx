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
import { AlertCircle, CheckCircle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export type ToastInput = {
  kind?: ToastKind;
  message: string;
  /** Auto-dismiss after N ms. `0` keeps it open until manually dismissed.
   *  Defaults: 4000 (success/info), 8000 (error). */
  duration?: number;
};

type ToastRecord = ToastInput & {
  id: number;
  kind: ToastKind;
};

type ToastApi = {
  toast: (input: ToastInput | string) => void;
  success: (message: string, opts?: Omit<ToastInput, "message" | "kind">) => void;
  error: (message: string, opts?: Omit<ToastInput, "message" | "kind">) => void;
  info: (message: string, opts?: Omit<ToastInput, "message" | "kind">) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 8000,
};

const MAX_VISIBLE = 4;
let nextId = 1;

/**
 * Wraps the app and provides the toast queue + container. Renders toasts in
 * a fixed-position container (top-right on desktop, bottom on phones).
 *
 * Replaces the previous mix of `alert()` calls + the bespoke `usage-banner`
 * pattern with a single consistent affordance for transient feedback.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  // Keep a stable ref to the toasts array so the auto-dismiss timer callback
  // doesn't capture stale state when several toasts queue up at once.
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timerId = timersRef.current.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput | string) => {
      const normalized: ToastInput =
        typeof input === "string" ? { message: input } : input;
      const kind = normalized.kind ?? "info";
      const id = nextId++;
      const record: ToastRecord = {
        id,
        kind,
        message: normalized.message,
        duration: normalized.duration,
      };
      setToasts((prev) => {
        const next = [...prev, record];
        // Cap visible toasts; oldest get evicted first.
        return next.length > MAX_VISIBLE
          ? next.slice(next.length - MAX_VISIBLE)
          : next;
      });
      const duration = normalized.duration ?? DEFAULT_DURATION[kind];
      if (duration > 0) {
        const timerId = window.setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timerId);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (message, opts) => toast({ ...opts, kind: "success", message }),
      error: (message, opts) => toast({ ...opts, kind: "error", message }),
      info: (message, opts) => toast({ ...opts, kind: "info", message }),
      dismiss,
    }),
    [toast, dismiss],
  );

  // Clear any in-flight timers on unmount so we don't dismiss after the
  // provider has gone away (would set state on an unmounted component).
  useEffect(() => {
    return () => {
      for (const timerId of timersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      timersRef.current.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Use inside any component rendered under <ToastProvider> to surface
 * transient notifications. Throws if called outside the provider so the
 * misconfiguration surfaces immediately rather than silently swallowing
 * messages.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be called inside <ToastProvider>");
  }
  return ctx;
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: () => void }) {
  const Icon =
    toast.kind === "success" ? CheckCircle : toast.kind === "error" ? AlertCircle : Info;
  // Errors get role="alert" so screen readers announce them immediately;
  // success/info use role="status" (polite, non-interrupting).
  const role = toast.kind === "error" ? "alert" : "status";
  return (
    <div className={`toast toast--${toast.kind}`} role={role}>
      <span className="toast-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
