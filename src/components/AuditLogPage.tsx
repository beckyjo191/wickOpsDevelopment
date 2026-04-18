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
  ChevronRight,
  CheckSquare,
  Clock,
  Loader2,
  Package,
  Search,
  User,
} from "lucide-react";
import { usePendingSubmissions } from "./inventory/hooks/usePendingSubmissions";
import { PendingSubmissionsTab } from "./inventory/PendingSubmissionsTab";
import type { PendingEntry } from "./inventory/inventoryTypes";
import { formatCurrency, isCurrencyColumnKey } from "../lib/currency";

type AuditTab = "feed" | "analytics" | "item-history" | "pending";

interface AuditLogPageProps {
  canManageColumns: boolean;
  canReviewSubmissions?: boolean;
  /** Called when the user clicks "Open in Inventory" from the item-history
   *  view. Parent handles switching to the Inventory tab and focusing the row.
   *  Passes the item name rather than id because we filter inventory via
   *  search term — robust across lots + renames. */
  onOpenInInventory?: (itemName: string) => void;
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
// of these (parentItemId backfill on legacy rows, orderedAt flips from the
// restock flow, retire markers, etc.). Kept in sync with routes/audit.ts.
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
  "orderedAt",
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

/** True when every value is empty / zero / null — i.e. a blank row. */
function isAllDefaultValues(vals: Record<string, unknown>): boolean {
  const entries = Object.entries(vals);
  if (entries.length === 0) return true;
  return entries.every(([, v]) => v === null || v === undefined || v === "" || v === 0);
}

/**
 * True when an event carries no user-visible information and should be hidden
 * from the activity feed. Two flavours:
 *   - ITEM_EDIT whose only changes are machine-managed system fields (the
 *     parentItemId backfill noise, retiredAt markers, etc.).
 *   - ITEM_DELETE of a row that never had content (accidentally created blank
 *     row that got cleaned up) — shows up as "Deleted · Qty: 0" with no name.
 *
 * Mirrors the server-side filter in routes/audit.ts `isNoiseAuditItem`. The
 * server does the heavy lifting so pagination stays correct; this is a safety
 * net for any noise that slipped through before the server filter landed.
 */
function isNoiseEvent(event: AuditEvent): boolean {
  const details = event.details ?? {};
  if (event.action === "ITEM_EDIT") {
    const rawChanges = Array.isArray(details.changes)
      ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
      : [];
    // Empty-changes edits are unusual but keep them — they may carry context we
    // haven't anticipated. We only suppress edits where every change is a known
    // system field.
    if (rawChanges.length === 0) return false;
    return rawChanges.every((c) => SYSTEM_FIELDS.has(c.field));
  }
  if (event.action === "ITEM_DELETE") {
    if (event.itemName && String(event.itemName).trim().length > 0) return false;
    const deletedValues = (details.deletedValues && typeof details.deletedValues === "object")
      ? (details.deletedValues as Record<string, unknown>)
      : null;
    if (!deletedValues) return true;
    return isAllDefaultValues(deletedValues);
  }
  if (event.action === "RESTOCK_ORDER_CLOSED") {
    // An auto-close from a full receive is redundant with the RESTOCK_RECEIVED
    // events already in the feed. Only keep the close event when the user
    // closed the order deliberately (cancelled, or closed a partial receive).
    return details.closedManually !== true;
  }
  return false;
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

function getVisibleEditChanges(event: AuditEvent): Array<{ field: string; from: unknown; to: unknown }> {
  if (event.action !== "ITEM_EDIT") return [];
  const details = event.details ?? {};
  const raw = Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
    : [];
  return raw.filter((c) => !SYSTEM_FIELDS.has(c.field) && c.field !== "position");
}


// ── Flat activity feed ────────────────────────────────────────────────────────
// Single zoom level — each row is a self-contained sentence. No expansion
// disclosure; long values (URLs) collapse to their domain with the full value
// available via tooltip. Days are collapsible — today open, older collapsed.

/** Compact value formatter for inline display in row summaries.
 *  - URLs collapse to their hostname (full URL on hover via title attr)
 *  - Long strings truncate to 28 chars + ellipsis
 *  - Dates/numbers passed through formatFieldValue for consistent date rendering
 */
function formatValueCompact(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const str = String(value).trim();
  if (isCurrencyColumnKey(field)) {
    const n = Number(str);
    if (Number.isFinite(n)) return formatCurrency(n);
  }
  if (/^https?:\/\//i.test(str)) {
    try {
      return new URL(str).hostname.replace(/^www\./, "");
    } catch {
      return str.length > 28 ? str.slice(0, 26) + "…" : str;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return formatFieldValue(field, str);
  if (str.length > 28) return str.slice(0, 26) + "…";
  return str;
}

/** Self-contained sentence describing an event. Includes the action context
 *  AND inline values, so no separate "action" column or disclosure is needed.
 *  The day grouping + item name (in the main feed) supply the rest of the
 *  context. */
function buildRichRowSummary(event: AuditEvent): string {
  const derived = deriveAction(event);
  const details = event.details ?? {};

  if (derived === "ITEM_RESTOCK") {
    const q = getVisibleEditChanges(event).find((c) => c.field === "quantity");
    if (q) {
      const delta = Number(q.to ?? 0) - Number(q.from ?? 0);
      if (delta > 0) return `Restocked +${delta}`;
    }
    return "Restocked";
  }
  if (derived === "ITEM_QTY_ADJUST") {
    const q = getVisibleEditChanges(event).find((c) => c.field === "quantity");
    if (q) return `Qty ${formatFieldValue("quantity", q.from)} → ${formatFieldValue("quantity", q.to)}`;
    return "Adjusted qty";
  }
  if (derived === "ITEM_EDIT") {
    const changes = getVisibleEditChanges(event);
    if (changes.length === 0) return "Updated";
    const parts = changes.map((c) => `${humanizeFieldName(c.field)} (${formatValueCompact(c.field, c.to)})`);
    return `Updated ${parts.join(", ")}`;
  }
  if (derived === "ITEM_CREATE") {
    const snap = (details.initialValues ?? details.snapshot ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if (snap.quantity !== undefined && snap.quantity !== null) parts.push(`Qty ${snap.quantity}`);
    if (snap.minQuantity !== undefined && snap.minQuantity !== null) parts.push(`Min ${snap.minQuantity}`);
    return parts.length > 0 ? `Added (${parts.join(", ")})` : "Added";
  }
  if (derived === "ITEM_RETIRE") {
    const reason = typeof details.reason === "string" ? details.reason : "";
    return reason ? `Retired (${reason})` : "Retired";
  }
  if (derived === "ITEM_DELETE") return "Deleted";
  if (derived === "ITEM_MOVE") return "Reordered";
  if (derived === "RESTOCK_ORDER_CREATE") {
    const qty = details.qtyOrdered;
    const vendor = typeof details.vendor === "string" ? details.vendor : "";
    if (qty !== undefined && vendor) return `Ordered ${qty} from ${vendor}`;
    if (qty !== undefined) return `Ordered ${qty}`;
    return "Order placed";
  }
  if (derived === "RESTOCK_RECEIVED") {
    const qty = details.qtyReceived;
    return qty !== undefined ? `Received ${qty}` : "Order received";
  }
  if (derived === "RESTOCK_ORDER_CLOSED") return "Order closed";
  if (derived === "RESTOCK_ADDED") {
    const delta = details.qtyDelta;
    const vendor = typeof details.vendor === "string" ? details.vendor : "";
    if (delta !== undefined && vendor) return `Fast restock +${delta} from ${vendor}`;
    if (delta !== undefined) return `Fast restock +${delta}`;
    return "Fast restock";
  }
  if (derived === "USAGE_SUBMIT") {
    const used = details.quantityUsed;
    return used !== undefined ? `Logged usage of ${used}` : "Usage logged";
  }
  if (derived === "USAGE_APPROVE") {
    const used = details.quantityUsed;
    if (used !== undefined) return `Approved usage of ${used}`;
    return "Usage approved";
  }
  if (derived === "USAGE_REJECT") {
    const reason = typeof details.reason === "string" ? details.reason : "";
    return reason ? `Rejected usage (${reason})` : "Usage rejected";
  }
  if (derived === "CSV_IMPORT") {
    const c = details.rowsCreated ?? 0;
    const u = details.rowsUpdated ?? 0;
    return `CSV import: ${c} created, ${u} updated`;
  }
  if (derived === "TEMPLATE_APPLY") return "Template applied";
  if (derived === "COLUMN_CREATE") return "Column added";
  if (derived === "COLUMN_DELETE") return "Column deleted";
  if (derived === "COLUMN_UPDATE") return "Column updated";
  return ACTION_LABELS[derived] ?? derived;
}

/** Returns a URL for the event if it has one (currently just ITEM_EDIT
 *  events that touch the reorderLink field). Used to build the title attr
 *  so users can hover the row to see the full URL behind a `boundtree.com`. */
function eventTitleAttr(event: AuditEvent): string | undefined {
  if (event.action !== "ITEM_EDIT") return undefined;
  const linkChange = getVisibleEditChanges(event).find((c) => c.field === "reorderLink");
  if (!linkChange) return undefined;
  const v = String(linkChange.to ?? "").trim();
  return v || undefined;
}

type DayBucket<T> = { label: string; rows: T[]; users: Set<string> };

function groupByDay<T>(items: Array<T & { timestamp: string; user: string }>): Array<DayBucket<T>> {
  const days: Array<DayBucket<T>> = [];
  for (const item of items) {
    const label = dayGroupLabel(item.timestamp);
    let day = days[days.length - 1];
    if (!day || day.label !== label) {
      day = { label, rows: [], users: new Set() };
      days.push(day);
    }
    day.rows.push(item);
    if (item.user) day.users.add(item.user);
  }
  return days;
}

/** Collapsible day section. Today's section opens by default, older days
 *  collapse — when collapsed the header shows a "N changes, M users" summary
 *  so the user can scan history without expanding. */
function DaySection({
  label,
  rowCount,
  userCount,
  defaultOpen,
  children,
}: {
  label: string;
  rowCount: number;
  userCount: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button
        type="button"
        className="audit-flat-day-divider audit-flat-day-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="audit-flat-day-chevron">{open ? "▾" : "▸"}</span>
        <span className="audit-flat-day-label">{label}</span>
        <span className="audit-flat-day-summary">
          {rowCount} change{rowCount !== 1 ? "s" : ""}
          {userCount > 0 ? ` · ${userCount} user${userCount !== 1 ? "s" : ""}` : ""}
        </span>
      </button>
      {open ? children : null}
    </>
  );
}

/** Per-(day, item) row data for the main activity feed. */
type ActivityRowData = {
  key: string;
  timestamp: string;
  itemId: string | null;
  itemName: string;
  summary: string;
  accentColor: string;
  user: string;
  titleAttr?: string;
};

function aggregateActivityRows(events: AuditEvent[]): Array<DayBucket<ActivityRowData>> {
  type Bucket = {
    events: AuditEvent[];
    lastTimestamp: string;
    actions: Set<string>;
    users: Set<string>;
    itemId: string | null;
    itemName: string;
  };
  type DayAcc = { label: string; keyOrder: string[]; buckets: Map<string, Bucket> };
  const dayAccs: DayAcc[] = [];
  let currentDay: DayAcc | null = null;
  for (const e of events) {
    const label = dayGroupLabel(e.timestamp);
    if (!currentDay || currentDay.label !== label) {
      currentDay = { label, keyOrder: [], buckets: new Map() };
      dayAccs.push(currentDay);
    }
    const itemId = e.itemId ? String(e.itemId) : null;
    const rowKey = itemId ?? `event:${e.eventId}`;
    let bucket = currentDay.buckets.get(rowKey);
    if (!bucket) {
      bucket = {
        events: [],
        lastTimestamp: e.timestamp,
        actions: new Set(),
        users: new Set(),
        itemId,
        itemName: String(e.itemName ?? "").trim(),
      };
      currentDay.buckets.set(rowKey, bucket);
      currentDay.keyOrder.push(rowKey);
    }
    bucket.events.push(e);
    if (e.timestamp > bucket.lastTimestamp) bucket.lastTimestamp = e.timestamp;
    bucket.actions.add(deriveAction(e));
    const u = e.userName || e.userEmail;
    if (u) bucket.users.add(u);
    if (!bucket.itemName && e.itemName) bucket.itemName = String(e.itemName).trim();
  }

  const days: Array<DayBucket<ActivityRowData>> = [];
  for (const d of dayAccs) {
    const day: DayBucket<ActivityRowData> = { label: d.label, rows: [], users: new Set() };
    for (const rowKey of d.keyOrder) {
      const bucket = d.buckets.get(rowKey)!;
      const summary = bucket.events.length === 1
        ? buildRichRowSummary(bucket.events[0])
        : bucket.events.map(buildRichRowSummary).join(" · ");
      const titleAttr = bucket.events.length === 1 ? eventTitleAttr(bucket.events[0]) : undefined;
      const actionList = Array.from(bucket.actions);
      const accentColor = actionList.length === 1
        ? (ACTION_COLORS[actionList[0]] ?? "var(--text-muted)")
        : "var(--text-muted)";
      const userArr = Array.from(bucket.users);
      const userLabel = userArr.length === 0
        ? "—"
        : userArr.length === 1
          ? userArr[0]
          : `${userArr.length} users`;
      day.rows.push({
        key: `${d.label}::${rowKey}`,
        timestamp: bucket.lastTimestamp,
        itemId: bucket.itemId,
        itemName: bucket.itemName || "—",
        summary,
        accentColor,
        user: userLabel,
        titleAttr,
      });
      for (const u of bucket.users) day.users.add(u);
    }
    days.push(day);
  }
  return days;
}

function FlatActivityFeed({
  events,
  onViewItemHistory,
}: {
  events: AuditEvent[];
  onViewItemHistory: (itemId: string, name: string) => void;
}) {
  const days = aggregateActivityRows(events);
  return (
    <div className="audit-flat-feed">
      {days.map((day) => (
        <DaySection
          key={day.label}
          label={day.label}
          rowCount={day.rows.length}
          userCount={day.users.size}
          defaultOpen={day.label === "Today" || day.label === "Yesterday"}
        >
          {day.rows.map((row) => {
            const time = new Date(row.timestamp).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            });
            const navigable = !!row.itemId && row.itemName !== "—";
            return (
              <button
                key={row.key}
                type="button"
                className="audit-flat-row"
                style={{ ["--row-accent" as string]: row.accentColor }}
                onClick={() => navigable && onViewItemHistory(row.itemId!, row.itemName)}
                disabled={!navigable}
                title={row.titleAttr ?? (navigable ? `View history for ${row.itemName}` : undefined)}
              >
                <span className="audit-flat-cell audit-flat-time">{time}</span>
                <span className="audit-flat-cell audit-flat-content">
                  <span className="audit-flat-itemname">{row.itemName}</span>
                  <span className="audit-flat-summary"> — {row.summary}</span>
                </span>
                <span className="audit-flat-cell audit-flat-user">
                  <User size={11} />
                  {row.user}
                </span>
              </button>
            );
          })}
        </DaySection>
      ))}
    </div>
  );
}

/** Item history flat list — single item, so no item name column. Each event
 *  is one inline-summary row; no expansion, no disclosure. Day collapsibility
 *  matches the main feed. */
function FlatItemHistory({ events }: { events: AuditEvent[] }) {
  type HistoryRowData = {
    key: string;
    timestamp: string;
    summary: string;
    accentColor: string;
    user: string;
    titleAttr?: string;
  };
  const items: Array<HistoryRowData & { timestamp: string; user: string }> = events.map((e) => {
    const derived = deriveAction(e);
    return {
      key: e.eventId,
      timestamp: e.timestamp,
      summary: buildRichRowSummary(e),
      accentColor: ACTION_COLORS[derived] ?? "var(--text-muted)",
      user: e.userName || e.userEmail || "—",
      titleAttr: eventTitleAttr(e),
    };
  });
  const days = groupByDay(items);

  return (
    <div className="audit-flat-feed audit-flat-feed--history">
      {days.map((day) => (
        <DaySection
          key={day.label}
          label={day.label}
          rowCount={day.rows.length}
          userCount={day.users.size}
          defaultOpen={day.label === "Today" || day.label === "Yesterday"}
        >
          {day.rows.map((row) => {
            const time = new Date(row.timestamp).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            });
            return (
              <div
                key={row.key}
                className="audit-flat-row audit-flat-row--history audit-flat-row--static"
                style={{ ["--row-accent" as string]: row.accentColor }}
                title={row.titleAttr}
              >
                <span className="audit-flat-cell audit-flat-time">{time}</span>
                <span className="audit-flat-cell audit-flat-summary audit-flat-summary--solo">
                  {row.summary}
                </span>
                <span className="audit-flat-cell audit-flat-user">
                  <User size={11} />
                  {row.user}
                </span>
              </div>
            );
          })}
        </DaySection>
      ))}
    </div>
  );
}

// ── Analytics sub-components ──────────────────────────────────────────────────

/** Formats a number as USD. Keeps decimals for values under $100, rounds above. */
function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${Math.round(value).toLocaleString()}`;
  if (abs >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString();
}

const REASON_LABELS: Record<string, string> = {
  expired: "Expired",
  damaged: "Damaged",
  lost: "Lost",
  recalled: "Recalled",
  donated: "Donated",
  unknown: "Unknown",
};

function SimpleBarChart({ data, labelKey, valueKey, title, formatValue }: {
  data: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
  title: string;
  /** Optional value formatter — defaults to integer toLocaleString. */
  formatValue?: (value: number) => string;
}) {
  if (!data.length) return (
    <div className="audit-chart-card">
      <h4 className="audit-chart-title">{title}</h4>
      <p className="audit-empty">No data for this period.</p>
    </div>
  );
  const max = Math.max(...data.map((d) => Number(d[valueKey] ?? 0)), 1);
  const fmt = formatValue ?? ((v: number) => Math.round(v).toLocaleString());
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
              <span className="audit-bar-value">{fmt(val)}</span>
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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="audit-stat-card">
      <div className="audit-stat-card-body">
        <span className="audit-stat-value">{value}</span>
        <span className="audit-stat-label">{label}</span>
        {sub ? <span className="audit-stat-sub">{sub}</span> : null}
      </div>
    </div>
  );
}

/**
 * Feature version of a stat card. Big number + label, plus an inline preview
 * of the top contributing rows — each clickable so you can drill into a single
 * item's history. Used for the headline "items used" stat.
 */
function FeatureStatCard({
  label,
  value,
  previewTitle,
  items,
  emptyHint,
  onViewItemHistory,
}: {
  label: string;
  value: string;
  previewTitle: string;
  items: Array<{ itemId: string; itemName: string; qtyUsed: number }>;
  emptyHint: string;
  onViewItemHistory?: (itemId: string, name: string) => void;
}) {
  const max = Math.max(...items.map((r) => r.qtyUsed), 1);
  return (
    <div className="audit-stat-card audit-stat-card--feature">
      <div className="audit-stat-card-body">
        <span className="audit-stat-value">{value}</span>
        <span className="audit-stat-label">{label}</span>
      </div>
      <div className="audit-feature-preview">
        <span className="audit-feature-preview-title">{previewTitle}</span>
        {items.length === 0 ? (
          <p className="audit-empty audit-empty--inline">{emptyHint}</p>
        ) : (
          <ul className="audit-feature-preview-list">
            {items.slice(0, 8).map((row) => {
              const pct = Math.max((row.qtyUsed / max) * 100, 2);
              return (
                <li key={row.itemId} className="audit-feature-preview-row">
                  <button
                    type="button"
                    className="audit-feature-preview-link"
                    onClick={() => onViewItemHistory?.(row.itemId, row.itemName)}
                    title={`View activity for ${row.itemName}`}
                  >
                    {row.itemName}
                  </button>
                  <div className="audit-bar-track audit-feature-preview-track">
                    <div className="audit-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="audit-feature-preview-value">{formatQty(row.qtyUsed)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function AnalyticsDashboard({
  analytics,
  onViewItemHistory,
}: {
  analytics: AuditAnalytics;
  onViewItemHistory?: (itemId: string, name: string) => void;
}) {
  const { totals, usageOverTime, byVendor, bySpendItem, byUsageItem, lossByReason } = analytics;
  const hasData =
    totals.qtyUsed > 0 || totals.spend > 0 || totals.lossQty > 0 || usageOverTime.length > 0;

  if (!hasData) {
    return (
      <div className="audit-analytics-empty">
        <p className="audit-empty">
          No spend, usage, or loss data yet for this period. Data flows in as you
          approve usage, receive restock orders, or retire expired items.
        </p>
      </div>
    );
  }

  const lossRows = lossByReason.map((r) => ({
    ...r,
    reasonLabel: REASON_LABELS[r.reason] ?? r.reason,
  }));

  return (
    <>
      <div className="audit-analytics-summary">
        <FeatureStatCard
          label="items used"
          value={formatQty(totals.qtyUsed)}
          previewTitle="Top items consumed"
          items={byUsageItem}
          emptyHint="No usage logged yet for this period."
          onViewItemHistory={onViewItemHistory}
        />
        <div className="audit-analytics-summary-side">
          <StatCard label="Spend" value={formatUsd(totals.spend)} />
          <StatCard
            label="Loss"
            value={formatQty(totals.lossQty)}
            sub={totals.lossValue > 0 ? `~${formatUsd(totals.lossValue)}` : undefined}
          />
        </div>
      </div>

      <section className="audit-analytics-section">
        <h3 className="audit-analytics-section-title">Spend</h3>
        <div className="audit-analytics-grid">
          <SimpleBarChart
            data={byVendor as unknown as Array<Record<string, unknown>>}
            labelKey="vendor"
            valueKey="spend"
            title="Top vendors by spend"
            formatValue={formatUsd}
          />
          <SimpleBarChart
            data={bySpendItem as unknown as Array<Record<string, unknown>>}
            labelKey="itemName"
            valueKey="spend"
            title="Top items by spend"
            formatValue={formatUsd}
          />
        </div>
      </section>

      <section className="audit-analytics-section">
        <h3 className="audit-analytics-section-title">Usage over time</h3>
        <UsageLineChart data={usageOverTime} />
      </section>

      <section className="audit-analytics-section">
        <h3 className="audit-analytics-section-title">Loss</h3>
        <SimpleBarChart
          data={lossRows as unknown as Array<Record<string, unknown>>}
          labelKey="reasonLabel"
          valueKey="qty"
          title="Retired qty by reason"
          formatValue={formatQty}
        />
      </section>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AuditLogPage({ canManageColumns, canReviewSubmissions, onOpenInInventory }: AuditLogPageProps) {
  const [tab, setTab] = useState<AuditTab>("feed");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Client-side search across loaded events. Matches itemName + userName
  // case-insensitively. For history older than what's loaded, the user can
  // still hit Load More and it'll pick up more events to search.
  const [searchTerm, setSearchTerm] = useState("");

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
      const res = await fetchAuditFeed({
        // Larger pages so day-level summaries (Yesterday: "1 restocked ·
        // 1 added · 135 updated") reflect the day's real totals instead of
        // whatever fraction happened to fit in the first 50 events.
        limit: 200,
        ...(append && cursor ? { cursor } : {}),
      });
      setEvents((prev) => append ? [...prev, ...(res.events ?? [])] : (res.events ?? []));
      setNextCursor(res.nextCursor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Don't surface "Load more" until the user has a meaningful amount of
  // content — otherwise a near-empty feed shows a CTA below an almost-empty
  // page, which reads as broken.
  const LOAD_MORE_THRESHOLD = 20;

  useEffect(() => {
    if (tab === "feed") loadFeed(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  // Strip system-field-only ITEM_EDIT events before display. Without this, the
  // one-time parentItemId backfill on every legacy row floods the feed with
  // "Parent Item Id: — → {uuid}" rows — pure machine noise.
  const noiseFreeEvents = events.filter((e) => !isNoiseEvent(e));
  const visibleHistoryEvents = historyEvents.filter((e) => !isNoiseEvent(e));

  // Client-side search across the currently-loaded feed. Matches item names
  // and user names case-insensitively. For hits older than what's loaded the
  // user still needs to Load More, which is why we don't strip events with
  // no itemName (system events, imports) until they explicitly search.
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const visibleEvents = normalizedSearch
    ? noiseFreeEvents.filter((e) => {
        const hay = `${e.itemName ?? ""} ${e.userName ?? ""} ${e.userEmail ?? ""}`.toLowerCase();
        return hay.includes(normalizedSearch);
      })
    : noiseFreeEvents;


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
            <div className="audit-search-container">
              <Search size={14} className="audit-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="audit-search-input"
                placeholder="Search items or users…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                aria-label="Search activity"
              />
              {searchTerm ? (
                <button
                  type="button"
                  className="audit-search-clear"
                  onClick={() => setSearchTerm("")}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  ×
                </button>
              ) : null}
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

          {visibleEvents.length > 0 && (
            <FlatActivityFeed
              events={visibleEvents}
              onViewItemHistory={viewItemHistory}
            />
          )}

          {loading && (
            <div className="audit-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}

          {!loading && nextCursor && events.length >= LOAD_MORE_THRESHOLD && (
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
          <div className="audit-item-history-toolbar">
            <button
              type="button"
              className="button button-ghost button-sm audit-back-btn"
              onClick={() => setTab("feed")}
            >
              <ChevronLeft size={14} /> Back to Activity
            </button>
            {onOpenInInventory && historyItemName ? (
              <button
                type="button"
                className="button button-secondary button-sm audit-open-in-inventory"
                onClick={() => onOpenInInventory(historyItemName)}
                title="Jump to this item in the inventory table"
              >
                Open in Inventory <ChevronRight size={14} />
              </button>
            ) : null}
          </div>
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

          {visibleHistoryEvents.length > 0 && (
            <FlatItemHistory events={visibleHistoryEvents} />
          )}

          {!historyLoading && historyCursor && historyEvents.length >= LOAD_MORE_THRESHOLD && (
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
            <AnalyticsDashboard analytics={analytics} onViewItemHistory={viewItemHistory} />
          )}
        </div>
      )}
    </section>
  );
}
