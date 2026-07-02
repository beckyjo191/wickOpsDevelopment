import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAuditFeed,
  fetchItemHistory,
  fetchItemHistoryByName,
  fetchAuditAnalytics,
  fetchVendorBreakdown,
  fetchAnalyticsBreakdown,
  listInventoryLocations,
  type AnalyticsBreakdown,
  type InventoryLocation,
  type VendorBreakdown,
  undoColumnDeleteEvent,
  undoRetireEvent,
  undoUsageEvent,
  ADJUST_REASON_LABEL,
  type AdjustReason,
  type AuditEvent,
  type AuditAnalytics,
} from "../lib/inventoryApi";
import { buildLocationPickerEntries } from "../lib/locationTree";
import { CustomDropdown } from "./shared/CustomDropdown";
import { CostOverTime } from "./shared/CostOverTime";
import {
  Activity,
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Package,
  RotateCcw,
  Search,
  User,
  X,
} from "lucide-react";
import { formatCurrency, isCurrencyColumnKey } from "../lib/currency";
import { DaySection } from "../lib/dayGroups";
import { EmptyState } from "./shared/EmptyState";
import { LoadingState } from "./shared/LoadingState";
import { dayGroupLabel } from "../lib/dayGroupLabel";
import { useMobileDetect } from "./inventory/hooks/useMobileDetect";
import { AuditMobileFeed } from "./AuditMobileFeed";

export type AuditTab = "feed" | "analytics" | "item-history";

interface AuditLogPageProps {
  canManageColumns: boolean;
  /** Required for the Undo button on USAGE_APPROVE events. Mirrors the perm
   *  that lets the user log usage in the first place. */
  canEditInventory?: boolean;
  /** Read-only WickOps support operator. Reveals the Analytics tab (normally
   *  admin-gated) without exposing any write controls. */
  isSupportView?: boolean;
  /** Called when the user clicks "Open in Inventory" from the item-history
   *  view. Parent handles switching to the Inventory tab and focusing the row.
   *  Passes the item name rather than id because we filter inventory via
   *  search term — robust across lots + renames. */
  onOpenInInventory?: (itemName: string) => void;
  /** Called when the user clicks a per-order row in the activity feed
   *  (Order placed / received / cancelled). Parent switches to the Orders
   *  tab and focuses the matching order — same affordance as
   *  `onOpenInInventory` but for orders. */
  onOpenInOrders?: (orderId: string) => void;
  /** Notifies parent of the current sub-tab so subnav-level UI (e.g. tab-aware
   *  help button) can react. Fires on mount and on every change. */
  onTabChange?: (tab: AuditTab) => void;
  /** Deep-link target: when set (e.g. from the pricing modal's "See full
   *  activity" link), open this item's history view on arrival. */
  initialHistoryItem?: { itemId: string; itemName: string };
  /** Called once the deep-link target has been consumed so the parent can
   *  clear it (prevents re-opening on unrelated re-renders). */
  onHistoryItemConsumed?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  ITEM_CREATE: "Added",
  ITEM_EDIT: "Updated",
  ITEM_DELETE: "Deleted",
  ITEM_MOVE: "Moved",
  ITEM_RESTOCK: "Restocked",
  ITEM_QTY_ADJUST: "Adjusted qty",
  ITEM_RETIRE: "Retired",
  ITEM_UNRETIRE: "Retire undone",
  USAGE_SUBMIT: "Usage logged",
  // The pending-approval queue is gone — submissions now decrement directly,
  // so what used to be "approved by a manager" is now just the act of
  // logging. Action key stays USAGE_APPROVE for back-compat with stored
  // events; the user-facing label says what actually happens.
  USAGE_APPROVE: "Usage logged",
  USAGE_REJECT: "Usage rejected",
  USAGE_UNDO: "Usage undone",
  COLUMN_CREATE: "Column added",
  COLUMN_DELETE: "Column deleted",
  COLUMN_RESTORE: "Column restored",
  COLUMN_UPDATE: "Column updated",
  LOCATION_CREATE: "Location added",
  LOCATION_RENAME: "Location renamed",
  LOCATION_DELETE: "Location deleted",
  CSV_IMPORT: "CSV import",
  TEMPLATE_APPLY: "Template applied",
  RESTOCK_ORDER_CREATE: "Order placed",
  RESTOCK_RECEIVED: "Order received",
  RESTOCK_ORDER_CLOSED: "Order closed",
  RESTOCK_ADDED: "Fast restock",
  VENDOR_PRICE_EDIT: "Price updated",
  MIGRATION_APPLY: "Inventory upgraded",
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
  // Continuation stubs created by the retire flow (qty 0 + min carried over,
  // so the item stays in the reorder list). The user didn't intentionally
  // add anything, so the matching ITEM_CREATE is machine noise.
  if (event.action === "ITEM_CREATE" && details.skeleton === true) return true;
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

// Action → accent-rail color. Each value drives the per-row `--row-accent`
// custom property (set inline in FlatActivityFeed / FlatItemHistory) that paints
// the left rail. INVARIANT: every value must be a design-system status token
// (var(--success | --primary | --warning | --danger | --text-muted)) — never a
// raw hex — so the rail stays inside the token set even though it's applied via
// inline style. New actions: pick the status token that matches their tone.
const ACTION_COLORS: Record<string, string> = {
  ITEM_CREATE: "var(--success)",
  ITEM_EDIT: "var(--primary)",
  ITEM_MOVE: "var(--text-muted)",
  ITEM_RESTOCK: "var(--success)",
  ITEM_QTY_ADJUST: "var(--warning)",
  ITEM_DELETE: "var(--danger)",
  ITEM_RETIRE: "var(--danger)",
  ITEM_UNRETIRE: "var(--text-muted)",
  USAGE_SUBMIT: "var(--warning)",
  USAGE_APPROVE: "var(--success)",
  USAGE_REJECT: "var(--danger)",
  USAGE_UNDO: "var(--text-muted)",
  COLUMN_CREATE: "var(--primary)",
  COLUMN_DELETE: "var(--danger)",
  COLUMN_RESTORE: "var(--text-muted)",
  COLUMN_UPDATE: "var(--primary)",
  LOCATION_CREATE: "var(--success)",
  LOCATION_RENAME: "var(--primary)",
  LOCATION_DELETE: "var(--danger)",
  CSV_IMPORT: "var(--primary)",
  TEMPLATE_APPLY: "var(--primary)",
  RESTOCK_ORDER_CREATE: "var(--primary)",
  RESTOCK_RECEIVED: "var(--success)",
  RESTOCK_ORDER_CLOSED: "var(--text-muted)",
  RESTOCK_ADDED: "var(--success)",
  VENDOR_PRICE_EDIT: "var(--primary)",
  MIGRATION_APPLY: "var(--text-muted)",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// `dayGroupLabel` lives in src/lib/dayGroups.tsx — shared with OrdersPage.

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
    // Real ITEM_QTY_ADJUST events (manual reconciliation) carry
    // qtyBefore/qtyAfter + a reason; legacy ones derived from a qty-only
    // ITEM_EDIT only have a changes diff and no reason.
    const reason = typeof details.reason === "string" ? details.reason : "";
    const notes = typeof details.notes === "string" ? details.notes : "";
    const notePart = notes ? ` ${formatNotePreview(notes)}` : "";
    if (details.qtyBefore !== undefined && details.qtyAfter !== undefined) {
      const base = `Qty ${formatFieldValue("quantity", details.qtyBefore)} → ${formatFieldValue("quantity", details.qtyAfter)}`;
      const reasonLabel = reason ? ADJUST_REASON_LABEL[reason as AdjustReason] ?? reason : "";
      const reasonPart = reasonLabel ? ` (${reasonLabel})` : "";
      return `${base}${reasonPart}${notePart}`;
    }
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
    // Location denormalized at save time, when present, lets the feed read
    // "Added at Main Storage (Qty 4)" without resolving the id again here.
    const locName = typeof details.locationName === "string" ? details.locationName : "";
    const base = parts.length > 0 ? `Added (${parts.join(", ")})` : "Added";
    return locName ? `${base} at ${locName}` : base;
  }
  if (derived === "ITEM_RETIRE") {
    const reason = typeof details.reason === "string" ? details.reason : "";
    const notes = typeof details.notes === "string" ? details.notes : "";
    const notePart = notes ? ` ${formatNotePreview(notes)}` : "";
    const base = reason ? `Retired (${reason})` : "Retired";
    return `${base}${notePart}`;
  }
  if (derived === "ITEM_UNRETIRE") {
    const restored = details.quantityRestored;
    return restored !== undefined ? `Undid retire — restored ${restored}` : "Retire undone";
  }
  if (derived === "ITEM_DELETE") return "Deleted";
  if (derived === "ITEM_MOVE") {
    // Real structural moves (server-emitted /inventory/items/move) carry the
    // location names. Legacy "position-only ITEM_EDIT" events from before
    // ITEM_MOVE was a first-class action don't, so they fall back to
    // "Reordered" (which described the rearrange-rows behavior at the time).
    const fromName = typeof details.fromLocationName === "string" ? details.fromLocationName : "";
    const toName = typeof details.toLocationName === "string" ? details.toLocationName : "";
    if (fromName && toName) return `Moved from ${fromName} to ${toName}`;
    if (toName) return `Moved to ${toName}`;
    return "Reordered";
  }
  if (derived === "LOCATION_CREATE") {
    const name = typeof details.name === "string" ? details.name : "";
    return name ? `Location added (${name})` : "Location added";
  }
  if (derived === "LOCATION_RENAME") {
    const from = typeof details.from === "string" ? details.from : "";
    const to = typeof details.to === "string" ? details.to : "";
    if (from && to) return `Location renamed: ${from} → ${to}`;
    return "Location renamed";
  }
  if (derived === "LOCATION_DELETE") {
    const name = typeof details.name === "string" ? details.name : "";
    return name ? `Location deleted (${name})` : "Location deleted";
  }
  if (derived === "MIGRATION_APPLY") {
    const moved = Number(details.itemsMovedToDefault ?? 0);
    const created = Number(details.locationsCreated ?? 0);
    const parts: string[] = [];
    if (created > 0) parts.push(`${created} location${created === 1 ? "" : "s"} created`);
    if (moved > 0) parts.push(`${moved} item${moved === 1 ? "" : "s"} moved to Default`);
    return parts.length > 0 ? `Inventory upgraded — ${parts.join(", ")}` : "Inventory upgraded";
  }
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
  if (derived === "RESTOCK_ORDER_CLOSED") {
    const vendor = typeof details.vendor === "string" ? details.vendor : "";
    const note = typeof details.note === "string" ? details.note : "";
    if (vendor && note) return `Order closed — ${vendor} (${note})`;
    if (vendor) return `Order closed — ${vendor}`;
    if (note) return `Order closed (${note})`;
    return "Order closed";
  }
  if (derived === "RESTOCK_ADDED") {
    const delta = details.qtyDelta;
    const vendor = typeof details.vendor === "string" ? details.vendor : "";
    if (delta !== undefined && vendor) return `Fast restock +${delta} from ${vendor}`;
    if (delta !== undefined) return `Fast restock +${delta}`;
    return "Fast restock";
  }
  if (derived === "VENDOR_PRICE_EDIT") {
    const vendor = typeof details.vendor === "string" ? details.vendor : "";
    const cost = typeof details.unitCost === "number" ? details.unitCost : undefined;
    const priced = cost !== undefined ? formatCurrency(cost) : "";
    if (priced && vendor) return `Price set to ${priced} at ${vendor}`;
    if (vendor) return `Price updated at ${vendor}`;
    return "Price updated";
  }
  if (derived === "USAGE_SUBMIT") {
    const used = details.quantityUsed;
    return used !== undefined ? `Logged usage of ${used}` : "Usage logged";
  }
  if (derived === "USAGE_APPROVE") {
    const used = details.quantityUsed;
    const notes = typeof details.notes === "string" ? details.notes : "";
    const notePart = notes ? ` ${formatNotePreview(notes)}` : "";
    if (used !== undefined) return `Logged usage of ${used}${notePart}`;
    return `Usage logged${notePart}`;
  }
  if (derived === "USAGE_REJECT") {
    const reason = typeof details.reason === "string" ? details.reason : "";
    return reason ? `Rejected usage (${reason})` : "Usage rejected";
  }
  if (derived === "USAGE_UNDO") {
    const restored = details.quantityRestored;
    return restored !== undefined ? `Undid usage — restored ${restored}` : "Usage undone";
  }
  if (derived === "CSV_IMPORT") {
    const c = details.rowsCreated ?? 0;
    const u = details.rowsUpdated ?? 0;
    return `CSV import: ${c} created, ${u} updated`;
  }
  if (derived === "TEMPLATE_APPLY") return "Template applied";
  if (derived === "COLUMN_CREATE") {
    const label = typeof details.columnLabel === "string" && details.columnLabel
      ? details.columnLabel
      : typeof details.columnKey === "string" ? details.columnKey : "";
    return label ? `Column added (${label})` : "Column added";
  }
  if (derived === "COLUMN_DELETE") {
    const label = typeof details.columnLabel === "string" && details.columnLabel
      ? details.columnLabel
      : typeof details.columnKey === "string" ? details.columnKey : "";
    return label ? `Column deleted (${label})` : "Column deleted";
  }
  if (derived === "COLUMN_RESTORE") {
    const label = typeof details.columnLabel === "string" && details.columnLabel
      ? details.columnLabel
      : typeof details.columnKey === "string" ? details.columnKey : "";
    return label ? `Column restored (${label})` : "Column restored";
  }
  if (derived === "COLUMN_UPDATE") {
    const label = typeof details.columnLabel === "string" && details.columnLabel
      ? details.columnLabel
      : typeof details.columnKey === "string" ? details.columnKey : "";
    const change = typeof details.changeType === "string" ? details.changeType : "";
    // changeType values from server: "label" / "type" / "visibility" /
    // "attachments" / "attachments+groupable" / "groupable". Map to a
    // user-readable suffix so the feed isn't just "Column updated" for
    // every kind of change.
    const changeSuffix =
      change === "attachments" || change === "attachments+groupable"
        ? "locations"
        : change === "groupable"
          ? "filter"
          : change || "";
    if (label && changeSuffix) return `Column updated (${label} — ${changeSuffix})`;
    if (label) return `Column updated (${label})`;
    return "Column updated";
  }
  return ACTION_LABELS[derived] ?? derived;
}

