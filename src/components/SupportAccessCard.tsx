import { useEffect, useState } from "react";
import { ChevronRight, LifeBuoy } from "lucide-react";
import {
  getSupportAccessStatus,
  grantSupportAccess,
  revokeSupportAccess,
  SUPPORT_ACCESS_DURATIONS,
  type SupportAccessStatus,
} from "../lib/inventoryApi";
import { useToast } from "./shared/Toast";
import { ConfirmDialog } from "./shared/ConfirmDialog";

/** Format an ISO timestamp as a readable local date+time, e.g. "Jun 30, 3:00 PM". */
const formatWhen = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

/**
 * Owner-only consent control for time-boxed WickOps platform-support access.
 * Granting opens a read-only window during which WickOps staff can view (never
 * edit) this org's data to troubleshoot. The window auto-expires; the owner can
 * also revoke early. This is the customer-facing half of the support feature —
 * the grant it creates is what the backend checks before any support read.
 */
export function SupportAccessCard({ open = true }: { open?: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<SupportAccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [durationHours, setDurationHours] = useState(48);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getSupportAccessStatus();
        if (!cancelled) setStatus(s);
      } catch {
        // Non-fatal: leave the card in its default (inactive) state.
        if (!cancelled) setStatus({ active: false, expiresAt: null, scope: ["inventory:read"] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGrant = async () => {
    setGranting(true);
    try {
      const s = await grantSupportAccess(durationHours);
      setStatus(s);
      toast.success("Support access granted. WickOps can view your data until it expires.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not grant support access.");
    } finally {
      setGranting(false);
    }
  };

  const handleRevoke = async () => {
    setConfirmRevoke(false);
    setRevoking(true);
    try {
      const s = await revokeSupportAccess();
      setStatus(s);
      toast.success("Support access revoked.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke support access.");
    } finally {
      setRevoking(false);
    }
  };

  const active = status?.active ?? false;

  return (
    <details className="settings-section" open={open}>
      <summary className="settings-section-title">
        Support Access
        <ChevronRight size={16} className="settings-section-chevron" aria-hidden="true" />
      </summary>

      <p className="settings-section-copy">
        Grant WickOps support a temporary, <strong>read-only</strong> window to view your
        inventory data so we can help troubleshoot. Access is logged, auto-expires,
        and you can revoke it any time. We can never edit your data.
      </p>

      {loading ? (
        <p className="settings-section-copy">Loading…</p>
      ) : active ? (
        <div className="support-access-active">
          <div className="app-alert-card app-alert-card--info" style={{ cursor: "default" }}>
            <span className="app-alert-card__icon">
              <LifeBuoy size={18} aria-hidden="true" />
            </span>
            <span className="app-alert-card__text">
              WickOps support can view your data until <strong>{formatWhen(status?.expiresAt)}</strong>.
              {status?.lastAccessedAt
                ? ` Last viewed ${formatWhen(status.lastAccessedAt)}.`
                : " Not viewed yet."}
            </span>
          </div>
          <button
            type="button"
            className="button button-danger button-sm"
            disabled={revoking}
            onClick={() => setConfirmRevoke(true)}
            style={{ marginTop: "0.75rem" }}
          >
            {revoking ? "Revoking…" : "Revoke access now"}
          </button>
        </div>
      ) : (
        <div className="support-access-grant" style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <label className="settings-column-select" style={{ gap: "0.4rem" }}>
            <span>Window</span>
            <select
              value={durationHours}
              onChange={(e) => setDurationHours(Number(e.target.value))}
              disabled={granting}
            >
              {SUPPORT_ACCESS_DURATIONS.map((d) => (
                <option key={d.hours} value={d.hours}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button-primary button-sm"
            disabled={granting}
            onClick={() => void handleGrant()}
          >
            {granting ? "Granting…" : "Grant support access"}
          </button>
        </div>
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title="Revoke support access?"
          message="WickOps support will immediately lose the ability to view your data."
          confirmLabel="Revoke"
          onConfirm={() => void handleRevoke()}
          onCancel={() => setConfirmRevoke(false)}
        />
      )}
    </details>
  );
}
