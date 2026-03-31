import { useCallback, useEffect, useState } from "react";
import {
  fetchAuditFeed,
  fetchItemHistory,
  fetchAuditAnalytics,
  type AuditEvent,
  type AuditAnalytics,
} from "../lib/inventoryApi";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  Clock,
  Filter,
  Loader2,
  Package,
  TrendingUp,
  User,
} from "lucide-react";

type AuditTab = "feed" | "analytics" | "item-history";

interface AuditLogPageProps {
  canManageColumns: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  ITEM_CREATE: "Added item",
  ITEM_EDIT: "Updated item",
  ITEM_DELETE: "Deleted item",
  ITEM_MOVE: "Moved item",
  ITEM_RESTOCK: "Restocked",
  ITEM_QTY_ADJUST: "Adjusted qty",
  USAGE_SUBMIT: "Submitted usage",
  USAGE_APPROVE: "Approved usage",
  USAGE_REJECT: "Rejected usage",
  COLUMN_CREATE: "Created column",
  COLUMN_DELETE: "Deleted column",
  COLUMN_UPDATE: "Updated column",
  CSV_IMPORT: "Imported CSV",
  TEMPLATE_APPLY: "Applied template",
};

const FIELD_LABELS: Record<string, string> = {
  itemName: "Name",
  quantity: "Qty",
  minQuantity: "Min Qty",
  expirationDate: "Expires",
  orderedAt: "Ordered At",
  notes: "Notes",
  position: "Position",
};

function humanizeFieldName(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  // camelCase → Title Case
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  const str = String(value);
  // Detect ISO date strings
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str)) {
    const isDateOnlyField = field === "expirationDate";
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    if (isDateOnlyField) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return str;
}

type DerivedAction = keyof typeof ACTION_LABELS;

function deriveAction(event: AuditEvent): DerivedAction {
  if (event.action !== "ITEM_EDIT") return event.action as DerivedAction;
  const details = event.details ?? {};
  const changes = Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
    : [];
  const fields = changes.map((c) => c.field);
  const nonPositionFields = fields.filter((f) => f !== "position");

  if (fields.length > 0 && nonPositionFields.length === 0) return "ITEM_MOVE";

  if (nonPositionFields.length === 1 && nonPositionFields[0] === "quantity") {
    const qtyChange = changes.find((c) => c.field === "quantity");
    if (qtyChange) {
      const from = Number(qtyChange.from ?? 0);
      const to = Number(qtyChange.to ?? 0);
      if (to > from) return "ITEM_RESTOCK";
      if (to < from) return "ITEM_QTY_ADJUST";
    }
  }

  return "ITEM_EDIT";
}

const ACTION_COLORS: Record<string, string> = {
  ITEM_CREATE: "var(--success)",
  ITEM_EDIT: "var(--primary)",
  ITEM_MOVE: "var(--text-muted)",
  ITEM_RESTOCK: "var(--success)",
  ITEM_QTY_ADJUST: "var(--warning)",
  ITEM_DELETE: "var(--error)",
  USAGE_SUBMIT: "var(--warning)",
  USAGE_APPROVE: "var(--success)",
  USAGE_REJECT: "var(--error)",
  COLUMN_CREATE: "var(--primary)",
  COLUMN_DELETE: "var(--error)",
  COLUMN_UPDATE: "var(--primary)",
  CSV_IMPORT: "var(--primary)",
  TEMPLATE_APPLY: "var(--primary)",
};