/** Returns a URL for the event if it has one (currently just ITEM_EDIT
 *  events that touch the reorderLink field). Used to build the title attr
 *  so users can hover the row to see the full URL behind a `boundtree.com`. */
/** Max characters of a note shown inline in the activity row before
 *  truncating. The full text is always available via the row's title
 *  attribute (native hover tooltip) and in the per-item history view. */
const NOTE_PREVIEW_MAX = 50;

function formatNotePreview(note: string): string {
  const cleaned = note.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= NOTE_PREVIEW_MAX) return `— "${cleaned}"`;
  return `— "${cleaned.slice(0, NOTE_PREVIEW_MAX)}…"`;
}

function eventTitleAttr(event: AuditEvent): string | undefined {
  const details = event.details ?? {};
  // Full note text on hover for events that carry one. Lets a user with
  // the cursor on a row read a long note that the inline preview
  // truncates without leaving the feed.
  const notes = typeof details.notes === "string" ? details.notes.trim() : "";
  if (notes && (event.action === "USAGE_APPROVE" || event.action === "ITEM_RETIRE")) {
    return notes;
  }
  if (event.action !== "ITEM_EDIT") return undefined;
  const linkChange = getVisibleEditChanges(event).find((c) => c.field === "reorderLink");
  if (!linkChange) return undefined;
  const v = String(linkChange.to ?? "").trim();
  return v || undefined;
}

export type DayBucket<T> = { label: string; rows: T[]; users: Set<string> };

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

// `DaySection` lives in src/lib/dayGroups.tsx — shared with OrdersPage. Each
//  caller computes its own `summary` since the audit log uses
//  "N changes · M users" while closed orders use "N orders".

/** Discriminator for events that carry an inline Undo affordance. Each kind
 *  routes to a different reversal endpoint:
 *   - "usage"  → re-adds the decremented qty (POST /inventory/usage/undo)
 *   - "retire" → clears retire markers + restores qty (POST /inventory/items/undo-retire)
 *   - "column" → recreates the column from its snapshot (POST /inventory/columns/restore)
 */
export type UndoableKind = "usage" | "retire" | "column";

export type UndoableEvent = {
  kind: UndoableKind;
  eventId: string;
  /** Item-scoped undos need the partition key. Column-restore is org-scoped. */
  itemId?: string;
};

/** Identify undoable events from the raw audit row. Eligible iff the action
 *  is one of the reversible kinds AND the event hasn't already been undone. */
function detectUndoable(event: AuditEvent): UndoableEvent | undefined {
  if (event.details?.undone) return undefined;
  if (event.action === "USAGE_APPROVE" && typeof event.itemId === "string" && event.itemId) {
    return { kind: "usage", eventId: event.eventId, itemId: event.itemId };
  }
  if (event.action === "ITEM_RETIRE" && typeof event.itemId === "string" && event.itemId) {
    return { kind: "retire", eventId: event.eventId, itemId: event.itemId };
  }
  if (event.action === "COLUMN_DELETE") {
    return { kind: "column", eventId: event.eventId };
  }
  return undefined;
}

/** Per-(day, item) row data for the main activity feed. */
export type ActivityRowData = {
  key: string;
  timestamp: string;
  itemId: string | null;
  itemName: string;
  summary: string;
  accentColor: string;
  user: string;
  titleAttr?: string;
  /** Every undoable, not-yet-undone event in this bucket. Single-event rows
   *  produce a 1-element array; multi-event same-action buckets (e.g. five
   *  USAGE_APPROVE events on the same item) carry all of them so one Undo
   *  click can reverse the whole batch. Empty/undefined → no Undo button. */
  undoableEvents?: UndoableEvent[];
  /** Set when this row is a synthetic per-order bucket (Order placed /
   *  received / cancelled). Clicking the row jumps to the Orders tab and
   *  focuses the matching order — same affordance as itemId for item rows. */
  orderId?: string;
};

