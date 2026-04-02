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
  ITEM_CREATE: "Added",
  ITEM_EDIT: "Updated",
  ITEM_DELETE: "Deleted",
  ITEM_MOVE: "Moved",
  ITEM_RESTOCK: "Restocked",
  ITEM_QTY_ADJUST: "Adjusted qty",
  USAGE_SUBMIT: "Usage logged",
  USAGE_APPROVE: "Usage approved",
  USAGE_REJECT: "Usage rejected",
  COLUMN_CREATE: "Column added",
  COLUMN_DELETE: "Column deleted",
  COLUMN_UPDATE: "Column updated",
  CSV_IMPORT: "CSV import",
  TEMPLATE_APPLY: "Template applied",
};

// Labels for filter menu (more descriptive)
const FILTER_LABELS: Record<string, string> = {
  ITEM_CREATE: "Added item",
  ITEM_EDIT: "Updated item",
  ITEM_DELETE: "Deleted item",
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
  minQuantity: "Min",
  expirationDate: "Exp",
  orderedAt: "Ordered",
  notes: "Notes",
  position: "Position",
};

function humanizeFieldName(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  return field.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function formatFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const str = String(value);
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
  ITEM_DELETE: "var(--danger)",
  USAGE_SUBMIT: "var(--warning)",
  USAGE_APPROVE: "var(--success)",
  USAGE_REJECT: "var(--danger)",
  COLUMN_CREATE: "var(--primary)",
  COLUMN_DELETE: "var(--danger)",
  COLUMN_UPDATE: "var(--primary)",
  CSV_IMPORT: "var(--primary)",
  TEMPLATE_APPLY: "var(--primary)",
};

const ALL_ACTIONS = [
  "ITEM_CREATE", "ITEM_EDIT", "ITEM_DELETE",
  "USAGE_SUBMIT", "USAGE_APPROVE", "USAGE_REJECT",
  "COLUMN_CREATE", "COLUMN_DELETE", "COLUMN_UPDATE",
  "CSV_IMPORT", "TEMPLATE_APPLY",
];

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

function buildEventDetail(event: AuditEvent): string {
  const derivedAction = deriveAction(event);
  const details = event.details ?? {};
  const parts: string[] = [];

  if (event.action === "ITEM_EDIT") {
    const changes = Array.isArray(details.changes)
      ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
      : [];

    if (derivedAction === "ITEM_RESTOCK") {
      const qtyChange = changes.find((c) => c.field === "quantity");
      if (qtyChange) {
        const delta = Number(qtyChange.to ?? 0) - Number(qtyChange.from ?? 0);
        if (delta > 0) parts.push(`+${delta} received`);
      }
    } else if (derivedAction === "ITEM_QTY_ADJUST") {
      const qtyChange = changes.find((c) => c.field === "quantity");
      if (qtyChange) {
        parts.push(`Qty: ${formatFieldValue("quantity", qtyChange.from)} → ${formatFieldValue("quantity", qtyChange.to)}`);
      }
    } else {
      const visible = changes.filter((c) => c.field !== "position");
      for (const c of visible) {
        parts.push(`${humanizeFieldName(c.field)}: ${formatFieldValue(c.field, c.from)} → ${formatFieldValue(c.field, c.to)}`);
      }
    }
  } else if (event.action === "ITEM_CREATE") {
    const snap = (details.initialValues ?? details.snapshot ?? {}) as Record<string, unknown>;
    if (snap.quantity !== undefined && snap.quantity !== null) parts.push(`Qty: ${snap.quantity}`);
    if (snap.minQuantity !== undefined && snap.minQuantity !== null) parts.push(`Min: ${snap.minQuantity}`);
    if (snap.expirationDate) parts.push(`Exp: ${formatFieldValue("expirationDate", snap.expirationDate)}`);
  } else if (event.action === "ITEM_DELETE") {
    const snap = (details.deletedValues ?? details.snapshot ?? {}) as Record<string, unknown>;
    if (snap.quantity !== undefined && snap.quantity !== null) parts.push(`Qty: ${snap.quantity}`);
  } else if (event.action === "USAGE_SUBMIT") {
    if (details.quantityUsed !== undefined) parts.push(`Used: ${String(details.quantityUsed)}`);
    if (details.notes) parts.push(`"${String(details.notes)}"`);
  } else if (event.action === "USAGE_APPROVE") {
    parts.push(`Qty: ${String(details.quantityBefore ?? "?")} → ${String(details.quantityAfter ?? "?")} (used ${String(details.quantityUsed ?? "?")})`);
    if (details.submittedByEmail) parts.push(`by ${String(details.submittedByEmail)}`);
  } else if (event.action === "USAGE_REJECT" && details.reason) {
    parts.push(`"${String(details.reason)}"`);
  } else if (event.action === "CSV_IMPORT") {
    parts.push(`${String(details.rowsCreated ?? 0)} created, ${String(details.rowsUpdated ?? 0)} updated`);
  }

  return parts.join(" · ");
}

// ── Compact event row ─────────────────────────────────────────────────────────

