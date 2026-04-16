import { useCallback, useEffect, useState } from "react";
import {
  approveUsageSubmission,
  deleteUsageSubmission,
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
  CheckSquare,
  Clock,
  Filter,
  Loader2,
  Package,
  TrendingUp,
  User,
} from "lucide-react";
import { usePendingSubmissions } from "./inventory/hooks/usePendingSubmissions";
import { PendingSubmissionsTab } from "./inventory/PendingSubmissionsTab";
import type { PendingEntry } from "./inventory/inventoryTypes";

type AuditTab = "feed" | "analytics" | "item-history" | "pending";

interface AuditLogPageProps {
  canManageColumns: boolean;
  canReviewSubmissions?: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  ITEM_CREATE: "Added",
  ITEM_EDIT: "Updated",
  ITEM_DELETE: "Deleted",
  ITEM_MOVE: "Moved",
  ITEM_RESTOCK: "Restocked",
  ITEM_QTY_ADJUST: "Adjusted qty",
  ITEM_RETIRE: "Retired",
  USAGE_SUBMIT: "Usage logged",
  USAGE_APPROVE: "Usage approved",
  USAGE_REJECT: "Usage rejected",
  COLUMN_CREATE: "Column added",
  COLUMN_DELETE: "Column deleted",
  COLUMN_UPDATE: "Column updated",
  CSV_IMPORT: "CSV import",
  TEMPLATE_APPLY: "Template applied",
  RESTOCK_ORDER_CREATE: "Order placed",
  RESTOCK_RECEIVED: "Order received",
  RESTOCK_ORDER_CLOSED: "Order closed",
  RESTOCK_ADDED: "Fast restock",
};

// Labels for filter menu (more descriptive)
const FILTER_LABELS: Record<string, string> = {
  ITEM_CREATE: "Added item",
  ITEM_EDIT: "Updated item",
  ITEM_DELETE: "Deleted item",
  ITEM_RETIRE: "Retired item",
  USAGE_SUBMIT: "Submitted usage",
  USAGE_APPROVE: "Approved usage",
  USAGE_REJECT: "Rejected usage",
  COLUMN_CREATE: "Created column",
  COLUMN_DELETE: "Deleted column",
  COLUMN_UPDATE: "Updated column",
  CSV_IMPORT: "Imported CSV",
  TEMPLATE_APPLY: "Applied template",
  RESTOCK_ORDER_CREATE: "Placed restock order",
  RESTOCK_RECEIVED: "Received restock order",
  RESTOCK_ORDER_CLOSED: "Closed restock order",
  RESTOCK_ADDED: "Fast restock",
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

// Machine-managed valuesJson keys. Stamped by the server during save — they
// carry no user-visible semantics so they must never render as "field changed"
// rows in the activity feed. Also used to drop events whose ONLY change is one
// of these (e.g. the one-time parentItemId backfill on legacy rows).
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
]);

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
  const rawChanges = Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
    : [];
  // Ignore system-field stamps for the purpose of classifying the edit.
  const changes = rawChanges.filter((c) => !SYSTEM_FIELDS.has(c.field));
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

/**
 * True when an event carries no user-visible information and should be hidden
 * from the activity feed — notably ITEM_EDIT events whose only change is a
 * system-field stamp (parentItemId backfill, retiredAt markers, etc.).
 *
 * Mirrors the server-side filter in routes/audit.ts `isNoiseAuditItem`. The
 * server does the heavy lifting so pagination stays correct; this is a safety
 * net for any noise that slipped through before the server filter landed.
 */
function isNoiseEvent(event: AuditEvent): boolean {
  if (event.action !== "ITEM_EDIT") return false;
  const details = event.details ?? {};
  const rawChanges = Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
    : [];
  // Empty-changes edits are unusual but keep them — they may carry context we
  // haven't anticipated. We only suppress edits where every change is a known
  // system field.
  if (rawChanges.length === 0) return false;
  return rawChanges.every((c) => SYSTEM_FIELDS.has(c.field));
}