export function aggregateActivityRows(
  events: AuditEvent[],
  options?: { hasMultipleLocations?: boolean },
): Array<DayBucket<ActivityRowData>> {
  const hasMultipleLocations = !!options?.hasMultipleLocations;
  type Bucket = {
    events: AuditEvent[];
    lastTimestamp: string;
    actions: Set<string>;
    users: Set<string>;
    itemId: string | null;
    itemName: string;
    /** "item" = per-item bucket (default). "order" = synthetic per-(orderId,
     *  action) bucket that collapses multi-line order events into one row so
     *  receiving 75 items in a single order doesn't flood the feed with 75
     *  rows. The per-item history view still shows the underlying events. */
    kind: "item" | "order";
    orderId?: string;
    orderAction?: "placed" | "received";
    vendor?: string;
  };
  type DayAcc = { label: string; keyOrder: string[]; buckets: Map<string, Bucket> };
  const dayAccs: DayAcc[] = [];
  let currentDay: DayAcc | null = null;

  // Pre-pass: which orderIds had any RESTOCK_RECEIVED event in the loaded
  // window? Used to distinguish a "cancelled" close (no receive ever
  // happened) from a "closed" close (some/all stock arrived first).
  const receivedOrderIds = new Set<string>();
  for (const e of events) {
    if (e.action !== "RESTOCK_RECEIVED") continue;
    const oid = typeof e.details?.orderId === "string" ? e.details.orderId.trim() : "";
    if (oid) receivedOrderIds.add(oid);
  }

  for (const e of events) {
    const label = dayGroupLabel(e.timestamp);
    if (!currentDay || currentDay.label !== label) {
      currentDay = { label, keyOrder: [], buckets: new Map() };
      dayAccs.push(currentDay);
    }

    // Order-level routing: RESTOCK_ORDER_CREATE and RESTOCK_RECEIVED events
    // collapse to one bucket per (orderId, action) so a 30-line order reads
    // as two feed rows (placed, received) instead of 60.
    const eventOrderId = typeof e.details?.orderId === "string" ? e.details.orderId.trim() : "";
    const isOrderPlacedEvent = e.action === "RESTOCK_ORDER_CREATE" && !!eventOrderId;
    const isOrderReceivedEvent = e.action === "RESTOCK_RECEIVED" && !!eventOrderId;
    const itemId = e.itemId ? String(e.itemId) : null;

    let rowKey: string;
    let kind: "item" | "order";
    let orderAction: "placed" | "received" | undefined;
    if (isOrderPlacedEvent) {
      rowKey = `order:${eventOrderId}:placed`;
      kind = "order";
      orderAction = "placed";
    } else if (isOrderReceivedEvent) {
      rowKey = `order:${eventOrderId}:received`;
      kind = "order";
      orderAction = "received";
    } else {
      rowKey = itemId ?? `event:${e.eventId}`;
      kind = "item";
    }

    let bucket = currentDay.buckets.get(rowKey);
    if (!bucket) {
      const vendor = typeof e.details?.vendor === "string" ? e.details.vendor.trim() : "";
      bucket = {
        events: [],
        lastTimestamp: e.timestamp,
        actions: new Set(),
        users: new Set(),
        itemId: kind === "order" ? null : itemId,
        itemName: kind === "order" ? "" : String(e.itemName ?? "").trim(),
        kind,
        orderId: eventOrderId || undefined,
        orderAction,
        vendor: vendor || undefined,
      };
      currentDay.buckets.set(rowKey, bucket);
      currentDay.keyOrder.push(rowKey);
    }
    bucket.events.push(e);
    if (e.timestamp > bucket.lastTimestamp) bucket.lastTimestamp = e.timestamp;
    bucket.actions.add(deriveAction(e));
    const u = e.userName || e.userEmail;
    if (u) bucket.users.add(u);
    if (bucket.kind === "item" && !bucket.itemName && e.itemName) {
      bucket.itemName = String(e.itemName).trim();
    }
    if (!bucket.vendor) {
      const vendor = typeof e.details?.vendor === "string" ? e.details.vendor.trim() : "";
      if (vendor) bucket.vendor = vendor;
    }
  }

  const days: Array<DayBucket<ActivityRowData>> = [];
  for (const d of dayAccs) {
    const day: DayBucket<ActivityRowData> = { label: d.label, rows: [], users: new Set() };
    for (const rowKey of d.keyOrder) {
      const bucket = d.buckets.get(rowKey)!;
      // If every event is USAGE_APPROVE for the same item, collapse the row
      // into one "Logged usage of <total>" instead of joining N copies of
      // "Logged usage of 1". Mixed buckets keep the dotted join so each
      // distinct action stays visible.
      const allUsage = bucket.events.length > 1
        && bucket.events.every((e) => e.action === "USAGE_APPROVE");
      let summary: string;
      if (bucket.kind === "order") {
        // Synthetic per-order bucket — collapses all line-level events for
        // one order into one row. Single-item orders surface the item
        // name + qty inline; multi-item orders show count + total $.
        const isPlaced = bucket.orderAction === "placed";
        const qtyKey = isPlaced ? "qtyOrdered" : "qtyReceived";
        const verb = isPlaced ? "Order placed" : "Order received";

        // Roll up qty + spend per distinct item; also track distinct
        // locations across the bucket's events so multi-station orgs can
        // see "at Station 3" when all lines land at one location.
        type Roll = { itemName: string; qty: number; spend: number };
        const byItem = new Map<string, Roll>();
        const distinctLocations = new Set<string>();
        let totalSpend = 0;
        for (const e of bucket.events) {
          const key = String(e.itemId ?? "") || String(e.itemName ?? "");
          if (!key) continue;
          const qty = Number(e.details?.[qtyKey] ?? 0);
          const unitCost = Number(e.details?.unitCost ?? 0);
          const safeQty = Number.isFinite(qty) ? qty : 0;
          const lineSpend = Number.isFinite(unitCost) && unitCost > 0 ? safeQty * unitCost : 0;
          totalSpend += lineSpend;
          const existing = byItem.get(key);
          if (existing) {
            existing.qty += safeQty;
            existing.spend += lineSpend;
          } else {
            byItem.set(key, {
              itemName: String(e.itemName ?? "").trim() || "Unnamed item",
              qty: safeQty,
              spend: lineSpend,
            });
          }
          const locName = typeof e.details?.location === "string" ? e.details.location.trim() : "";
          if (locName) distinctLocations.add(locName);
        }
        const itemCount = byItem.size || bucket.events.length;
        const spendPart = totalSpend > 0 ? ` · ${formatUsd(totalSpend)}` : "";

        // Location suffix only when (a) org has 2+ locations (single-loc
        // orgs would just see "at Default" everywhere) and (b) every line
        // resolves to one location. Multi-location orders rely on the
        // drill-in for the per-line breakdown.
        const singleLocation = hasMultipleLocations && distinctLocations.size === 1
          ? [...distinctLocations][0]
          : "";

        if (itemCount === 1) {
          const only = [...byItem.values()][0];
          const qtyLabel = only.qty > 0 ? `${formatQty(only.qty)} ` : "";
          const vendorPart = bucket.vendor ? ` from ${bucket.vendor}` : "";
          const locationPart = singleLocation ? ` at ${singleLocation}` : "";
          // "Order received — 5 IV Start Kit from BoundTree at Station 3 · $120"
          summary = `${verb} — ${qtyLabel}${only.itemName}${vendorPart}${locationPart}${spendPart}`;
        } else {
          // "Order received — BoundTree at Station 3 (3 items · $245)"
          // For multi-location orders the location chunk is omitted —
          // drill in to see the per-line breakdown.
          const vendorSuffix = bucket.vendor ? ` — ${bucket.vendor}` : "";
          const locationSuffix = singleLocation ? ` at ${singleLocation}` : "";
          const countLabel = `${itemCount} items${totalSpend > 0 ? ` · ${formatUsd(totalSpend)}` : ""}`;
          summary = `${verb}${vendorSuffix}${locationSuffix} (${countLabel})`;
        }
      } else if (bucket.events.length === 1) {
        const lone = bucket.events[0];
        // Special case: standalone RESTOCK_ORDER_CLOSED — relabel "cancelled"
        // vs "closed" based on whether any RESTOCK_RECEIVED event exists for
        // this orderId in the loaded window. Heuristic but matches the user's
        // mental model in the common case.
        if (lone.action === "RESTOCK_ORDER_CLOSED") {
          const oid = typeof lone.details?.orderId === "string" ? lone.details.orderId.trim() : "";
          const wasReceived = !!oid && receivedOrderIds.has(oid);
          const vendor = typeof lone.details?.vendor === "string" ? lone.details.vendor.trim() : "";
          const note = typeof lone.details?.note === "string" ? lone.details.note.trim() : "";
          const verb = wasReceived ? "Order closed" : "Order cancelled";
          const vendorPart = vendor ? ` — ${vendor}` : "";
          const notePart = note ? ` (${note})` : "";
          summary = `${verb}${vendorPart}${notePart}`;
        } else {
          summary = buildRichRowSummary(lone);
        }
      } else if (allUsage) {
        const total = bucket.events.reduce((acc, e) => {
          const qty = Number(e.details?.quantityUsed ?? 0);
          return acc + (Number.isFinite(qty) ? qty : 0);
        }, 0);
        summary = `Logged usage of ${total}`;
      } else {
        // Mixed-action item bucket — plain dotted join so distinct events
        // stay visible. No dedupe across event ids: two same-shape events
        // from different orderIds are genuinely different and shouldn't be
        // visually merged.
        summary = bucket.events.map(buildRichRowSummary).join(" · ");
      }
      const titleAttr = bucket.events.length === 1 && bucket.kind === "item"
        ? eventTitleAttr(bucket.events[0])
        : undefined;
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
      // Inline Undo: single-event buckets, plus uniform USAGE_APPROVE
      // buckets (the rapid-fire "logged 5 saline flushes" case). One click
      // unwinds the whole batch sequentially.
      const undoableEvents: UndoableEvent[] = [];
      if (bucket.events.length === 1) {
        const lone = detectUndoable(bucket.events[0]);
        if (lone) undoableEvents.push(lone);
      } else if (allUsage) {
        for (const e of bucket.events) {
          const u = detectUndoable(e);
          if (u) undoableEvents.push(u);
        }
      }
      // RESTOCK_ORDER_CLOSED is bucketed per-event (one row per close event)
      // but still has an orderId in its details — carry it so the row can
      // link to the matching order, same as the order-bucket rows do.
      const orderIdForRow = bucket.kind === "order"
        ? bucket.orderId
        : (bucket.events.length === 1 && bucket.events[0].action === "RESTOCK_ORDER_CLOSED"
          ? (typeof bucket.events[0].details?.orderId === "string"
            ? bucket.events[0].details.orderId.trim() || undefined
            : undefined)
          : undefined);
      day.rows.push({
        key: `${d.label}::${rowKey}`,
        timestamp: bucket.lastTimestamp,
        itemId: bucket.itemId,
        itemName: bucket.itemName || "—",
        summary,
        accentColor,
        user: userLabel,
        titleAttr,
        undoableEvents: undoableEvents.length > 0 ? undoableEvents : undefined,
        ...(orderIdForRow ? { orderId: orderIdForRow } : {}),
      });
      for (const u of bucket.users) day.users.add(u);
    }
    days.push(day);
  }
  return days;
}

export const UNDO_TOOLTIPS: Record<UndoableKind, string> = {
  usage: "Undo this usage — restore the decremented quantity",
  retire: "Undo this retire — clear the retire markers and restore the quantity",
  column: "Restore this column — bring back the deleted column and its values",
};

function FlatActivityFeed({
  events,
  onViewItemHistory,
  onOpenInOrders,
  hasMultipleLocations,
  onUndoEvent,
  undoingEventId,
}: {
  events: AuditEvent[];
  onViewItemHistory: (itemId: string, name: string) => void;
  /** Click target for synthetic per-order rows (Order placed / received /
   *  cancelled). Jumps to the Orders tab and focuses the matching order,
   *  mirroring the item-history flow for item rows. */
  onOpenInOrders?: (orderId: string) => void;
  /** When true, per-order rows append "at {locationName}" when all the
   *  bucket's events resolve to one location. Hidden for single-location
   *  orgs (Florence) so the row doesn't read "at Default" everywhere. */
  hasMultipleLocations?: boolean;
  onUndoEvent?: (undoable: UndoableEvent | UndoableEvent[]) => void;
  undoingEventId?: string | null;
}) {
  const days = aggregateActivityRows(events, { hasMultipleLocations });
  return (
    <div className="audit-flat-feed">
      {days.map((day) => {
        const rowCount = day.rows.length;
        const userCount = day.users.size;
        const summary =
          `${rowCount} change${rowCount !== 1 ? "s" : ""}` +
          (userCount > 0 ? ` · ${userCount} user${userCount !== 1 ? "s" : ""}` : "");
        return (
        <DaySection
          key={day.label}
          label={day.label}
          summary={summary}
          defaultOpen={day.label === "Today" || day.label === "Yesterday"}
        >
          {day.rows.map((row) => {
            const time = new Date(row.timestamp).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            });
            const navigable = !!row.itemId && row.itemName !== "—";
            const orderNavigable = !!row.orderId && !!onOpenInOrders;
            const undoables = row.undoableEvents ?? [];
            const showUndo = !!onUndoEvent && undoables.length > 0;
            const isUndoing = showUndo && undoables.some((u) => u.eventId === undoingEventId);
            const undoPayload = undoables.length === 1 ? undoables[0] : undoables;
            const undoTooltip = undoables.length === 1
              ? UNDO_TOOLTIPS[undoables[0].kind]
              : `Undo all ${undoables.length} usage logs in this row`;
            const clickable = orderNavigable || navigable;
            const onRowClick = () => {
              if (orderNavigable) {
                onOpenInOrders!(row.orderId!);
              } else if (navigable) {
                onViewItemHistory(row.itemId!, row.itemName);
              }
            };
            const rowTitle = row.titleAttr
              ?? (orderNavigable ? "Open this order in the Orders tab"
                : navigable ? `View history for ${row.itemName}`
                : undefined);
            return (
              <div
                key={row.key}
                className="audit-flat-row audit-flat-row--button-host"
                style={{ ["--row-accent" as string]: row.accentColor }}
              >
                <button
                  type="button"
                  className="audit-flat-row-main"
                  onClick={onRowClick}
                  disabled={!clickable}
                  title={rowTitle}
                >
                  <span className="audit-flat-cell audit-flat-time">{time}</span>
                  <span className="audit-flat-cell audit-flat-content">
                    {row.itemName && row.itemName !== "—" ? (
                      <>
                        <span className="audit-flat-itemname">{row.itemName}</span>
                        <span className="audit-flat-summary"> — {row.summary}</span>
                      </>
                    ) : (
                      // Column-level events (no item attached) skip the
                      // itemName + leading separator so we don't render
                      // "— — Column deleted (Notes)".
                      <span className="audit-flat-summary">{row.summary}</span>
                    )}
                  </span>
                  <span className="audit-flat-cell audit-flat-user">
                    <User size={14} />
                    {row.user}
                  </span>
                </button>
                {showUndo && (
                  <button
                    type="button"
                    className="audit-flat-undo-btn"
                    onClick={() => onUndoEvent?.(undoPayload)}
                    disabled={isUndoing}
                    title={undoTooltip}
                  >
                    <RotateCcw size={14} /> {isUndoing ? "Undoing…" : "Undo"}
                  </button>
                )}
              </div>
            );
          })}
        </DaySection>
        );
      })}
    </div>
  );
}

