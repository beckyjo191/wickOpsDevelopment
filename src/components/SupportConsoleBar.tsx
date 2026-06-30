import { useEffect, useMemo, useRef, useState } from "react";
import { LifeBuoy, X } from "lucide-react";
import { getSupportOrgOverride, setSupportOrgOverride } from "../lib/authFetch";
import { listSupportOrgs, type SupportOrgEntry } from "../lib/inventoryApi";

/** Format an ISO expiry as a short local time, e.g. "Jun 30, 3:00 PM". */
const formatExpiry = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/**
 * Internal operator bar, rendered only for WickOps staff in the
 * PLATFORM_SUPPORT Cognito group (see App.tsx group detection). Lets an
 * operator "act as" a customer org via a searchable picker: every API request
 * then carries the support header, and the backend serves that org's data
 * read-only — but only while the org has a live consent grant (otherwise the
 * API 403s, and the picker greys those orgs out and won't enter them).
 *
 * Entering/exiting reloads the page so all data refetches under the new scope.
 * The override lives in sessionStorage, so it survives the reload but never
 * outlives the browser session.
 */
export function SupportConsoleBar() {
  const acting = getSupportOrgOverride();
  const [orgs, setOrgs] = useState<SupportOrgEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [openList, setOpenList] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Load the org directory once, only when not already acting.
  useEffect(() => {
    if (acting) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await listSupportOrgs();
        if (!cancelled) setOrgs(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load organizations.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [acting]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orgs;
    return orgs.filter(
      (o) => o.name.toLowerCase().includes(q) || o.organizationId.toLowerCase().includes(q),
    );
  }, [orgs, query]);

  const enter = (org: SupportOrgEntry) => {
    if (!org.grantActive) return;
    setSupportOrgOverride(org.organizationId);
    window.location.reload();
  };

  const exit = () => {
    setSupportOrgOverride(null);
    window.location.reload();
  };

  if (acting) {
    return (
      <div className="support-console-bar support-console-bar--active" role="status">
        <LifeBuoy size={16} aria-hidden="true" />
        <span>
          Support mode — viewing org <strong>{acting}</strong> (read-only)
        </span>
        <button type="button" className="button button-sm" onClick={exit}>
          <X size={14} aria-hidden="true" /> Exit support mode
        </button>
      </div>
    );
  }

  return (
    <div className="support-console-bar" role="region" aria-label="WickOps support console" ref={wrapRef}>
      <LifeBuoy size={16} aria-hidden="true" />
      <span>Support console</span>
      <div className="support-console-picker">
        <input
          type="text"
          value={query}
          placeholder={loading ? "Loading organizations…" : "Search organizations…"}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpenList(true);
          }}
          onFocus={() => setOpenList(true)}
          disabled={loading}
        />
        {openList && (
          <div className="support-console-dropdown" role="listbox">
            {error && <div className="support-console-empty">{error}</div>}
            {!error && filtered.length === 0 && (
              <div className="support-console-empty">No matching organizations.</div>
            )}
            {filtered.map((org) => (
              <button
                type="button"
                key={org.organizationId}
                className="support-console-option"
                disabled={!org.grantActive}
                title={org.grantActive ? "" : "No active support grant — ask the org owner to grant access."}
                onClick={() => enter(org)}
                role="option"
                aria-selected={false}
              >
                <span className="support-console-option__name">
                  {org.name || org.organizationId}
                  <span className="support-console-option__id">{org.organizationId}</span>
                </span>
                <span
                  className={`support-console-badge${org.grantActive ? " support-console-badge--live" : ""}`}
                >
                  {org.grantActive ? `until ${formatExpiry(org.grantExpiresAt)}` : "no access"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