const ACTION_COLORS: Record<string, string> = {
  ITEM_CREATE: "var(--success)",
  ITEM_EDIT: "var(--primary)",
  ITEM_MOVE: "var(--text-muted)",
  ITEM_RESTOCK: "var(--success)",
  ITEM_QTY_ADJUST: "var(--warning)",
  ITEM_DELETE: "var(--danger)",
  ITEM_RETIRE: "var(--danger)",
  USAGE_SUBMIT: "var(--warning)",
  USAGE_APPROVE: "var(--success)",
  USAGE_REJECT: "var(--danger)",
  COLUMN_CREATE: "var(--primary)",
  COLUMN_DELETE: "var(--danger)",
  COLUMN_UPDATE: "var(--primary)",
  CSV_IMPORT: "var(--primary)",
  TEMPLATE_APPLY: "var(--primary)",
  RESTOCK_ORDER_CREATE: "var(--primary)",
  RESTOCK_RECEIVED: "var(--success)",
  RESTOCK_ORDER_CLOSED: "var(--text-muted)",
  RESTOCK_ADDED: "var(--success)",
};

const ALL_ACTIONS = [
  "ITEM_CREATE", "ITEM_EDIT", "ITEM_DELETE", "ITEM_RETIRE",
  "USAGE_SUBMIT", "USAGE_APPROVE", "USAGE_REJECT",
  "RESTOCK_ORDER_CREATE", "RESTOCK_RECEIVED", "RESTOCK_ORDER_CLOSED", "RESTOCK_ADDED",
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
    const rawChanges = Array.isArray(details.changes)
      ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
      : [];
    // Strip system-field stamps so they never render as "Parent Item Id: — → …"
    const changes = rawChanges.filter((c) => !SYSTEM_FIELDS.has(c.field));

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
  } else if (event.action === "ITEM_RETIRE") {
    const reason = typeof details.reason === "string" ? String(details.reason) : "";
    if (reason) parts.push(`Reason: ${reason}`);
    if (details.qty !== undefined) parts.push(`Qty: ${String(details.qty)}`);
  } else if (event.action === "RESTOCK_ORDER_CREATE") {
    if (details.qtyOrdered !== undefined) parts.push(`Ordered: ${String(details.qtyOrdered)}`);
    if (details.vendor) parts.push(`Vendor: ${String(details.vendor)}`);
  } else if (event.action === "RESTOCK_RECEIVED") {
    if (details.qtyReceived !== undefined) parts.push(`Received: ${String(details.qtyReceived)}`);
    if (details.vendor) parts.push(`Vendor: ${String(details.vendor)}`);
  } else if (event.action === "RESTOCK_ADDED") {
    if (details.qtyDelta !== undefined) parts.push(`+${String(details.qtyDelta)}`);
    if (details.vendor) parts.push(`Vendor: ${String(details.vendor)}`);
    if (details.source && details.source !== "supplier") parts.push(String(details.source));
  } else if (event.action === "RESTOCK_ORDER_CLOSED") {
    if (details.closedManually) parts.push("Closed manually");
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

// ── Restock order grouping ────────────────────────────────────────────────────
// Restock orders emit one audit event per line item. In the activity feed we
// collapse contiguous same-order events into a single expandable row so a
// 10-item order reads as "Bekah placed restock order (10 items)" instead of
// spamming ten rows. Per-item events are still preserved under the fold and
// available to analytics queries.

const GROUPABLE_ACTIONS = new Set([
  "RESTOCK_ORDER_CREATE",
  "RESTOCK_RECEIVED",
]);

type OrderGroup = {
  kind: "order-group";
  groupId: string;
  action: string;
  orderId: string;
  events: AuditEvent[];
  representative: AuditEvent;
};

type DisplayRow =
  | { kind: "event"; event: AuditEvent }
  | OrderGroup;

function groupRestockEvents(events: AuditEvent[]): DisplayRow[] {
  // Bucket groupable events by {action, orderId}. Non-groupable events and
  // events without an orderId pass through as singletons, preserving order
  // via an insertion-index fallback.
  type Bucket = { rows: AuditEvent[]; firstIndex: number };
  const buckets = new Map<string, Bucket>();
  const flat: Array<{ index: number; row: DisplayRow }> = [];

  events.forEach((event, idx) => {
    const orderId = typeof event.details?.orderId === "string"
      ? String(event.details.orderId)
      : "";
    if (GROUPABLE_ACTIONS.has(event.action) && orderId) {
      const key = `${event.action}:${orderId}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.rows.push(event);
      } else {
        buckets.set(key, { rows: [event], firstIndex: idx });
        flat.push({
          index: idx,
          row: {
            kind: "order-group",
            groupId: key,
            action: event.action,
            orderId,
            events: [],
            representative: event,
          },
        });
      }
      return;
    }
    flat.push({ index: idx, row: { kind: "event", event } });
  });

  // Fill the groups with their accumulated events.
  for (const entry of flat) {
    if (entry.row.kind !== "order-group") continue;
    const bucket = buckets.get(entry.row.groupId);
    if (bucket) entry.row.events = bucket.rows;
  }
  return flat.map((e) => e.row);
}

function OrderGroupRow({
  group,
  onViewItemHistory,
  showDate = false,
}: {
  group: OrderGroup;
  onViewItemHistory?: (itemId: string, name: string) => void;
  showDate?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = group.events.length;
  const representative = group.representative;
  const actionLabel = ACTION_LABELS[group.action] ?? group.action;
  const color = ACTION_COLORS[group.action] ?? "var(--text-muted)";
  const d = new Date(representative.timestamp);
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const details = representative.details ?? {};
  const vendor = typeof details.vendor === "string" ? details.vendor : "";

  // Aggregate qty + cost across the grouped events.
  let totalQty = 0;
  let totalCost = 0;
  let hasCost = false;
  for (const ev of group.events) {
    const dd = ev.details ?? {};
    const qty = Number(
      group.action === "RESTOCK_RECEIVED" ? dd.qtyReceived : dd.qtyOrdered,
    );
    const unitCost = Number(dd.unitCost);
    if (Number.isFinite(qty)) totalQty += qty;
    if (Number.isFinite(qty) && Number.isFinite(unitCost)) {
      totalCost += qty * unitCost;
      hasCost = true;
    }
  }

  const summaryParts: string[] = [];
  summaryParts.push(`${count} item${count !== 1 ? "s" : ""}`);
  if (totalQty > 0) summaryParts.push(`qty ${totalQty}`);
  if (hasCost) summaryParts.push(`$${totalCost.toFixed(2)}`);
  if (vendor) summaryParts.push(`vendor: ${vendor}`);

  return (
    <div className="audit-event-row audit-event-row--group">
      <span className="audit-event-row-time">
        {showDate ? formatDate(representative.timestamp) : timeStr}
      </span>
      <span className="audit-event-row-action" style={{ color }}>{actionLabel}</span>
      <div className="audit-event-row-center">
        <button
          type="button"
          className="audit-event-item-link audit-event-group-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Collapse line items" : "Expand line items"}
        >
          {expanded ? "▾" : "▸"} Order #{group.orderId.slice(0, 8)}
        </button>
        <span className="audit-event-row-detail">{summaryParts.join(" · ")}</span>
      </div>
      <span className="audit-event-row-user">
        <User size={11} />
        {representative.userName || representative.userEmail}
      </span>
      {expanded ? (
        <div className="audit-event-group-children">
          {group.events.map((child) => (
            <AuditEventRow
              key={child.eventId}
              event={child}
              onViewItemHistory={onViewItemHistory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Day report card ───────────────────────────────────────────────────────────

const SUMMARY_ORDER: Array<[string, string]> = [
  ["RESTOCK_ORDER_CREATE", "orders placed"],
  ["RESTOCK_RECEIVED", "orders received"],
  ["RESTOCK_ADDED", "fast restocks"],
  ["ITEM_RESTOCK", "restocked"],
  ["ITEM_CREATE", "added"],
  ["ITEM_RETIRE", "retired"],
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
  // Track unique orderIds for groupable restock actions so a 10-item order
  // counts as "1 order placed", not 10.
  const seenOrderIds: Record<string, Set<string>> = {};
  for (const e of events) {
    const a = deriveAction(e);
    if (GROUPABLE_ACTIONS.has(a)) {
      const orderId = typeof e.details?.orderId === "string" ? String(e.details.orderId) : "";
      if (orderId) {
        const bucket = seenOrderIds[a] ?? (seenOrderIds[a] = new Set());
        if (bucket.has(orderId)) continue;
        bucket.add(orderId);
      }
    }
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
  const displayRows = groupRestockEvents(events);

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
        {displayRows.map((row) =>
          row.kind === "order-group" ? (
            <OrderGroupRow
              key={row.groupId}
              group={row}
              onViewItemHistory={onViewItemHistory}
            />
          ) : (
            <AuditEventRow
              key={row.event.eventId}
              event={row.event}
              onViewItemHistory={onViewItemHistory}
            />
          ),
        )}
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

export function AuditLogPage({ canManageColumns, canReviewSubmissions }: AuditLogPageProps) {
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

  // Pending usage-approval queue (only loaded for reviewers)
  const pending = usePendingSubmissions(tab === "pending", canReviewSubmissions);
  const pendingCount = pending.pendingSubmissions.length;
  const buildPendingEntryLabel = (entry: PendingEntry) => entry.itemName;

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

  // Strip system-field-only ITEM_EDIT events before display. Without this, the
  // one-time parentItemId backfill on every legacy row floods the feed with
  // "Parent Item Id: — → {uuid}" rows — pure machine noise.
  const visibleEvents = events.filter((e) => !isNoiseEvent(e));
  const visibleHistoryEvents = historyEvents.filter((e) => !isNoiseEvent(e));
  const feedGroups = groupEventsByDay(visibleEvents);
  const historyGroups = groupEventsByDay(visibleHistoryEvents);

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
        {canReviewSubmissions && (
          <button
            type="button"
            className={`audit-tab${tab === "pending" ? " active" : ""}`}
            onClick={() => setTab("pending")}
          >
            <CheckSquare size={16} /> Pending
            {pendingCount > 0 ? (
              <span className="audit-tab-badge">{pendingCount}</span>
            ) : null}
          </button>
        )}
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

      {tab === "pending" && canReviewSubmissions && (
        <PendingSubmissionsTab
          submissions={pending.pendingSubmissions}
          loading={pending.pendingLoading}
          error={pending.pendingError}
          mergedItems={pending.mergedPendingItems}
          approvingAll={pending.approvingAll}
          approveAllError={pending.approveAllError}
          editedQtys={pending.editedQtys}
          onEditQty={(submissionId, entryIndex, value) =>
            pending.setEditedQtys((prev) => ({
              ...prev,
              [submissionId]: { ...(prev[submissionId] ?? {}), [entryIndex]: value },
            }))
          }
          onApprove={async (submissionId, effectiveEntries) => {
            await approveUsageSubmission(submissionId, effectiveEntries);
            pending.setPendingSubmissions((prev) =>
              prev.filter((s) => s.id !== submissionId),
            );
          }}
          onApproveAll={async () => {
            pending.setApprovingAll(true);
            pending.setApproveAllError("");
            try {
              for (const sub of pending.pendingSubmissions) {
                await approveUsageSubmission(sub.id);
              }
              pending.setPendingSubmissions([]);
            } catch (err: any) {
              pending.setApproveAllError(err?.message ?? "Failed to approve all");
            } finally {
              pending.setApprovingAll(false);
            }
          }}
          onDelete={async (submissionId) => {
            await deleteUsageSubmission(submissionId);
            pending.setPendingSubmissions((prev) =>
              prev.filter((s) => s.id !== submissionId),
            );
          }}
          buildLabel={buildPendingEntryLabel}
        />
      )}

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