/** Item history flat list — single item, so no item name column. Each event
 *  is one inline-summary row; no expansion, no disclosure. Day collapsibility
 *  matches the main feed. */
function FlatItemHistory({
  events,
  onUndoEvent,
  undoingEventId,
}: {
  events: AuditEvent[];
  onUndoEvent?: (undoable: UndoableEvent | UndoableEvent[]) => void;
  undoingEventId?: string | null;
}) {
  type HistoryRowData = {
    key: string;
    timestamp: string;
    summary: string;
    accentColor: string;
    user: string;
    titleAttr?: string;
    undoableEvent?: UndoableEvent;
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
      undoableEvent: detectUndoable(e),
    };
  });
  const days = groupByDay(items);

  return (
    <div className="audit-flat-feed audit-flat-feed--history">
      {days.map((day) => {
        const rowCount = day.rows.length;
        const userCount = day.users.size;
        const summary =
          `${rowCount} change${rowCount !== 1 ? "s" : ""}` +
          (userCount > 0 ? ` · ${userCount} user${userCount !== 1 ? "s" : ""}` : "");
        return (
        <DaySection
          key={day.label}
          label={day.label}
          summary={summary}
          defaultOpen={day.label === "Today" || day.label === "Yesterday"}
        >
          {day.rows.map((row) => {
            const time = new Date(row.timestamp).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            });
            const showUndo = !!onUndoEvent && !!row.undoableEvent;
            const isUndoing = showUndo && undoingEventId === row.undoableEvent?.eventId;
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
                  <User size={14} />
                  {row.user}
                </span>
                {showUndo && (
                  <button
                    type="button"
                    className="audit-flat-undo-btn"
                    onClick={() => onUndoEvent?.(row.undoableEvent!)}
                    disabled={isUndoing}
                    title={UNDO_TOOLTIPS[row.undoableEvent!.kind]}
                  >
                    <RotateCcw size={14} /> {isUndoing ? "Undoing…" : "Undo"}
                  </button>
                )}
              </div>
            );
          })}
        </DaySection>
        );
      })}
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

/** Money formatter for CSV cells. Unlike formatUsd (display), this emits a
 *  plain 2-decimal number with no "$" or thousands separators so spreadsheets
 *  parse it as a number, and truncates float noise (0.44789999… → "0.45"). */
