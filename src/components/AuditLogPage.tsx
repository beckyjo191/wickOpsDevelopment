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

/** Multi-field ITEM_EDIT threshold. At/below this, changes render inline in the
 *  row detail. Above it, the row shows an "N fields" chip and reveals the full
 *  diff list when clicked. Keeps the feed readable when a CSV import touches a
 *  row's Pack Size + Unit Cost + Pack Cost + Reorder Link in one shot. */
const INLINE_CHANGE_LIMIT = 2;

function getVisibleEditChanges(event: AuditEvent): Array<{ field: string; from: unknown; to: unknown }> {
  if (event.action !== "ITEM_EDIT") return [];
  const details = event.details ?? {};
  const raw = Array.isArray(details.changes)
    ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
    : [];
  return raw.filter((c) => !SYSTEM_FIELDS.has(c.field) && c.field !== "position");
}

function AuditEventRow({
  event,
  onViewItemHistory,
  showDate = false,
}: {
  event: AuditEvent;
  onViewItemHistory?: (itemId: string, name: string) => void;
  showDate?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const derivedAction = deriveAction(event);
  const actionLabel = ACTION_LABELS[derivedAction] ?? event.action;
  const color = ACTION_COLORS[derivedAction] ?? "var(--text-muted)";
  const d = new Date(event.timestamp);
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const editChanges = getVisibleEditChanges(event);
  const shouldCollapseEdit = event.action === "ITEM_EDIT" && editChanges.length > INLINE_CHANGE_LIMIT;
  const detail = shouldCollapseEdit ? "" : buildEventDetail(event);

  return (
    <div className={`audit-event-row${expanded ? " audit-event-row--expanded" : ""}`}>
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
        {shouldCollapseEdit ? (
          <button
            type="button"
            className="audit-event-fields-chip"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? "Hide changes" : "Show changes"}
          >
            {expanded ? "▾" : "▸"} {editChanges.length} fields
          </button>
        ) : null}
        {detail && <span className="audit-event-row-detail">{detail}</span>}
      </div>
      <span className="audit-event-row-user">
        <User size={11} />
        {event.userName || event.userEmail}
      </span>
      {expanded && shouldCollapseEdit ? (
        <ul className="audit-event-changes-list">
          {editChanges.map((c, idx) => (
            <li key={idx} className="audit-event-changes-row">
              <span className="audit-event-changes-field">{humanizeFieldName(c.field)}</span>
              <span className="audit-event-changes-arrow">
                {formatFieldValue(c.field, c.from)} → {formatFieldValue(c.field, c.to)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Day-level event grouping ──────────────────────────────────────────────────
// Two grouping axes, applied in sequence to each day's events:
//
//   1. Restock-order grouping: contiguous events sharing {action, orderId}
//      collapse into one "Order placed (10 items)" row. Covers the
//      RESTOCK_ORDER_CREATE / RESTOCK_RECEIVED noise from bulk orders.
//
//   2. Item-day grouping: any 2+ events on the same {action, itemId} within
//      the day collapse into one "Updated · Safety Razors · 4 edits" row.
//      Covers the fluff when a single item is touched multiple times in a day
//      (field-at-a-time edits, multiple usage approvals, etc.). Click to
//      disclose each timestamped sub-event.
//
// Both preserve the per-event data for analytics; grouping is presentation only.

// Actions whose events carry a shared "batch id" in details — one order or one
// usage submission that touched N items emits N per-item audit events. We
// collapse those back into a single row in the feed and disclose the per-item
// sub-events on click. The map tells the grouper which details field to key on.
const BATCH_KEY_BY_ACTION: Record<string, string> = {
  RESTOCK_ORDER_CREATE: "orderId",
  RESTOCK_RECEIVED: "orderId",
  USAGE_SUBMIT: "submissionId",
  USAGE_APPROVE: "submissionId",
  USAGE_REJECT: "submissionId",
};
const BATCH_GROUPABLE_ACTIONS = new Set(Object.keys(BATCH_KEY_BY_ACTION));

// Actions that aggregate by {action, itemId} within a day. Excludes the batch-
// grouped actions (orders, usage submissions — handled separately via their
// batch id) and one-shot actions like RESTOCK_ORDER_CLOSED.
const ITEM_DAY_GROUPABLE_ACTIONS = new Set([
  "ITEM_EDIT",
  "ITEM_CREATE",
  "ITEM_RETIRE",
  "RESTOCK_ADDED",
]);

type OrderGroup = {
  kind: "order-group";
  groupId: string;
  action: string;
  /** The shared batch id (orderId for restocks, submissionId for usage). */
  batchId: string;
  events: AuditEvent[];
  representative: AuditEvent;
};

type ItemGroup = {
  kind: "item-group";
  groupId: string;
  action: string;
  itemId: string;
  itemName: string;
  events: AuditEvent[];
  representative: AuditEvent;
};

type DisplayRow =
  | { kind: "event"; event: AuditEvent }
  | OrderGroup
  | ItemGroup;

function groupDayEvents(events: AuditEvent[]): DisplayRow[] {
  // Pass 1: order groups — contiguous events sharing {action, orderId}.
  type OrderBucket = { rows: AuditEvent[] };
  const orderBuckets = new Map<string, OrderBucket>();
  const pass1: DisplayRow[] = [];

  events.forEach((event) => {
    const batchKey = BATCH_KEY_BY_ACTION[event.action];
    const batchId = batchKey && typeof event.details?.[batchKey] === "string"
      ? String(event.details[batchKey])
      : "";
    if (BATCH_GROUPABLE_ACTIONS.has(event.action) && batchId) {
      const key = `${event.action}:${batchId}`;
      const bucket = orderBuckets.get(key);
      if (bucket) {
        bucket.rows.push(event);
      } else {
        orderBuckets.set(key, { rows: [event] });
        pass1.push({
          kind: "order-group",
          groupId: key,
          action: event.action,
          batchId,
          events: [],
          representative: event,
        });
      }
      return;
    }
    pass1.push({ kind: "event", event });
  });
  for (const row of pass1) {
    if (row.kind !== "order-group") continue;
    const bucket = orderBuckets.get(row.groupId);
    if (bucket) row.events = bucket.rows;
  }

  // Pass 2: item-day groups — for non-order singletons, bucket by {action,
  // itemId}. A bucket with 2+ events becomes an ItemGroup; 1 event stays a
  // singleton. Group position = first occurrence in the day's stream, so
  // newest-first input produces a group pinned to the most recent event.
  type ItemBucket = { rows: AuditEvent[]; groupId: string; action: string; itemId: string; itemName: string; representative: AuditEvent; firstIndex: number };
  const itemBuckets = new Map<string, ItemBucket>();
  const pass2Positions: Array<{ kind: "slot"; row: DisplayRow } | { kind: "bucket"; groupId: string }> = [];

  pass1.forEach((row, idx) => {
    if (row.kind !== "event") {
      pass2Positions.push({ kind: "slot", row });
      return;
    }
    const event = row.event;
    const itemId = String(event.itemId ?? "");
    if (!itemId || !ITEM_DAY_GROUPABLE_ACTIONS.has(event.action)) {
      pass2Positions.push({ kind: "slot", row });
      return;
    }
    const key = `${event.action}:${itemId}`;
    const existing = itemBuckets.get(key);
    if (existing) {
      existing.rows.push(event);
      return;
    }
    const itemName = String(event.itemName ?? "").trim() || `Item ${itemId.slice(0, 8)}`;
    itemBuckets.set(key, {
      rows: [event],
      groupId: key,
      action: event.action,
      itemId,
      itemName,
      representative: event,
      firstIndex: idx,
    });
    pass2Positions.push({ kind: "bucket", groupId: key });
  });

  const flat: DisplayRow[] = [];
  for (const slot of pass2Positions) {
    if (slot.kind === "slot") {
      flat.push(slot.row);
      continue;
    }
    const bucket = itemBuckets.get(slot.groupId);
    if (!bucket) continue;
    // Always emit an item-group — even singletons — so every item gets
    // exactly one row per day with a click-to-disclose for the changes
    // and a "View full history →" link in the expanded panel. Mixing
    // single-event AuditEventRows with multi-event ItemGroupRows in the
    // same day made the feed feel inconsistent.
    flat.push({
      kind: "item-group",
      groupId: bucket.groupId,
      action: bucket.action,
      itemId: bucket.itemId,
      itemName: bucket.itemName,
      events: bucket.rows,
      representative: bucket.representative,
    });
  }
  return flat;
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
  const isRestockAction = group.action === "RESTOCK_ORDER_CREATE" || group.action === "RESTOCK_RECEIVED";
  const isUsageAction = group.action === "USAGE_SUBMIT" || group.action === "USAGE_APPROVE" || group.action === "USAGE_REJECT";

  // Aggregate qty across the grouped events. Cost / vendor are restock-only —
  // a usage submission doesn't have a unit cost so we skip those fields.
  let totalQty = 0;
  let totalCost = 0;
  let hasCost = false;
  for (const ev of group.events) {
    const dd = ev.details ?? {};
    const qty = Number(
      group.action === "RESTOCK_RECEIVED"
        ? dd.qtyReceived
        : group.action === "RESTOCK_ORDER_CREATE"
          ? dd.qtyOrdered
          : dd.quantityUsed, // USAGE_*
    );
    const unitCost = Number(dd.unitCost);
    if (Number.isFinite(qty)) totalQty += qty;
    if (isRestockAction && Number.isFinite(qty) && Number.isFinite(unitCost)) {
      totalCost += qty * unitCost;
      hasCost = true;
    }
  }

  const summaryParts: string[] = [];
  summaryParts.push(`${count} item${count !== 1 ? "s" : ""}`);
  if (totalQty > 0) summaryParts.push(`qty ${totalQty}`);
  if (isRestockAction && hasCost) summaryParts.push(`$${totalCost.toFixed(2)}`);
  if (isRestockAction && vendor) summaryParts.push(`vendor: ${vendor}`);

  // Batch-id label shown inline: "Order #..." for restock events, omit the
  // meaningless submissionId for usage events (users don't care about IDs).
  const batchLabel = isRestockAction
    ? `Order #${group.batchId.slice(0, 8)}`
    : isUsageAction
      ? "Usage submission"
      : group.batchId.slice(0, 8);

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
          {expanded ? "▾" : "▸"} {batchLabel}
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

function ItemGroupRow({
  group,
  onViewItemHistory,
}: {
  group: ItemGroup;
  onViewItemHistory?: (itemId: string, name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = group.events.length;
  const actionLabel = ACTION_LABELS[group.action] ?? group.action;
  const color = ACTION_COLORS[group.action] ?? "var(--text-muted)";
  const representative = group.representative;
  const repTime = new Date(representative.timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  // User string: one user if all events share, else "N users".
  const uniqueUsers = new Set(group.events.map((e) => e.userName || e.userEmail));
  const userLabel = uniqueUsers.size === 1
    ? (representative.userName || representative.userEmail)
    : `${uniqueUsers.size} users`;

  const countLabel = `${count} ${
    group.action === "USAGE_APPROVE" || group.action === "USAGE_SUBMIT" || group.action === "USAGE_REJECT"
      ? (count === 1 ? "entry" : "entries")
      : group.action === "RESTOCK_ADDED"
        ? (count === 1 ? "restock" : "restocks")
        : group.action === "ITEM_CREATE"
          ? "add events"
          : group.action === "ITEM_RETIRE"
            ? (count === 1 ? "retire" : "retires")
            : (count === 1 ? "edit" : "edits")
  }`;

  return (
    <div className={`audit-event-row audit-event-row--group${expanded ? " audit-event-row--expanded" : ""}`}>
      <span className="audit-event-row-time">{repTime}</span>
      <span className="audit-event-row-action" style={{ color }}>{actionLabel}</span>
      <div className="audit-event-row-center">
        <button
          type="button"
          className="audit-event-item-link audit-event-group-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Hide changes" : "Show changes"}
        >
          {expanded ? "▾" : "▸"} {group.itemName}
        </button>
        <span className="audit-event-row-detail">{countLabel}</span>
      </div>
      <span className="audit-event-row-user">
        <User size={11} />
        {userLabel}
      </span>
      {expanded ? (
        <ul className="audit-event-group-children audit-item-group-children">
          {group.events.map((child) => {
            const childTime = new Date(child.timestamp).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            });
            const childDetail = buildEventDetail(child);
            const childUser = child.userName || child.userEmail;
            return (
              <li key={child.eventId} className="audit-item-group-child">
                <span className="audit-item-group-child-time">{childTime}</span>
                <span className="audit-item-group-child-detail">
                  {childDetail || "—"}
                </span>
                {uniqueUsers.size > 1 ? (
                  <span className="audit-item-group-child-user">{childUser}</span>
                ) : null}
              </li>
            );
          })}
          <li className="audit-item-group-footer">
            <button
              type="button"
              className="audit-item-group-history-link"
              onClick={() => onViewItemHistory?.(group.itemId, group.itemName)}
              title="View full item history"
            >
              View full history →
            </button>
          </li>
        </ul>
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
  // Collapse counts by the same keys the UI collapses by: unique batchIds for
  // batch-groupable actions (orders / usage submissions), unique itemIds for
  // item-day-groupable actions, everything else counts raw. Stops "149
  // updated" from inflating when really we touched 28 items four times each.
  const seenBatchIds: Record<string, Set<string>> = {};
  const seenItemIds: Record<string, Set<string>> = {};
  for (const e of events) {
    const a = deriveAction(e);
    const batchKey = BATCH_KEY_BY_ACTION[a];
    if (batchKey) {
      const batchId = typeof e.details?.[batchKey] === "string" ? String(e.details[batchKey]) : "";
      if (batchId) {
        const bucket = seenBatchIds[a] ?? (seenBatchIds[a] = new Set());
        if (bucket.has(batchId)) continue;
        bucket.add(batchId);
      }
    } else if (ITEM_DAY_GROUPABLE_ACTIONS.has(a)) {
      const itemId = String(e.itemId ?? "");
      if (itemId) {
        const bucket = seenItemIds[a] ?? (seenItemIds[a] = new Set());
        if (bucket.has(itemId)) continue;
        bucket.add(itemId);
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

/** Default visible rows inside an expanded day. When exceeded we show a
 *  "Show N more" button so a 149-event day doesn't spill forever. */
const DAY_INITIAL_ROW_CAP = 25;

function DayReport({
  label,
  events,
  onViewItemHistory,
  defaultCollapsed = false,
}: {
  label: string;
  events: AuditEvent[];
  onViewItemHistory?: (itemId: string, name: string) => void;
  /** True for all non-Today day groups so older history stays out of the way. */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [expandedAll, setExpandedAll] = useState(false);
  const uniqueUsers = new Set(events.map((e) => e.userName || e.userEmail)).size;
  const summary = buildDaySummary(events);
  const displayRows = groupDayEvents(events);
  const overCap = displayRows.length > DAY_INITIAL_ROW_CAP;
  const visibleRows = overCap && !expandedAll
    ? displayRows.slice(0, DAY_INITIAL_ROW_CAP)
    : displayRows;

  return (
    <div className={`audit-day-report app-card${collapsed ? " audit-day-report--collapsed" : ""}`}>
      <button
        type="button"
        className="audit-day-report-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="audit-day-report-chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="audit-day-report-label">{label}</span>
        <span className="audit-day-report-summary">{summary}</span>
        <span className="audit-day-report-users">
          <User size={11} />
          {uniqueUsers}
        </span>
      </button>
      {!collapsed ? (
        <div className="audit-day-report-rows">
          {visibleRows.map((row) => {
            if (row.kind === "order-group") {
              return (
                <OrderGroupRow
                  key={row.groupId}
                  group={row}
                  onViewItemHistory={onViewItemHistory}
                />
              );
            }
            if (row.kind === "item-group") {
              return (
                <ItemGroupRow
                  key={row.groupId}
                  group={row}
                  onViewItemHistory={onViewItemHistory}
                />
              );
            }
            return (
              <AuditEventRow
                key={row.event.eventId}
                event={row.event}
                onViewItemHistory={onViewItemHistory}
              />
            );
          })}
          {overCap && !expandedAll ? (
            <button
              type="button"
              className="button button-ghost button-sm audit-day-show-more"
              onClick={() => setExpandedAll(true)}
            >
              Show {displayRows.length - DAY_INITIAL_ROW_CAP} more
            </button>
          ) : null}
        </div>
      ) : null}
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

          {feedGroups.map((group) => (
            <DayReport
              key={group.label}
              label={group.label}
              events={group.events}
              onViewItemHistory={viewItemHistory}
              // Today stays open; older days collapse so the list doesn't
              // scroll past a mountain of yesterday's activity to find today.
              defaultCollapsed={group.label !== "Today"}
            />
          ))}

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

          {historyGroups.map((group) => (
            <DayReport
              key={group.label}
              label={group.label}
              events={group.events}
              defaultCollapsed={group.label !== "Today"}
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
            <AnalyticsDashboard analytics={analytics} onViewItemHistory={viewItemHistory} />
          )}
        </div>
      )}
    </section>
  );
}