// Only include "real" backend actions in the filter menu (not derived display-only ones)
const ALL_ACTIONS = [
  "ITEM_CREATE", "ITEM_EDIT", "ITEM_DELETE",
  "USAGE_SUBMIT", "USAGE_APPROVE", "USAGE_REJECT",
  "COLUMN_CREATE", "COLUMN_DELETE", "COLUMN_UPDATE",
  "CSV_IMPORT", "TEMPLATE_APPLY",
];

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60000) return "just now";
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
  if (diffMs < 604800000) return `${Math.floor(diffMs / 86400000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayGroupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (eventDay.getTime() === today.getTime()) return "Today";
  if (eventDay.getTime() === yesterday.getTime()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function AuditEventCard({ event, onViewItemHistory }: { event: AuditEvent; onViewItemHistory?: (itemId: string, itemName: string) => void }) {
  const derivedAction = deriveAction(event);
  const label = ACTION_LABELS[derivedAction] ?? ACTION_LABELS[event.action] ?? event.action;
  const color = ACTION_COLORS[derivedAction] ?? ACTION_COLORS[event.action] ?? "var(--text-muted)";
  const details = event.details ?? {};

  // For ITEM_EDIT variants, filter out position changes (noise) and format fields
  const visibleChanges = event.action === "ITEM_EDIT" && Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>).filter(
        (c) => c.field !== "position"
      )
    : [];

  // Snapshot: key item state at time of event (quantity, minQuantity, expirationDate)
  const snapshot = (details.snapshot ?? {}) as Record<string, unknown>;
  // For ITEM_CREATE fall back to initialValues
  const snapshotSource: Record<string, unknown> =
    Object.keys(snapshot).length > 0
      ? snapshot
      : ((details.initialValues ?? {}) as Record<string, unknown>);
  const snapshotParts: string[] = [];
  if (snapshotSource.quantity !== undefined && snapshotSource.quantity !== null) {
    const qty = String(snapshotSource.quantity);
    const minQty = snapshotSource.minQuantity !== undefined && snapshotSource.minQuantity !== null
      ? String(snapshotSource.minQuantity)
      : null;
    snapshotParts.push(minQty ? `Qty: ${qty} (min ${minQty})` : `Qty: ${qty}`);
  }
  if (snapshotSource.expirationDate && String(snapshotSource.expirationDate).trim()) {
    snapshotParts.push(`Exp: ${formatFieldValue("expirationDate", snapshotSource.expirationDate)}`);
  }

  return (
    <div className="audit-event-card">
      <div className="audit-event-indicator" style={{ backgroundColor: color }} />
      <div className="audit-event-body">
        <div className="audit-event-header">
          <span className="audit-event-action" style={{ color }}>{label}</span>
          {event.itemName && (
            <button
              type="button"
              className="audit-event-item-link"
              onClick={() => event.itemId && onViewItemHistory?.(event.itemId, event.itemName!)}
              title="View item history"
            >
              {event.itemName}
            </button>
          )}
          <span className="audit-event-time" title={new Date(event.timestamp).toLocaleString()}>
            {formatTimestamp(event.timestamp)}
          </span>
        </div>
        <div className="audit-event-user">
          <User size={12} />
          <span>{event.userName || event.userEmail}</span>
          {snapshotParts.length > 0 && (
            <span className="audit-event-snapshot">{snapshotParts.join("  ·  ")}</span>
          )}
        </div>
        {visibleChanges.length > 0 && (
          <div className="audit-event-changes">
            {visibleChanges.map((c, i) => (
              <span key={i} className="audit-change-chip">
                <strong>{humanizeFieldName(c.field)}</strong>
                {": "}
                {formatFieldValue(c.field, c.from)} → {formatFieldValue(c.field, c.to)}
              </span>
            ))}
          </div>
        )}
        {event.action === "USAGE_SUBMIT" && (
          <div className="audit-event-changes">
            <span className="audit-change-chip">
              Used: {String(details.quantityUsed ?? "?")}
            </span>
            {details.notes ? (
              <span className="audit-change-chip">Note: {String(details.notes)}</span>
            ) : null}
          </div>
        )}
        {event.action === "USAGE_APPROVE" && (
          <div className="audit-event-changes">
            <span className="audit-change-chip">
              Qty: {String(details.quantityBefore ?? "?")} → {String(details.quantityAfter ?? "?")}
              {" "}(used {String(details.quantityUsed ?? "?")})
            </span>
            {details.submittedByEmail ? (
              <span className="audit-change-chip">By: {String(details.submittedByEmail)}</span>
            ) : null}
          </div>
        )}
        {event.action === "USAGE_REJECT" && details.reason ? (
          <div className="audit-event-changes">
            <span className="audit-change-chip">Reason: {String(details.reason)}</span>
          </div>
        ) : null}
        {event.action === "CSV_IMPORT" && (
          <div className="audit-event-changes">
            <span className="audit-change-chip">
              {String(details.rowsCreated ?? 0)} created, {String(details.rowsUpdated ?? 0)} updated
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function SimpleBarChart({ data, labelKey, valueKey, title }: {
  data: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
  title: string;
}) {
  if (!data.length) return <p className="audit-empty">No data for this period.</p>;
  const max = Math.max(...data.map((d) => Number(d[valueKey] ?? 0)), 1);

  return (
    <div className="audit-chart-card">
      <h4 className="audit-chart-title">{title}</h4>
      <div className="audit-bar-chart">
        {data.slice(0, 10).map((d, i) => {
          const val = Number(d[valueKey] ?? 0);
          const pct = Math.max((val / max) * 100, 2);
          return (
            <div key={i} className="audit-bar-row">
              <span className="audit-bar-label" title={String(d[labelKey] ?? "")}>
                {String(d[labelKey] ?? "").slice(0, 24)}
              </span>
              <div className="audit-bar-track">
                <div className="audit-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="audit-bar-value">{val}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UsageLineChart({ data }: { data: Array<{ date: string; totalUsed: number }> }) {
  if (!data.length) return <p className="audit-empty">No usage data for this period.</p>;
  const max = Math.max(...data.map((d) => d.totalUsed), 1);
  const points = data.map((d, i) => ({
    x: (i / Math.max(data.length - 1, 1)) * 100,
    y: 100 - (d.totalUsed / max) * 100,
    date: d.date,
    val: d.totalUsed,
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <div className="audit-chart-card audit-chart-card--line">
      <h4 className="audit-chart-title">Usage Over Time</h4>
      <svg className="audit-line-chart" viewBox="-5 -5 110 110" preserveAspectRatio="none">
        <path d={pathD} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="1.5" fill="var(--primary)">
            <title>{formatDate(p.date)}: {p.val} used</title>
          </circle>
        ))}
      </svg>
      <div className="audit-line-chart-labels">
        <span>{formatDate(data[0].date)}</span>
        <span>{formatDate(data[data.length - 1].date)}</span>
      </div>
    </div>
  );
}

export function AuditLogPage({ canManageColumns }: AuditLogPageProps) {
  const [tab, setTab] = useState<AuditTab>("feed");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string[]>([]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  // Item history state
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [historyItemName, setHistoryItemName] = useState("");
  const [historyEvents, setHistoryEvents] = useState<AuditEvent[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Analytics state
  const [analytics, setAnalytics] = useState<AuditAnalytics | null>(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const loadFeed = useCallback(async (append = false) => {
    setLoading(true);
    setError(null);
    try {
      const filterStr = actionFilter.length > 0 ? actionFilter.join(",") : undefined;
      const res = await fetchAuditFeed({
        limit: 50,
        startAfter: append ? (events[events.length - 1]?.timestamp ?? undefined) : undefined,
        action: filterStr,
      });
      setEvents(append ? [...events, ...(res.events ?? [])] : (res.events ?? []));
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load audit feed.");
    } finally {
      setLoading(false);
    }
  }, [actionFilter, events]);

  useEffect(() => {
    if (tab === "feed") {
      loadFeed(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, actionFilter]);

  useEffect(() => {
    if (tab === "analytics" && canManageColumns) {
      setAnalyticsLoading(true);
      fetchAuditAnalytics({ period: analyticsPeriod })
        .then(setAnalytics)
        .catch(() => setAnalytics(null))
        .finally(() => setAnalyticsLoading(false));
    }
  }, [tab, analyticsPeriod, canManageColumns]);

  const viewItemHistory = useCallback(async (itemId: string, itemName: string) => {
    setTab("item-history");
    setHistoryItemId(itemId);
    setHistoryItemName(itemName);
    setHistoryLoading(true);
    try {
      const res = await fetchItemHistory(itemId, { limit: 50 });
      setHistoryEvents(res.events ?? []);
      setHistoryCursor(res.nextCursor);
    } catch {
      setHistoryEvents([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadMoreHistory = useCallback(async () => {
    if (!historyItemId || !historyCursor) return;
    setHistoryLoading(true);
    try {
      const res = await fetchItemHistory(historyItemId, { limit: 50, cursor: historyCursor });
      setHistoryEvents((prev) => [...prev, ...res.events]);
      setHistoryCursor(res.nextCursor);
    } catch { /* ignore */ } finally {
      setHistoryLoading(false);
    }
  }, [historyItemId, historyCursor]);

  const toggleFilter = (action: string) => {
    setActionFilter((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]
    );
  };

  return (
    <section className="app-page audit-page">
      <div className="audit-tabs">
        <button
          type="button"
          className={`audit-tab${tab === "feed" ? " active" : ""}`}
          onClick={() => setTab("feed")}
        >
          <Activity size={16} /> Activity
        </button>
        {canManageColumns && (
          <button
            type="button"
            className={`audit-tab${tab === "analytics" ? " active" : ""}`}
            onClick={() => setTab("analytics")}
          >
            <BarChart3 size={16} /> Analytics
          </button>
        )}
      </div>

      {tab === "feed" && (
        <div className="audit-feed">
          <div className="audit-feed-toolbar">
            <div className="audit-filter-container">
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setShowFilterMenu(!showFilterMenu)}
              >
                <Filter size={14} />
                Filter{actionFilter.length > 0 ? ` (${actionFilter.length})` : ""}
              </button>
              {showFilterMenu && (
                <div className="audit-filter-menu">
                  {ALL_ACTIONS.map((action) => (
                    <label key={action} className="audit-filter-option">
                      <input
                        type="checkbox"
                        checked={actionFilter.includes(action)}
                        onChange={() => toggleFilter(action)}
                      />
                      {ACTION_LABELS[action]}
                    </label>
                  ))}
                  {actionFilter.length > 0 && (
                    <button
                      type="button"
                      className="button button-ghost button-sm"
                      onClick={() => setActionFilter([])}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {error && <p className="audit-error">{error}</p>}

          {!loading && events.length === 0 && (
            <div className="audit-empty-state">
              <Clock size={32} />
              <p>No activity recorded yet.</p>
              <p className="audit-empty-hint">Changes to inventory, usage approvals, and column edits will appear here.</p>
            </div>
          )}

          {events.map((event, i) => {
            const label = dayGroupLabel(event.timestamp);
            const prevLabel = i > 0 ? dayGroupLabel(events[i - 1].timestamp) : null;
            const showGroup = label !== prevLabel;
            return (
              <div key={event.eventId}>
                {showGroup && <div className="audit-day-group">{label}</div>}
                <AuditEventCard event={event} onViewItemHistory={viewItemHistory} />
              </div>
            );
          })}

          {loading && (
            <div className="audit-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}

          {!loading && nextCursor && events.length > 0 && (
            <button
              type="button"
              className="button button-ghost audit-load-more"
              onClick={() => loadFeed(true)}
            >
              Load more
            </button>
          )}
        </div>
      )}

      {tab === "item-history" && (
        <div className="audit-feed">
          <button
            type="button"
            className="button button-ghost button-sm audit-back-btn"
            onClick={() => setTab("feed")}
          >
            <ChevronLeft size={14} /> Back to Activity
          </button>
          <h3 className="audit-item-history-title">
            <Package size={18} /> History: {historyItemName}
          </h3>

          {historyLoading && historyEvents.length === 0 && (
            <div className="audit-loading"><Loader2 size={20} className="spin" /></div>
          )}

          {!historyLoading && historyEvents.length === 0 && (
            <div className="audit-empty-state">
              <Clock size={32} />
              <p>No history for this item.</p>
            </div>
          )}

          {historyEvents.map((event, i) => {
            const label = dayGroupLabel(event.timestamp);
            const prevLabel = i > 0 ? dayGroupLabel(historyEvents[i - 1].timestamp) : null;
            const showGroup = label !== prevLabel;
            return (
              <div key={event.eventId}>
                {showGroup && <div className="audit-day-group">{label}</div>}
                <AuditEventCard event={event} />
              </div>
            );
          })}

          {!historyLoading && historyCursor && (
            <button
              type="button"
              className="button button-ghost audit-load-more"
              onClick={loadMoreHistory}
            >
              Load more
            </button>
          )}
        </div>
      )}

      {tab === "analytics" && canManageColumns && (
        <div className="audit-analytics">
          <div className="audit-period-selector">
            {(["7d", "30d", "90d"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`button button-sm${analyticsPeriod === p ? " button-primary" : " button-ghost"}`}
                onClick={() => setAnalyticsPeriod(p)}
              >
                {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
              </button>
            ))}
          </div>

          {analyticsLoading && (
            <div className="audit-loading"><Loader2 size={20} className="spin" /></div>
          )}

          {!analyticsLoading && analytics && (
            <>
              <div className="audit-analytics-summary">
                <div className="audit-stat-card">
                  <TrendingUp size={20} />
                  <div>
                    <span className="audit-stat-value">{analytics.totalEvents}</span>
                    <span className="audit-stat-label">Total Events</span>
                  </div>
                </div>
              </div>

              <UsageLineChart data={analytics.usageOverTime} />

              <SimpleBarChart
                data={analytics.userComparison}
                labelKey="name"
                valueKey="total"
                title="Activity by User"
              />

              <SimpleBarChart
                data={analytics.topItems}
                labelKey="itemName"
                valueKey="changeCount"
                title="Most Active Items"
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