function AuditEventRow({
  event,
  onViewItemHistory,
  showDate = false,
}: {
  event: AuditEvent;
  onViewItemHistory?: (itemId: string, name: string) => void;
  showDate?: boolean;
}) {
  const derivedAction = deriveAction(event);
  const actionLabel = ACTION_LABELS[derivedAction] ?? event.action;
  const color = ACTION_COLORS[derivedAction] ?? "var(--text-muted)";
  const detail = buildEventDetail(event);
  const d = new Date(event.timestamp);
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="audit-event-row">
      <span className="audit-event-row-time">
        {showDate ? formatDate(event.timestamp) : timeStr}
      </span>
      <span className="audit-event-row-action" style={{ color }}>{actionLabel}</span>
      <div className="audit-event-row-center">
        {event.itemName ? (
          <button
            type="button"
            className="audit-event-item-link"
            onClick={() => event.itemId && onViewItemHistory?.(event.itemId, event.itemName!)}
            title="View item history"
          >
            {event.itemName}
          </button>
        ) : null}
        {detail && <span className="audit-event-row-detail">{detail}</span>}
      </div>
      <span className="audit-event-row-user">
        <User size={11} />
        {event.userName || event.userEmail}
      </span>
    </div>
  );
}

// ── Day report card ───────────────────────────────────────────────────────────

const SUMMARY_ORDER: Array<[string, string]> = [
  ["ITEM_RESTOCK", "restocked"],
  ["ITEM_CREATE", "added"],
  ["ITEM_QTY_ADJUST", "adjusted"],
  ["ITEM_EDIT", "updated"],
  ["ITEM_DELETE", "deleted"],
  ["USAGE_APPROVE", "usage approved"],
  ["USAGE_SUBMIT", "usage logged"],
  ["CSV_IMPORT", "CSV import"],
  ["TEMPLATE_APPLY", "template applied"],
];

function buildDaySummary(events: AuditEvent[]): string {
  const counts: Record<string, number> = {};
  for (const e of events) {
    const a = deriveAction(e);
    counts[a] = (counts[a] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const [key, label] of SUMMARY_ORDER) {
    if (counts[key]) parts.push(`${counts[key]} ${label}`);
  }
  if (parts.length === 0) return `${events.length} event${events.length !== 1 ? "s" : ""}`;
  const shown = parts.slice(0, 3);
  if (parts.length > 3) shown.push(`+${parts.length - 3} more`);
  return shown.join(" · ");
}

function DayReport({
  label,
  events,
  onViewItemHistory,
}: {
  label: string;
  events: AuditEvent[];
  onViewItemHistory?: (itemId: string, name: string) => void;
}) {
  const uniqueUsers = new Set(events.map((e) => e.userName || e.userEmail)).size;
  const summary = buildDaySummary(events);

  return (
    <div className="audit-day-report app-card">
      <div className="audit-day-report-header">
        <span className="audit-day-report-label">{label}</span>
        <span className="audit-day-report-summary">{summary}</span>
        <span className="audit-day-report-users">
          <User size={11} />
          {uniqueUsers}
        </span>
      </div>
      <div className="audit-day-report-rows">
        {events.map((event) => (
          <AuditEventRow
            key={event.eventId}
            event={event}
            onViewItemHistory={onViewItemHistory}
          />
        ))}
      </div>
    </div>
  );
}

function groupEventsByDay(events: AuditEvent[]): Array<{ label: string; events: AuditEvent[] }> {
  const groups: Array<{ label: string; events: AuditEvent[] }> = [];
  for (const event of events) {
    const label = dayGroupLabel(event.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.events.push(event);
    } else {
      groups.push({ label, events: [event] });
    }
  }
  return groups;
}

// ── Analytics sub-components ──────────────────────────────────────────────────

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

// ── Main page ─────────────────────────────────────────────────────────────────

export function AuditLogPage({ canManageColumns }: AuditLogPageProps) {
  const [tab, setTab] = useState<AuditTab>("feed");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string[]>([]);
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [historyItemName, setHistoryItemName] = useState("");
  const [historyEvents, setHistoryEvents] = useState<AuditEvent[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [analytics, setAnalytics] = useState<AuditAnalytics | null>(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const loadFeed = useCallback(async (append = false, cursor?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const filterStr = actionFilter.length > 0 ? actionFilter.join(",") : undefined;
      const res = await fetchAuditFeed({
        limit: 50,
        ...(append && cursor ? { cursor } : {}),
        action: filterStr,
      });
      setEvents((prev) => append ? [...prev, ...(res.events ?? [])] : (res.events ?? []));
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load activity.");
    } finally {
      setLoading(false);
    }
  }, [actionFilter]);

  useEffect(() => {
    if (tab === "feed") loadFeed(false);
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

  const feedGroups = groupEventsByDay(events);
  const historyGroups = groupEventsByDay(historyEvents);

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
                      {FILTER_LABELS[action] ?? ACTION_LABELS[action]}
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

          {feedGroups.map((group) => (
            <DayReport
              key={group.label}
              label={group.label}
              events={group.events}
              onViewItemHistory={viewItemHistory}
            />
          ))}

          {loading && (
            <div className="audit-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}

          {!loading && nextCursor && events.length > 0 && (
            <button
              type="button"
              className="button button-ghost audit-load-more"
              onClick={() => loadFeed(true, nextCursor)}
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
            <Package size={18} /> {historyItemName}
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

          {historyGroups.map((group) => (
            <DayReport
              key={group.label}
              label={group.label}
              events={group.events}
            />
          ))}

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
              <SimpleBarChart data={analytics.userComparison} labelKey="name" valueKey="total" title="Activity by User" />
              <SimpleBarChart data={analytics.topItems} labelKey="itemName" valueKey="changeCount" title="Most Active Items" />
            </>
          )}
        </div>
      )}
    </section>
  );
}