function formatMoneyCsv(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

const REASON_LABELS: Record<string, string> = {
  expired: "Expired",
  damaged: "Damaged",
  lost: "Lost",
  recalled: "Recalled",
  discontinued: "Discontinued",
  donated: "Donated",
  // Loss-kind adjustment reason (manual reconciliation). "damaged" shares the
  // bucket above; shrinkage is adjustment-only.
  shrinkage: "Shrinkage",
  unknown: "Unknown",
};

/** Per-row YoY comparison summary. `pct` is signed; `direction` controls the
 *  triangle glyph and color so the same shape works for "spend rose" (▲ red)
 *  and "loss rose" (▲ red) consistently. `previous` is the comparison value. */
type DeltaInfo = {
  pct: number | null;        // null → no comparable previous data
  direction: "up" | "down" | "flat" | "none";
  previous: number;
  /** True when "up" is bad (e.g. spend, loss). Used to flip the color. */
  upIsBad?: boolean;
};

/** Computes a DeltaInfo from current/previous values + an upIsBad flag. */
function computeDelta(current: number, previous: number | undefined, upIsBad = false): DeltaInfo {
  const prev = Number.isFinite(previous) ? Number(previous) : 0;
  if (!Number.isFinite(prev) || prev === 0) {
    // Can't divide by zero — surface "new" instead of fake percentages.
    if (current > 0) return { pct: null, direction: "up", previous: 0, upIsBad };
    return { pct: null, direction: "none", previous: 0, upIsBad };
  }
  const delta = current - prev;
  const pct = (delta / prev) * 100;
  const direction = Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down";
  return { pct, direction, previous: prev, upIsBad };
}

function DeltaChip({ delta, compact = false }: { delta: DeltaInfo; compact?: boolean }) {
  if (delta.direction === "none") return null;
  const isUp = delta.direction === "up";
  const isFlat = delta.direction === "flat";
  // Color logic: "good" = green, "bad" = red, "flat" = muted. upIsBad flips the
  // sign for spend/loss so a rising loss reads red even though the % is +12%.
  const goodWhenUp = !delta.upIsBad;
  const tone = isFlat
    ? "flat"
    : (isUp === goodWhenUp ? "good" : "bad");
  const arrow = isFlat ? "·" : isUp ? "▲" : "▼";
  const label = delta.pct === null
    ? (isUp ? "new" : "—")
    : `${Math.abs(delta.pct).toFixed(delta.pct < 10 ? 1 : 0)}%`;
  return (
    <span className={`audit-delta-chip audit-delta-chip--${tone}${compact ? " audit-delta-chip--compact" : ""}`}>
      {arrow} {label}
    </span>
  );
}

function SimpleBarChart({
  data,
  labelKey,
  valueKey,
  title,
  formatValue,
  onRowClick,
  rowKey,
  rowDelta,
  emptyHint,
  viewAllCount,
  onViewAll,
}: {
  data: Array<Record<string, unknown>>;
  labelKey: string;
  valueKey: string;
  title: string;
  /** Optional value formatter — defaults to integer toLocaleString. */
  formatValue?: (value: number) => string;
  /** When set, each row's label becomes a button. Receives the raw row. */
  onRowClick?: (row: Record<string, unknown>) => void;
  /** Optional row key for keying — defaults to label. Use when labels can repeat. */
  rowKey?: (row: Record<string, unknown>, index: number) => string;
  /** Optional per-row YoY delta: returns the rendered chip ("▲ 12%") or null. */
  rowDelta?: (row: Record<string, unknown>) => DeltaInfo | null;
  /** Override the default empty-state hint. */
  emptyHint?: string;
  /** Pre-cap total. When > data.length, renders a "View all (N)" header link. */
  viewAllCount?: number;
  /** Called when the View all link is clicked. */
  onViewAll?: () => void;
}) {
  const showViewAll = !!onViewAll && typeof viewAllCount === "number" && viewAllCount > data.length;
  if (!data.length) return (
    <div className="audit-chart-card">
      <h4 className="audit-chart-title">{title}</h4>
      <p className="audit-empty">{emptyHint ?? "No data for this period."}</p>
    </div>
  );
  const max = Math.max(...data.map((d) => Number(d[valueKey] ?? 0)), 1);
  const fmt = formatValue ?? ((v: number) => Math.round(v).toLocaleString());
  return (
    <div className="audit-chart-card">
      <div className="audit-chart-header">
        <h4 className="audit-chart-title">{title}</h4>
        {showViewAll ? (
          <button
            type="button"
            className="audit-chart-view-all"
            onClick={onViewAll}
            title={`See all ${viewAllCount} items in a side panel`}
          >
            View all ({viewAllCount})
          </button>
        ) : null}
      </div>
      <div className="audit-bar-chart">
        {data.slice(0, 10).map((d, i) => {
          const val = Number(d[valueKey] ?? 0);
          const pct = Math.max((val / max) * 100, 2);
          const labelText = String(d[labelKey] ?? "");
          const k = rowKey ? rowKey(d, i) : `${labelText}::${i}`;
          const delta = rowDelta ? rowDelta(d) : null;
          return (
            <div key={k} className="audit-bar-row">
              {onRowClick ? (
                <button
                  type="button"
                  className="audit-bar-label audit-bar-label--clickable"
                  title={labelText}
                  onClick={() => onRowClick(d)}
                >
                  {labelText.slice(0, 24)}
                </button>
              ) : (
                <span className="audit-bar-label" title={labelText}>
                  {labelText.slice(0, 24)}
                </span>
              )}
              <div className="audit-bar-track">
                <div className="audit-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="audit-bar-value">{fmt(val)}</span>
              {delta ? <DeltaChip delta={delta} compact /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Daily usage cost — one bar per day. Bars scale to the max spend day; the
 *  qty appears in the hover tooltip alongside the dollar value. The header
 *  carries the period total + a count of days with activity so the chart
 *  isn't useless at a glance — even if every bar is tiny, the header
 *  summarizes the period in plain numbers. */
function UsageLineChart({ data }: { data: Array<{ date: string; totalUsed: number; totalSpend: number }> }) {
  if (!data.length) return <p className="audit-empty">No usage data for this period.</p>;
  const maxSpend = Math.max(...data.map((d) => d.totalSpend), 0);
  const totalSpend = data.reduce((sum, d) => sum + d.totalSpend, 0);
  const totalQty = data.reduce((sum, d) => sum + d.totalUsed, 0);
  const activeDays = data.filter((d) => d.totalUsed > 0).length;
  // Use spend if we have any priced usage; else fall back to qty so the chart
  // still draws something for orgs that haven't filled in unit costs yet.
  const useSpend = maxSpend > 0;
  const max = useSpend ? maxSpend : Math.max(...data.map((d) => d.totalUsed), 1);

  return (
    <div className="audit-chart-card audit-chart-card--bars">
      <div className="audit-chart-header">
        {/* Title now reads "Spend over time" because the bars render in $ when
            we have priced usage. The fallback to qty is kept for orgs that
            haven't filled in unit costs yet — title stays accurate either way
            via the summary line. */}
        <h4 className="audit-chart-title">{useSpend ? "Spend over time" : "Usage over time"}</h4>
        <span className="audit-chart-summary">
          {useSpend ? formatUsd(totalSpend) : `${formatQty(totalQty)} used`}
          <span className="audit-chart-summary-sub">
            {" "}· {activeDays} active day{activeDays !== 1 ? "s" : ""}
          </span>
        </span>
      </div>
      <div className="audit-bar-chart-rows">
        {data.map((d) => {
          const value = useSpend ? d.totalSpend : d.totalUsed;
          const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
          return (
            <div key={d.date} className="audit-bar-chart-row" title={`${formatDate(d.date)}: ${formatUsd(d.totalSpend)} (${d.totalUsed} used)`}>
              <span className="audit-bar-chart-row-label">{formatDate(d.date)}</span>
              <div className="audit-bar-track">
                <div className="audit-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="audit-bar-chart-row-value">
                {useSpend ? formatUsd(d.totalSpend) : formatQty(d.totalUsed)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, delta }: {
  label: string;
  value: string;
  sub?: string;
  /** Optional YoY comparison vs the previous period. Renders a chip below the
   *  label so the headline number stays the visual anchor. */
  delta?: DeltaInfo | null;
}) {
  return (
    <div className="audit-stat-card">
      <div className="audit-stat-card-body">
        <span className="audit-stat-value">{value}</span>
        <span className="audit-stat-label">{label}</span>
        {sub ? <span className="audit-stat-sub">{sub}</span> : null}
        {delta ? <DeltaChip delta={delta} /> : null}
      </div>
    </div>
  );
}

/** Slice C: vendor drill-in. Click a vendor row in "Top vendors by spend" and
 *  this drawer slides in showing every item bought from that vendor in the
 *  current period — total spend, qty received, and unit-cost range so you can
 *  spot price drift across orders. */
function VendorDrillInPanel({
  vendor,
  period,
  locationId,
  onClose,
  onViewItemHistory,
}: {
  vendor: string;
  period: "7d" | "30d" | "90d";
  /** Pass-through scope from the Analytics tab — the drill-in honors the
   *  same per-location filter so totals reconcile with the chart row. */
  locationId?: string;
  onClose: () => void;
  onViewItemHistory?: (itemId: string, name: string) => void;
}) {
  const [data, setData] = useState<VendorBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchVendorBreakdown({ vendor, period, ...(locationId ? { locationId } : {}) })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load vendor breakdown."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vendor, period, locationId]);

  return (
    <div className="audit-vendor-drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="audit-vendor-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${vendor} breakdown`}
      >
        <div className="audit-vendor-drawer-header">
          <div>
            <p className="audit-vendor-drawer-eyebrow">Vendor</p>
            <h3 className="audit-vendor-drawer-title">{vendor}</h3>
          </div>
          <button
            type="button"
            className="audit-vendor-drawer-close"
            onClick={onClose}
            aria-label="Close vendor breakdown"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? <LoadingState /> : null}
        {!loading && error ? <p className="audit-error">{error}</p> : null}

        {!loading && !error && data ? (
          <>
            <div className="audit-vendor-drawer-totals">
              <div>
                <span className="audit-stat-value">{formatUsd(data.totals.spend)}</span>
                <span className="audit-stat-label">Spend</span>
              </div>
              <div>
                <span className="audit-stat-value">{data.totals.itemCount}</span>
                <span className="audit-stat-label">Items</span>
              </div>
              <div>
                <span className="audit-stat-value">{data.totals.orderCount}</span>
                <span className="audit-stat-label">Orders</span>
              </div>
            </div>

            {data.items.length === 0 ? (
              <p className="audit-empty">No data for this period.</p>
            ) : (
              <table className="audit-vendor-drawer-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="audit-vendor-drawer-num">Qty</th>
                    <th className="audit-vendor-drawer-num">Spend</th>
                    <th className="audit-vendor-drawer-num">Avg unit</th>
                    <th className="audit-vendor-drawer-num">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => {
                    const rangeText = row.minUnitCost === row.maxUnitCost
                      ? "—"
                      : `${formatUsd(row.minUnitCost)} – ${formatUsd(row.maxUnitCost)}`;
                    return (
                      <tr key={row.itemId || row.itemName}>
                        <td>
                          {row.itemId && onViewItemHistory ? (
                            <button
                              type="button"
                              className="audit-event-item-link"
                              onClick={() => onViewItemHistory(row.itemId, row.itemName)}
                              title={`View activity for ${row.itemName}`}
                            >
                              {row.itemName}
                            </button>
                          ) : row.itemName}
                        </td>
                        <td className="audit-vendor-drawer-num">{formatQty(row.qty)}</td>
                        <td className="audit-vendor-drawer-num">{formatUsd(row.spend)}</td>
                        <td className="audit-vendor-drawer-num">{formatUsd(row.avgUnitCost)}</td>
                        <td className="audit-vendor-drawer-num audit-vendor-drawer-range">{rangeText}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </aside>
    </div>
  );
}

/** Side drawer that shows the full breakdown (uncapped) for one analytics
 *  chart. Reuses the chart card visual language so opening it feels like
 *  zooming into the top-10 card, not jumping to a different surface.
 *  Includes a search box for long lists and an Export CSV button so buyers
 *  can grab the raw numbers without us needing to build per-column sort
 *  primitives. */
type BreakdownScope = "purchased" | "used" | "vendors" | "retired";

const BREAKDOWN_TITLES: Record<BreakdownScope, string> = {
  purchased: "All items by purchase cost",
  used: "All items used",
  vendors: "All vendors by spend",
  retired: "All items retired",
};

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row
      .map((cell) => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function BreakdownDrawer({
  scope,
  period,
  locationId,
  locationName,
  onClose,
  onViewItemHistory,
  onViewVendor,
}: {
  scope: BreakdownScope;
  period: "7d" | "30d" | "90d";
  locationId?: string;
  /** When set, suffixes the title and the export filename. */
  locationName?: string;
  onClose: () => void;
  onViewItemHistory?: (itemId: string, name: string) => void;
  onViewVendor?: (vendor: string) => void;
}) {
  const [data, setData] = useState<AnalyticsBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Dual-axis scopes (Used, Retired) carry both qty + $; this toggle picks
   *  which axis the rows sort by. For Retired the default is "cost" since
   *  that's the primary question ("which items cost us most to retire?"). */
  const [dualAxisSortBy, setDualAxisSortBy] = useState<"qty" | "cost">(
    scope === "retired" ? "cost" : "qty",
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAnalyticsBreakdown({ scope, period, ...(locationId ? { locationId } : {}) })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load breakdown."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, period, locationId]);

  const titleSuffix = locationName ? ` · ${locationName}` : "";
  const periodLabel = period === "7d" ? "Last 7 days" : period === "30d" ? "Last 30 days" : "Last 90 days";

  // Normalize the scope-shaped response into a flat row list + label/value
  // pair the renderer doesn't have to switch on.
  type FlatRow = { key: string; label: string; value: number; itemId?: string; vendor?: string; row: Record<string, unknown> };
  let rows: FlatRow[] = [];
  let valueFormatter: (n: number) => string = formatUsd;
  if (data?.scope === "purchased") {
    rows = data.items.map((r) => ({
      key: r.itemId || r.itemName,
      label: r.itemName,
      value: r.spend,
      itemId: r.itemId,
      row: r as unknown as Record<string, unknown>,
    }));
  } else if (data?.scope === "used") {
    const sorted = [...data.items].sort((a, b) =>
      dualAxisSortBy === "cost" ? b.cost - a.cost : b.qtyUsed - a.qtyUsed,
    );
    rows = sorted.map((r) => ({
      key: r.itemId || r.itemName,
      label: r.itemName,
      value: dualAxisSortBy === "cost" ? r.cost : r.qtyUsed,
      itemId: r.itemId,
      row: r as unknown as Record<string, unknown>,
    }));
    valueFormatter = dualAxisSortBy === "cost" ? formatUsd : formatQty;
  } else if (data?.scope === "retired") {
    const sorted = [...data.items].sort((a, b) =>
      dualAxisSortBy === "cost" ? b.value - a.value : b.qtyRetired - a.qtyRetired,
    );
    rows = sorted.map((r) => ({
      key: r.itemId || r.itemName,
      label: r.itemName,
      value: dualAxisSortBy === "cost" ? r.value : r.qtyRetired,
      itemId: r.itemId,
      row: r as unknown as Record<string, unknown>,
    }));
    valueFormatter = dualAxisSortBy === "cost" ? formatUsd : formatQty;
  } else if (data?.scope === "vendors") {
    rows = data.vendors.map((r) => ({
      key: r.vendor,
      label: r.vendor,
      value: r.spend,
      vendor: r.vendor,
      row: r as unknown as Record<string, unknown>,
    }));
  }

  const normalizedSearch = search.trim().toLowerCase();
  const filteredRows = normalizedSearch
    ? rows.filter((r) => r.label.toLowerCase().includes(normalizedSearch))
    : rows;
  const max = filteredRows.length > 0 ? Math.max(...filteredRows.map((r) => r.value), 1) : 1;

  const handleExport = () => {
    const safeLocation = locationName ? `-${locationName.replace(/[^a-z0-9]+/gi, "-")}` : "";
    const filename = `wickops-${scope}${safeLocation}-${period}.csv`;
    if (data?.scope === "purchased") {
      const header = ["Item", "Spend", "Qty received"];
      const body = data.items.map((r) => [r.itemName, formatMoneyCsv(r.spend), String(r.qtyReceived)]);
      downloadCsv(filename, [header, ...body]);
      return;
    }
    if (data?.scope === "used") {
      const header = ["Item", "Qty used", "Cost"];
      const body = data.items.map((r) => [r.itemName, String(r.qtyUsed), formatMoneyCsv(r.cost)]);
      downloadCsv(filename, [header, ...body]);
      return;
    }
    if (data?.scope === "retired") {
      const header = ["Item", "Qty retired", "Value"];
      const body = data.items.map((r) => [r.itemName, String(r.qtyRetired), formatMoneyCsv(r.value)]);
      downloadCsv(filename, [header, ...body]);
      return;
    }
    if (data?.scope === "vendors") {
      const header = ["Vendor", "Spend", "Order count"];
      const body = data.vendors.map((r) => [r.vendor, formatMoneyCsv(r.spend), String(r.orderCount)]);
      downloadCsv(filename, [header, ...body]);
      return;
    }
  };

  return (
    <div className="audit-vendor-drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="audit-vendor-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${BREAKDOWN_TITLES[scope]} breakdown`}
      >
        <div className="audit-vendor-drawer-header">
          <div>
            <h3 className="audit-vendor-drawer-title">{BREAKDOWN_TITLES[scope]}{titleSuffix}</h3>
            <p className="audit-vendor-drawer-sub">{periodLabel}</p>
          </div>
          <button
            type="button"
            className="audit-vendor-drawer-close"
            onClick={onClose}
            aria-label="Close breakdown"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <LoadingState />
        ) : error ? (
          <p className="audit-empty">{error}</p>
        ) : (
          <>
            <div className="audit-breakdown-toolbar">
              <label className="audit-breakdown-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  className="field"
                  placeholder={scope === "vendors" ? "Search vendors…" : "Search items…"}
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                />
              </label>
              {(scope === "used" || scope === "retired") ? (
                <div className="audit-breakdown-axis-toggle" role="tablist" aria-label="Sort axis">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dualAxisSortBy === "qty"}
                    className={`audit-top-items-tab ${dualAxisSortBy === "qty" ? "is-active" : ""}`}
                    onClick={() => setDualAxisSortBy("qty")}
                  >
                    Qty
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={dualAxisSortBy === "cost"}
                    className={`audit-top-items-tab ${dualAxisSortBy === "cost" ? "is-active" : ""}`}
                    onClick={() => setDualAxisSortBy("cost")}
                  >
                    $
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="button button-ghost button-sm audit-breakdown-export"
                onClick={handleExport}
                disabled={rows.length === 0}
              >
                Export CSV
              </button>
            </div>

            <div className="audit-breakdown-meta">
              {filteredRows.length} of {rows.length} shown
            </div>

            {filteredRows.length === 0 ? (
              <p className="audit-empty">No matches.</p>
            ) : (
              <div className="audit-bar-chart audit-breakdown-list">
                {filteredRows.map((r) => {
                  const pct = Math.max((r.value / max) * 100, 2);
                  const clickable =
                    (scope !== "vendors" && !!onViewItemHistory && !!r.itemId)
                    || (scope === "vendors" && !!onViewVendor && !!r.vendor);
                  return (
                    <div key={r.key} className="audit-bar-row">
                      {clickable ? (
                        <button
                          type="button"
                          className="audit-bar-label audit-bar-label--clickable"
                          title={r.label}
                          onClick={() => {
                            if (scope === "vendors" && onViewVendor && r.vendor) {
                              onViewVendor(r.vendor);
                            } else if (onViewItemHistory && r.itemId) {
                              onViewItemHistory(r.itemId, r.label);
                            }
                          }}
                        >
                          {r.label.slice(0, 40)}
                        </button>
                      ) : (
                        <span className="audit-bar-label" title={r.label}>
                          {r.label.slice(0, 40)}
                        </span>
                      )}
                      <div className="audit-bar-track">
                        <div className="audit-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="audit-bar-value">{valueFormatter(r.value)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}


function AnalyticsDashboard({
  analytics,
  locationName,
  onViewItemHistory,
  onViewVendor,
  onOpenBreakdown,
}: {
  analytics: AuditAnalytics;
  /** When set, every section title gets a " · {locationName}" suffix so
   *  it's obvious the numbers are scoped, not org-wide. */
  locationName?: string;
  onViewItemHistory?: (itemId: string, name: string) => void;
  /** Slice C: click a vendor row → open the vendor drill-in panel. */
  onViewVendor?: (vendor: string) => void;
  /** "View all (N)" link on each chart card opens the breakdown drawer. */
  onOpenBreakdown?: (scope: BreakdownScope) => void;
}) {
  const titleSuffix = locationName ? ` · ${locationName}` : "";
  const { totals, usageOverTime, byVendor, bySpendItem, byUsageItem, byRetiredItem, lossByReason } = analytics;
  const previous = analytics.previous;

  // Top items chart toggle. Three lenses on the same item set:
  //   purchased — RESTOCK $ (procurement)
  //   usedCost  — qty used × unit cost (consumption $)
  //   usedQty   — qty used (consumption units)
  // One card, one mental model: "rank items by …".
  type TopItemsView = "purchased" | "usedCost" | "usedQty";
  const [topItemsView, setTopItemsView] = useState<TopItemsView>("purchased");
  // Top retired items chart toggle. Default to $ since the primary
  // question for "what's being thrown out" is the financial impact.
  type RetiredItemsView = "cost" | "qty";
  const [retiredItemsView, setRetiredItemsView] = useState<RetiredItemsView>("cost");

  const hasData =
    totals.qtyUsed > 0
    || totals.spend > 0
    || totals.lossQty > 0
    || usageOverTime.length > 0;

  // Per-row delta lookups for the bar charts. When YoY isn't on, these are
  // undefined and the chart renders without any delta column.
  const prevByVendor = previous
    ? new Map(previous.byVendor.map((r) => [r.vendor, r.spend]))
    : null;
  const prevBySpendItem = previous
    ? new Map(previous.bySpendItem.map((r) => [r.itemName, r.spend]))
    : null;
  const prevByUsageItem = previous
    ? new Map(previous.byUsageItem.map((r) => [r.itemName, r.qtyUsed]))
    : null;
  const prevByUsageCost = previous
    ? new Map(previous.byUsageItem.map((r) => [r.itemName, r.cost]))
    : null;
  const prevLossByReason = previous
    ? new Map(previous.lossByReason.map((r) => [r.reason, r.qty]))
    : null;

  // Top-level KPI deltas — computed once so the strip render stays terse.
  const deltaQtyUsed = previous ? computeDelta(totals.qtyUsed, previous.totals.qtyUsed, false) : null;
  const deltaSpend = previous ? computeDelta(totals.spend, previous.totals.spend, true) : null;
  const deltaLoss = previous ? computeDelta(totals.lossQty, previous.totals.lossQty, true) : null;

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

      {/* KPI strip — three equal-width cards. Replaces the lopsided 1-wide +
          2-stacked layout. Each card carries an optional YoY delta chip when
          the user has Compare-to-last-year on. */}
      <div className="audit-analytics-summary">
        <StatCard
          label="Items used"
          value={formatQty(totals.qtyUsed)}
          delta={deltaQtyUsed}
        />
        <StatCard
          label="Spend"
          value={formatUsd(totals.spend)}
          delta={deltaSpend}
        />
        <StatCard
          label={totals.lossQty === 1 ? "Item retired" : "Items retired"}
          value={formatQty(totals.lossQty)}
          sub={totals.lossValue > 0 ? `~${formatUsd(totals.lossValue)}` : undefined}
          delta={deltaLoss}
        />
      </div>

      {/* Top items — single tabbed card answers three different questions:
          "what did we buy?" / "what did we burn money on?" / "what did we
          burn through?". Sits next to Top vendors so the spend lens is
          one glance away from "who'd we buy from". */}
      {(bySpendItem.length > 0 || byUsageItem.length > 0 || byVendor.length > 0) ? (
        <section className="audit-analytics-section">
          <h3 className="audit-analytics-section-title">Top items{titleSuffix}</h3>
          <div className="audit-analytics-grid">
            <div className="audit-top-items-card">
              <div className="audit-top-items-tabs" role="tablist" aria-label="Top items view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={topItemsView === "purchased"}
                  className={`audit-top-items-tab ${topItemsView === "purchased" ? "is-active" : ""}`}
                  onClick={() => setTopItemsView("purchased")}
                >
                  Purchased ($)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={topItemsView === "usedCost"}
                  className={`audit-top-items-tab ${topItemsView === "usedCost" ? "is-active" : ""}`}
                  onClick={() => setTopItemsView("usedCost")}
                >
                  Used ($)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={topItemsView === "usedQty"}
                  className={`audit-top-items-tab ${topItemsView === "usedQty" ? "is-active" : ""}`}
                  onClick={() => setTopItemsView("usedQty")}
                >
                  Used (qty)
                </button>
              </div>
              {topItemsView === "purchased" ? (
                <SimpleBarChart
                  data={bySpendItem as unknown as Array<Record<string, unknown>>}
                  labelKey="itemName"
                  valueKey="spend"
                  title="What we bought"
                  formatValue={formatUsd}
                  onRowClick={onViewItemHistory ? (row) => {
                    const itemId = String(row.itemId ?? "");
                    const itemName = String(row.itemName ?? "");
                    if (itemId) onViewItemHistory(itemId, itemName);
                  } : undefined}
                  rowKey={(row) => String(row.itemId ?? row.itemName)}
                  rowDelta={prevBySpendItem ? (row) => computeDelta(
                    Number(row.spend ?? 0),
                    prevBySpendItem.get(String(row.itemName ?? "")),
                    true,
                  ) : undefined}
                  emptyHint="No data for this period."
                  viewAllCount={analytics.totalCounts?.bySpendItem}
                  onViewAll={onOpenBreakdown ? () => onOpenBreakdown("purchased") : undefined}
                />
              ) : topItemsView === "usedCost" ? (
                <SimpleBarChart
                  data={[...byUsageItem]
                    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
                    .slice(0, 10) as unknown as Array<Record<string, unknown>>}
                  labelKey="itemName"
                  valueKey="cost"
                  title="What we burned through ($)"
                  formatValue={formatUsd}
                  onRowClick={onViewItemHistory ? (row) => {
                    const itemId = String(row.itemId ?? "");
                    const itemName = String(row.itemName ?? "");
                    if (itemId) onViewItemHistory(itemId, itemName);
                  } : undefined}
                  rowKey={(row) => String(row.itemId ?? row.itemName)}
                  rowDelta={prevByUsageCost ? (row) => computeDelta(
                    Number(row.cost ?? 0),
                    prevByUsageCost.get(String(row.itemName ?? "")),
                    true,
                  ) : undefined}
                  emptyHint="No data for this period."
                  viewAllCount={analytics.totalCounts?.byUsageItem}
                  onViewAll={onOpenBreakdown ? () => onOpenBreakdown("used") : undefined}
                />
              ) : (
                <SimpleBarChart
                  data={[...byUsageItem]
                    .sort((a, b) => (b.qtyUsed ?? 0) - (a.qtyUsed ?? 0))
                    .slice(0, 10) as unknown as Array<Record<string, unknown>>}
                  labelKey="itemName"
                  valueKey="qtyUsed"
                  title="What we burned through (qty)"
                  formatValue={formatQty}
                  onRowClick={onViewItemHistory ? (row) => {
                    const itemId = String(row.itemId ?? "");
                    const itemName = String(row.itemName ?? "");
                    if (itemId) onViewItemHistory(itemId, itemName);
                  } : undefined}
                  rowKey={(row) => String(row.itemId ?? row.itemName)}
                  rowDelta={prevByUsageItem ? (row) => computeDelta(
                    Number(row.qtyUsed ?? 0),
                    prevByUsageItem.get(String(row.itemName ?? "")),
                    false,
                  ) : undefined}
                  emptyHint="No usage logged in this period."
                  viewAllCount={analytics.totalCounts?.byUsageItem}
                  onViewAll={onOpenBreakdown ? () => onOpenBreakdown("used") : undefined}
                />
              )}
            </div>
            <SimpleBarChart
              data={byVendor as unknown as Array<Record<string, unknown>>}
              labelKey="vendor"
              valueKey="spend"
              title="Top vendors by spend"
              formatValue={formatUsd}
              onRowClick={onViewVendor ? (row) => {
                const vendor = String(row.vendor ?? "");
                if (vendor) onViewVendor(vendor);
              } : undefined}
              rowKey={(row) => String(row.vendor)}
              rowDelta={prevByVendor ? (row) => computeDelta(
                Number(row.spend ?? 0),
                prevByVendor.get(String(row.vendor ?? "")),
                true,
              ) : undefined}
              emptyHint="No vendor-tagged restocks in this period."
              viewAllCount={analytics.totalCounts?.byVendor}
              onViewAll={onOpenBreakdown ? () => onOpenBreakdown("vendors") : undefined}
            />
          </div>
        </section>
      ) : null}

      {/* Trends — usage + spend over time, side by side. */}
      {usageOverTime.length > 0 ? (
        <section className="audit-analytics-section">
          <h3 className="audit-analytics-section-title">Trends{titleSuffix}</h3>
          <UsageLineChart data={usageOverTime} />
        </section>
      ) : null}

      {/* Retired section — top retired items (tabbed by $ / qty) paired
          with the per-reason breakdown. Only renders when there's actually
          retired stock to report. */}
      {(lossRows.length > 0 || byRetiredItem.length > 0) ? (
        <section className="audit-analytics-section">
          <h3 className="audit-analytics-section-title">Retired{titleSuffix}</h3>
          <div className="audit-analytics-grid">
            <div className="audit-top-items-card">
              <div className="audit-top-items-tabs" role="tablist" aria-label="Top retired items view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={retiredItemsView === "cost"}
                  className={`audit-top-items-tab ${retiredItemsView === "cost" ? "is-active" : ""}`}
                  onClick={() => setRetiredItemsView("cost")}
                >
                  Cost ($)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={retiredItemsView === "qty"}
                  className={`audit-top-items-tab ${retiredItemsView === "qty" ? "is-active" : ""}`}
                  onClick={() => setRetiredItemsView("qty")}
                >
                  Qty
                </button>
              </div>
              {retiredItemsView === "cost" ? (
                <SimpleBarChart
                  data={[...byRetiredItem]
                    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
                    .slice(0, 10) as unknown as Array<Record<string, unknown>>}
                  labelKey="itemName"
                  valueKey="value"
                  title="What we threw out ($)"
                  formatValue={formatUsd}
                  onRowClick={onViewItemHistory ? (row) => {
                    const itemId = String(row.itemId ?? "");
                    const itemName = String(row.itemName ?? "");
                    if (itemId) onViewItemHistory(itemId, itemName);
                  } : undefined}
                  rowKey={(row) => String(row.itemId ?? row.itemName)}
                  emptyHint="No priced retires in this period. Set unit costs on items to value loss."
                  viewAllCount={analytics.totalCounts?.byRetiredItem}
                  onViewAll={onOpenBreakdown ? () => onOpenBreakdown("retired") : undefined}
                />
              ) : (
                <SimpleBarChart
                  data={[...byRetiredItem]
                    .sort((a, b) => (b.qtyRetired ?? 0) - (a.qtyRetired ?? 0))
                    .slice(0, 10) as unknown as Array<Record<string, unknown>>}
                  labelKey="itemName"
                  valueKey="qtyRetired"
                  title="What we threw out (qty)"
                  formatValue={formatQty}
                  onRowClick={onViewItemHistory ? (row) => {
                    const itemId = String(row.itemId ?? "");
                    const itemName = String(row.itemName ?? "");
                    if (itemId) onViewItemHistory(itemId, itemName);
                  } : undefined}
                  rowKey={(row) => String(row.itemId ?? row.itemName)}
                  emptyHint="No retires in this period."
                  viewAllCount={analytics.totalCounts?.byRetiredItem}
                  onViewAll={onOpenBreakdown ? () => onOpenBreakdown("retired") : undefined}
                />
              )}
            </div>
            <SimpleBarChart
              data={lossRows as unknown as Array<Record<string, unknown>>}
              labelKey="reasonLabel"
              valueKey="qty"
              title="Retired by reason"
              formatValue={(qty) => {
                // Find the matching row to surface "$X" alongside the qty.
                // SimpleBarChart only passes the value through formatValue,
                // not the whole row, so we look up by exact qty match —
                // safe here because reasons are distinct and the values
                // differ per reason in the common case.
                const row = lossRows.find((r) => r.qty === qty);
                if (!row || !row.value || row.value <= 0) return formatQty(qty);
                return `${formatQty(qty)} · ${formatUsd(row.value)}`;
              }}
              rowKey={(row) => String(row.reason)}
              rowDelta={prevLossByReason ? (row) => computeDelta(
                Number(row.qty ?? 0),
                prevLossByReason.get(String(row.reason ?? "")),
                true,
              ) : undefined}
              emptyHint="No retires in this period."
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AuditLogPage({ canManageColumns, canEditInventory, isSupportView, onOpenInInventory, onOpenInOrders, onTabChange, initialHistoryItem, onHistoryItemConsumed }: AuditLogPageProps) {
  const { isMobile } = useMobileDetect();
  const [tab, setTab] = useState<AuditTab>("feed");
  // Analytics is normally admin-only; a read-only support operator may view it.
  const canViewAnalytics = canManageColumns || !!isSupportView;

  // Notify parent of active sub-tab so subnav-level help can react.
  useEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Client-side search across loaded events. Matches itemName + userName
  // case-insensitively. For history older than what's loaded, the user can
  // still hit Load More and it'll pick up more events to search.
  const [searchTerm, setSearchTerm] = useState("");
  // Optional date range filter on event timestamp. Mirrors the closed-orders
  // popover so the activity feed reads the same way.
  const [feedFromDate, setFeedFromDate] = useState("");
  const [feedToDate, setFeedToDate] = useState("");
  const [feedDateFilterOpen, setFeedDateFilterOpen] = useState(false);
  const feedDateFilterRef = useRef<HTMLDivElement | null>(null);

  // Click outside / Escape closes the date popover.
  useEffect(() => {
    if (!feedDateFilterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!feedDateFilterRef.current) return;
      if (!feedDateFilterRef.current.contains(e.target as Node)) setFeedDateFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFeedDateFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [feedDateFilterOpen]);

  const feedDateRangeLabel = (() => {
    if (!feedFromDate && !feedToDate) return null;
    const fmt = (iso: string) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    if (feedFromDate && feedToDate) return `${fmt(feedFromDate)} – ${fmt(feedToDate)}`;
    if (feedFromDate) return `From ${fmt(feedFromDate)}`;
    return `Until ${fmt(feedToDate)}`;
  })();

  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [historyItemName, setHistoryItemName] = useState("");
  const [historyEvents, setHistoryEvents] = useState<AuditEvent[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySubTab, setHistorySubTab] = useState<"events" | "cost">("events");

  const [analytics, setAnalytics] = useState<AuditAnalytics | null>(null);
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"7d" | "30d" | "90d">("30d");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  /** Per-location scoping for the Analytics tab. "" = org-wide. Persisted
   *  to localStorage so a multi-station chief who lives on Station 3's view
   *  doesn't have to re-select on every reload. */
  const ANALYTICS_LOCATION_STORAGE_KEY = "wickops.analytics.locationId";
  const [analyticsLocationId, setAnalyticsLocationIdState] = useState<string>(() => {
    try { return localStorage.getItem(ANALYTICS_LOCATION_STORAGE_KEY) ?? ""; } catch { return ""; }
  });
  const setAnalyticsLocationId = useCallback((id: string) => {
    setAnalyticsLocationIdState(id);
    try {
      if (id) localStorage.setItem(ANALYTICS_LOCATION_STORAGE_KEY, id);
      else localStorage.removeItem(ANALYTICS_LOCATION_STORAGE_KEY);
    } catch { /* private mode / quota — fine, just don't persist */ }
  }, []);
  const [analyticsLocations, setAnalyticsLocations] = useState<InventoryLocation[]>([]);
  /** Slice C: vendor name currently being drilled into. null = no drawer. */
  const [vendorDrillIn, setVendorDrillIn] = useState<string | null>(null);
  /** Breakdown drawer scope. null = closed. */
  const [breakdownScope, setBreakdownScope] = useState<BreakdownScope | null>(null);

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

  // Bumped after analytics-affecting actions to force a re-fetch. Currently
  // unused — held so a future analytics action (e.g. retroactive price edits
  // somewhere else) can drop in without re-plumbing the dependency.
  const [analyticsRefreshKey] = useState(0);

  useEffect(() => {
    if (tab === "analytics" && canViewAnalytics) {
      setAnalyticsLoading(true);
      fetchAuditAnalytics({
        period: analyticsPeriod,
        ...(analyticsLocationId ? { locationId: analyticsLocationId } : {}),
      })
        .then(setAnalytics)
        .catch(() => setAnalytics(null))
        .finally(() => setAnalyticsLoading(false));
    }
  }, [tab, analyticsPeriod, analyticsLocationId, canViewAnalytics, analyticsRefreshKey]);

  // Lazy-load locations on first mount. Both the Activity feed (order rows
  // append "at {location}" suffix when org has 2+ locations) and the
  // Analytics tab (location filter dropdown) consume the list. Single-
  // location orgs get a length-1 list, so the location selector and the
  // suffix both auto-hide.
  useEffect(() => {
    if (!canManageColumns) return;
    if (analyticsLocations.length > 0) return;
    listInventoryLocations()
      .then((locs) => {
        setAnalyticsLocations(locs);
        // Self-heal a stale selection (location renamed/deleted between
        // sessions): if the persisted id isn't in the list, reset to org-wide.
        if (analyticsLocationId && !locs.some((l) => l.id === analyticsLocationId)) {
          setAnalyticsLocationId("");
        }
      })
      .catch(() => { /* dropdown stays empty; fetchAnalytics still works org-wide */ });
  }, [canManageColumns, analyticsLocations.length, analyticsLocationId, setAnalyticsLocationId]);

  const viewItemHistory = useCallback(async (itemId: string, itemName: string) => {
    setTab("item-history");
    setHistoryItemId(itemId);
    setHistoryItemName(itemName);
    setHistorySubTab("events");
    setHistoryLoading(true);
    try {
      // By NAME so multi-lot items read as one item (all lots merged). The
      // endpoint returns a bounded merged list — no cursor paging.
      const res = await fetchItemHistoryByName(itemName);
      setHistoryEvents(res.events ?? []);
      setHistoryCursor(res.nextCursor);
    } catch {
      setHistoryEvents([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Deep-link consumption: when the parent hands us a target item (e.g. from
  // the pricing modal's "See full activity" link), open its history on the
  // Cost-over-time sub-tab, then clear the target so it doesn't re-fire.
  useEffect(() => {
    if (!initialHistoryItem) return;
    void viewItemHistory(initialHistoryItem.itemId, initialHistoryItem.itemName)
      .then(() => setHistorySubTab("cost"));
    onHistoryItemConsumed?.();
  }, [initialHistoryItem, viewItemHistory, onHistoryItemConsumed]);

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

  // Tracks the in-flight undo so the corresponding row can show a spinner
  // and avoid double-clicks. Cleared once the refresh completes.
  const [undoingEventId, setUndoingEventId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const handleUndoEvent = useCallback(
    async (input: UndoableEvent | UndoableEvent[]) => {
      if (undoingEventId) return;
      const batch = Array.isArray(input) ? input : [input];
      if (batch.length === 0) return;
      const confirmCopy: Record<UndoableKind, string> = {
        usage: "Undo this usage? The decremented quantity will be restored to the item.",
        retire: "Undo this retire? The retire markers will be cleared and the quantity restored.",
        column: "Restore this column? It will be re-added to inventory along with any per-row values.",
      };
      const errorCopy: Record<UndoableKind, string> = {
        usage: "Failed to undo usage.",
        retire: "Failed to undo retire.",
        column: "Failed to restore column.",
      };
      const proceed = batch.length === 1
        ? window.confirm(confirmCopy[batch[0].kind])
        : window.confirm(`Undo all ${batch.length} usage logs in this row? Each decremented quantity will be restored.`);
      if (!proceed) return;
      // Use the first event id as the in-flight sentinel so the row's
      // disabled state lights up while the whole batch runs.
      setUndoingEventId(batch[0].eventId);
      setUndoError(null);
      try {
        for (const undoable of batch) {
          if (undoable.kind === "usage") {
            if (!undoable.itemId) throw new Error("Missing item id for usage undo.");
            await undoUsageEvent(undoable.eventId, undoable.itemId);
          } else if (undoable.kind === "retire") {
            if (!undoable.itemId) throw new Error("Missing item id for retire undo.");
            await undoRetireEvent(undoable.eventId, undoable.itemId);
          } else {
            await undoColumnDeleteEvent(undoable.eventId);
          }
        }
        // Re-fetch so the row picks up `details.undone` from the server. We
        // refresh both the main feed and the open item history (whichever is
        // visible), so the Undo button hides immediately without another click.
        if (tab === "feed") {
          await loadFeed(false);
        } else if (tab === "item-history" && historyItemName) {
          const res = await fetchItemHistoryByName(historyItemName);
          setHistoryEvents(res.events ?? []);
          setHistoryCursor(res.nextCursor);
        }
      } catch (err: unknown) {
        setUndoError(err instanceof Error ? err.message : errorCopy[batch[0].kind]);
      } finally {
        setUndoingEventId(null);
      }
    },
    [undoingEventId, tab, historyItemId, loadFeed],
  );

  const undoCallback = canEditInventory ? handleUndoEvent : undefined;

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
  const feedFromMs = feedFromDate ? new Date(feedFromDate).getTime() : null;
  // Inclusive "to" — bump to end of day so a single-day filter still catches
  // events from later that day.
  const feedToMs = feedToDate
    ? new Date(feedToDate).getTime() + 24 * 60 * 60 * 1000 - 1
    : null;
  const visibleEvents = noiseFreeEvents.filter((e) => {
    if (feedFromMs !== null || feedToMs !== null) {
      const ts = new Date(e.timestamp).getTime();
      if (feedFromMs !== null && ts < feedFromMs) return false;
      if (feedToMs !== null && ts > feedToMs) return false;
    }
    if (!normalizedSearch) return true;
    const hay = `${e.itemName ?? ""} ${e.userName ?? ""} ${e.userEmail ?? ""}`.toLowerCase();
    return hay.includes(normalizedSearch);
  });


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
        {canViewAnalytics && (
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
                  <X size={14} />
                </button>
              ) : null}
            </div>
            <div className="audit-filter-container" ref={feedDateFilterRef}>
              <button
                type="button"
                className={`button button-secondary button-sm closed-orders-daterange-toggle${
                  feedDateRangeLabel ? " active" : ""
                }`}
                onClick={() => setFeedDateFilterOpen((o) => !o)}
                aria-expanded={feedDateFilterOpen}
                aria-haspopup="dialog"
              >
                <Calendar size={14} />
                {feedDateRangeLabel ?? "Date range"}
              </button>
              {feedDateFilterOpen && (
                <div
                  className="audit-filter-menu closed-orders-daterange-menu"
                  role="dialog"
                  aria-label="Filter activity by date"
                >
                  <div className="closed-orders-daterange-fields">
                    <label className="closed-orders-daterange-field">
                      <span>From</span>
                      <input
                        className="field"
                        type="date"
                        value={feedFromDate}
                        onChange={(e) => setFeedFromDate(e.target.value)}
                      />
                    </label>
                    <label className="closed-orders-daterange-field">
                      <span>To</span>
                      <input
                        className="field"
                        type="date"
                        value={feedToDate}
                        onChange={(e) => setFeedToDate(e.target.value)}
                      />
                    </label>
                  </div>
                  {(feedFromDate || feedToDate) && (
                    <button
                      type="button"
                      className="button button-secondary button-sm closed-orders-daterange-clear"
                      onClick={() => {
                        setFeedFromDate("");
                        setFeedToDate("");
                      }}
                    >
                      Clear dates
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {error && <p className="audit-error">{error}</p>}

          {!loading && events.length === 0 && (
            <EmptyState
              icon={Clock}
              title="No activity recorded yet"
              hint="Changes to inventory, usage approvals, and column edits will appear here."
            />
          )}

          {undoError && <p className="audit-error">{undoError}</p>}

          {visibleEvents.length > 0 && (
            isMobile ? (
              <AuditMobileFeed
                events={visibleEvents}
                onViewItemHistory={viewItemHistory}
                onOpenInOrders={onOpenInOrders}
                hasMultipleLocations={analyticsLocations.length > 1}
                onUndoEvent={undoCallback}
                undoingEventId={undoingEventId}
              />
            ) : (
              <FlatActivityFeed
                events={visibleEvents}
                onViewItemHistory={viewItemHistory}
                onOpenInOrders={onOpenInOrders}
                hasMultipleLocations={analyticsLocations.length > 1}
                onUndoEvent={undoCallback}
                undoingEventId={undoingEventId}
              />
            )
          )}

          {loading && <LoadingState />}

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

          <div className="audit-item-history-subtabs" role="tablist" aria-label="Item history view">
            <button
              type="button"
              role="tab"
              aria-selected={historySubTab === "events"}
              className={`audit-item-history-subtab${historySubTab === "events" ? " active" : ""}`}
              onClick={() => setHistorySubTab("events")}
            >
              Activity
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={historySubTab === "cost"}
              className={`audit-item-history-subtab${historySubTab === "cost" ? " active" : ""}`}
              onClick={() => setHistorySubTab("cost")}
            >
              Cost over time
            </button>
          </div>

          {historyLoading && historyEvents.length === 0 && <LoadingState />}

          {!historyLoading && historyEvents.length === 0 && (
            <EmptyState icon={Clock} title="No history for this item" />
          )}

          {historySubTab === "events" && undoError && (
            <p className="audit-error">{undoError}</p>
          )}

          {historySubTab === "events" && visibleHistoryEvents.length > 0 && (
            <FlatItemHistory
              events={visibleHistoryEvents}
              onUndoEvent={undoCallback}
              undoingEventId={undoingEventId}
            />
          )}

          {historySubTab === "cost" && historyEvents.length > 0 && (
            <CostOverTime events={historyEvents} />
          )}

          {historySubTab === "events"
            && !historyLoading
            && historyCursor
            && historyEvents.length >= LOAD_MORE_THRESHOLD && (
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

      {tab === "analytics" && canViewAnalytics && (
        <div className="audit-analytics">
          {/* Location (scope) on the left, period (window) on the right.
              Reads "Station 3, last 30 days" — location is the primary lens,
              period narrows the time. Period is a dropdown so a future
              "Custom range…" option slots in naturally. */}
          <div className="audit-period-selector">
            {analyticsLocations.length > 1 && (
              <label className="audit-location-selector">
                <MapPin size={14} className="audit-location-selector-icon" aria-hidden="true" />
                {/* Stations are selectable (roll-up across their cabinets, shown
                    as "· all") in addition to each leaf — matching the Reorder
                    picker. The backend expands a station id to its subtree. */}
                <CustomDropdown
                  ariaLabel="Filter analytics by location"
                  value={analyticsLocationId}
                  onChange={(next) => setAnalyticsLocationId(next)}
                  options={[
                    { value: "", label: "All locations" },
                    ...buildLocationPickerEntries(analyticsLocations).map((entry) => ({
                      value: entry.id,
                      label: entry.label,
                      depth: entry.depth,
                      ...(entry.isStation ? { hint: "· all" } : {}),
                    })),
                  ]}
                />
              </label>
            )}
            <label className="audit-period-dropdown">
              <Calendar size={14} className="audit-period-dropdown-icon" aria-hidden="true" />
              <select
                className="field"
                value={analyticsPeriod}
                onChange={(e) => setAnalyticsPeriod(e.currentTarget.value as "7d" | "30d" | "90d")}
                aria-label="Analytics time window"
              >
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </select>
            </label>
          </div>

          {analyticsLoading && <LoadingState />}

          {!analyticsLoading && analytics && (
            <AnalyticsDashboard
              analytics={analytics}
              locationName={analyticsLocations.find((l) => l.id === analyticsLocationId)?.name}
              onViewItemHistory={viewItemHistory}
              onViewVendor={(vendor) => setVendorDrillIn(vendor)}
              onOpenBreakdown={(scope) => setBreakdownScope(scope)}
            />
          )}

          {vendorDrillIn ? (
            <VendorDrillInPanel
              vendor={vendorDrillIn}
              period={analyticsPeriod}
              locationId={analyticsLocationId || undefined}
              onClose={() => setVendorDrillIn(null)}
              onViewItemHistory={viewItemHistory}
            />
          ) : null}

          {breakdownScope ? (
            <BreakdownDrawer
              scope={breakdownScope}
              period={analyticsPeriod}
              locationId={analyticsLocationId || undefined}
              locationName={analyticsLocations.find((l) => l.id === analyticsLocationId)?.name}
              onClose={() => setBreakdownScope(null)}
              onViewItemHistory={viewItemHistory}
              onViewVendor={(vendor) => {
                setBreakdownScope(null);
                setVendorDrillIn(vendor);
              }}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
