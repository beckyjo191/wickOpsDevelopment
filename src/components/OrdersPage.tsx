import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import { HelpModal } from "./shared/HelpModal";
import { EmptyState } from "./shared/EmptyState";
import { LoadingState } from "./shared/LoadingState";
import { DaySection } from "../lib/dayGroups";
import { dayGroupLabel } from "../lib/dayGroupLabel";
import {
  addInventoryVendor,
  closeRestockOrder,
  createRestockOrder,
  listRestockOrders,
  loadInventoryBootstrap,
  receiveRestockOrder,
  saveInventoryItems,
  type InventoryLocation,
  type InventoryRow,
  type RestockOrder,
  type RestockOrderItem,
  type RestockReceiveLine,
} from "../lib/inventoryApi";
import { ReorderTab, VendorSelect, type OrderItem } from "./ReorderTab";
import { formatCurrency, parseCurrency } from "../lib/currency";


interface OrdersPageProps {
  selectedLocationId?: string | null;
  /** Optional: lets the user change scope from inside Orders without
   *  flipping back to Inventory. When omitted the dropdown is read-only. */
  onSelectedLocationIdChange?: (locationId: string | null) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function orderTotalCost(items: RestockOrderItem[]): number | null {
  const itemsWithCost = items.filter((i) => i.unitCost !== undefined);
  if (itemsWithCost.length === 0) return null;
  return itemsWithCost.reduce((sum, i) => sum + (i.unitCost ?? 0) * i.qtyOrdered, 0);
}

function StatusBadge({ status, cancelled }: { status: RestockOrder["status"]; cancelled?: boolean }) {
  if (cancelled) {
    return <span className="badge badge--uppercase badge--danger">Cancelled</span>;
  }
  const map = {
    open: { label: "Ordered", className: "badge badge--uppercase badge--primary" },
    partial: { label: "Partially Received", className: "badge badge--uppercase badge--warning" },
    closed: { label: "Completed", className: "badge badge--uppercase badge--neutral" },
  };
  const { label, className } = map[status];
  return <span className={className}>{label}</span>;
}

// ── Receive Form ───────────────────────────────────────────────────────────

type ReceiveLine = {
  itemId: string;
  itemName: string;
  isFreeform: boolean;
  qtyOrdered: number;
  qtyReceived: number;
  qtyRemaining: number;
  qtyThisReceive: string;
  expirationDate: string;
  unitCost: string;
  addToInventory: boolean;
  /** True when this specific item has an expiration date on its inventory row.
   *  Drives whether the expiration input shows + whether it's required. */
  tracksExpiration: boolean;
  /** User-toggled "+ Add expiration" for items that don't currently track one.
   *  Lets you stamp an expiration date during receive even if the item was
   *  previously treated as permanent. Always optional — never validated. */
  showExpirationInput: boolean;
  /** Pack size from the item's inventory row. >0 enables "Received by box?"
   *  mode where the user enters boxes + box cost instead of units + unit cost. */
  packSize: number;
  /** Box mode toggle (only meaningful when packSize > 0). When true,
   *  qtyThisReceive is in BOXES and unitCost is the PER-BOX price. We convert
   *  back to units on submit. */
  receivingAsBoxes: boolean;
  error: string;
};

function ReceiveOrderForm({
  order,
  hasExpirationColumn,
  inventoryRows,
  onReceived,
  onCancel,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  /** Current inventory rows — used to pre-fill unit cost from the row's
   *  cached latest price when the order item itself doesn't carry one. */
  inventoryRows: InventoryRow[];
  onReceived: () => void;
  onCancel: () => void;
}) {
  const pendingItems = order.items.filter((i) => i.qtyReceived < i.qtyOrdered);
  const [lines, setLines] = useState<ReceiveLine[]>(
    pendingItems.map((i) => {
      const freeform = i.itemId.startsWith("freeform-");
      // Pre-fill unit cost from (in order of freshness):
      //   1. the order item itself (captured during a prior partial receive)
      //   2. the inventory row's cached latest price (from past restocks)
      // User can override in the input.
      let prefillUnitCost: number | undefined = i.unitCost;
      let tracksExpiration = false;
      let packSize = 0;
      let rowPackCost: number | undefined;
      if (!freeform) {
        const row = inventoryRows.find((r) => r.id === i.itemId);
        if (row) {
          const rowCost = Number(row.values.unitCost);
          if (prefillUnitCost === undefined && Number.isFinite(rowCost) && rowCost >= 0) {
            prefillUnitCost = rowCost;
          }
          // A non-freeform item "tracks expiration" when its inventory row
          // already has a non-empty expiration date. Permanent items (e.g.
          // stethoscopes) have no expiration and shouldn't prompt for one.
          tracksExpiration = String(row.values.expirationDate ?? "").trim() !== "";
          const rowPack = Number(row.values.packSize);
          if (Number.isFinite(rowPack) && rowPack > 0) packSize = rowPack;
          const pc = Number(row.values.packCost);
          if (Number.isFinite(pc) && pc >= 0) rowPackCost = pc;
        }
      }
      // When the item is pack-based, box mode is the default and qty + cost
      // are denominated per box. This is what the user actually receives from
      // the vendor; inventory is still stored in units (on submit we multiply
      // qtyThisReceive by packSize, and cost is divided back to per-unit).
      const receivingAsBoxes = packSize > 0;
      const qtyRemaining = i.qtyOrdered - i.qtyReceived;
      const defaultQty = receivingAsBoxes
        ? String(Math.max(1, Math.ceil(qtyRemaining / packSize)))
        : String(qtyRemaining);
      let prefillCostDisplay = "";
      if (receivingAsBoxes) {
        // Prefer the row's packCost; otherwise derive from unit cost × pack.
        const box = rowPackCost !== undefined
          ? rowPackCost
          : (prefillUnitCost !== undefined ? prefillUnitCost * packSize : undefined);
        if (box !== undefined) prefillCostDisplay = formatCurrency(box);
      } else if (prefillUnitCost !== undefined) {
        prefillCostDisplay = formatCurrency(prefillUnitCost);
      }
      return {
        itemId: i.itemId,
        itemName: i.itemName,
        isFreeform: freeform,
        qtyOrdered: i.qtyOrdered,
        qtyReceived: i.qtyReceived,
        qtyRemaining,
        qtyThisReceive: defaultQty,
        expirationDate: "",
        unitCost: prefillCostDisplay,
        addToInventory: freeform,  // default to save for freeform items
        tracksExpiration,
        showExpirationInput: false,
        packSize,
        receivingAsBoxes,
        error: "",
      };
    }),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When non-null, validation passed but some items will remain outstanding —
  // the user must choose to close the order or just receive these items.
  const [pendingShortLines, setPendingShortLines] = useState<ReceiveLine[] | null>(null);

  const updateLine = (itemId: string, patch: Partial<ReceiveLine>) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, ...patch } : l)));

  // On blur, reformat a freshly-typed unit cost as currency (e.g. "4239" →
  // "$4,239.00"). Leaves invalid input alone so the user can fix it.
  const handleUnitCostBlur = (itemId: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const parsed = parseCurrency(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) {
      updateLine(itemId, { unitCost: formatCurrency(parsed) });
    }
  };

  const submitReceive = async (validated: ReceiveLine[], closeOrder: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      // Drop qty=0 lines — they're "received nothing of this item," a no-op
      // on the backend. If the user entered 0 across the board, close the form
      // without calling the API (handled earlier in handleConfirmClick).
      // When receivingAsBoxes, qtyThisReceive is # of boxes and unitCost is
      // the per-box price; convert both back to per-unit terms before sending.
      const receiveLines: RestockReceiveLine[] = validated
        .filter((l) => Number(l.qtyThisReceive) > 0)
        .map((l) => {
          const rawQty = Number(l.qtyThisReceive);
          const unitQty = l.receivingAsBoxes && l.packSize > 0 ? rawQty * l.packSize : rawQty;
          const perUnitCost = l.unitCost.trim()
            ? (l.receivingAsBoxes && l.packSize > 0
                ? parseCurrency(l.unitCost) / l.packSize
                : parseCurrency(l.unitCost))
            : undefined;
          return {
            itemId: l.itemId,
            qtyThisReceive: unitQty,
            ...(l.expirationDate ? { expirationDate: l.expirationDate } : {}),
            ...(perUnitCost !== undefined ? { unitCost: perUnitCost } : {}),
            // Freeform items always materialize into inventory on receive —
            // there's no "receive without saving" mode (it'd be nonsensical).
            ...(l.isFreeform ? { addToInventory: true } : {}),
          };
        });
      // Aggressive diagnostic: log the form state at submit time and the
      // outgoing payload. If "[receive]" never shows up below this, the
      // browser is running stale frontend code (hard refresh) OR the submit
      // is short-circuiting somewhere we don't see. console.warn so it
      // bypasses any default "hide info" filter.
      console.warn("[receive form] submit", {
        orderId: order.id,
        validatedLines: validated.map((l) => ({
          itemId: l.itemId,
          itemName: l.itemName,
          isFreeform: l.isFreeform,
          qtyOrdered: l.qtyOrdered,
          qtyReceived: l.qtyReceived,
          qtyThisReceive: l.qtyThisReceive,
          receivingAsBoxes: l.receivingAsBoxes,
          packSize: l.packSize,
        })),
        outgoingLines: receiveLines,
        closeOrder,
      });
      if (receiveLines.length === 0) {
        // Nothing to send — backend requires at least one line.
        setError("Enter at least one received quantity above 0.");
        setPendingShortLines(null);
        return;
      }
      await receiveRestockOrder(order.id, { lines: receiveLines, closeOrder });
      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to receive order.");
      setPendingShortLines(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmClick = () => {
    let hasError = false;
    const validated = lines.map((l) => {
      const qty = Number(l.qtyThisReceive);
      // 0 is valid — means "received none of this item." Negatives are not.
      if (!Number.isFinite(qty) || qty < 0) {
        hasError = true;
        return { ...l, error: "Quantity can't be negative" };
      }
      // Expiration is only required when actually receiving (qty > 0) AND the
      // item tracks expiration. Permanent items + qty=0 lines skip the check.
      if (qty > 0 && !l.isFreeform && l.tracksExpiration && !l.expirationDate) {
        hasError = true;
        return { ...l, error: "Expiration date required" };
      }
      if (qty > 0 && l.isFreeform && hasExpirationColumn && !l.expirationDate) {
        hasError = true;
        return { ...l, error: "Expiration date required" };
      }
      const cost = l.unitCost.trim() ? parseCurrency(l.unitCost) : undefined;
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
        hasError = true;
        return { ...l, error: "Invalid cost" };
      }
      return { ...l, error: "" };
    });
    setLines(validated);
    if (hasError) return;

    // Everything entered as 0? Nothing to receive — bail with a clear error
    // rather than hitting the backend's "at least one line" guard.
    const hasAnyNonZero = validated.some((l) => Number(l.qtyThisReceive) > 0);
    if (!hasAnyNonZero) {
      setError("Enter at least one received quantity above 0.");
      return;
    }

    // If any line will leave outstanding qty after this receive, prompt the user.
    // qtyThisReceive is in boxes when receivingAsBoxes, units otherwise.
    // qtyRemaining is always units. Convert to a shared denominator (units)
    // before comparing — otherwise "1 box" reads as "1 unit" and a fully-
    // received pack-based order looks 99 short.
    const shortLines = validated.filter((l) => {
      const raw = Number(l.qtyThisReceive);
      const receivedUnits = l.receivingAsBoxes && l.packSize > 0 ? raw * l.packSize : raw;
      return receivedUnits < l.qtyRemaining;
    });
    if (shortLines.length > 0) {
      setPendingShortLines(shortLines);
      return;
    }

    // Everything fully received — backend will auto-close.
    submitReceive(validated, false);
  };

  return (
    <div className="order-form-card">
      <div className="order-form-header">
        <div>
          <h3 className="order-form-title">
            Receive Items
            {order.vendor && <span className="order-form-vendor"> — {order.vendor}</span>}
          </h3>
          <p className="order-form-subtitle">
            Ordered {formatDateTime(order.createdAt)} by {order.createdByName}
          </p>
        </div>
        <button type="button" className="button button-ghost button-sm" onClick={onCancel} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="order-receive-items">
        <div className="order-receive-header">
          <span>Item</span>
          <span>Ordered</span>
          <span>Qty Receiving</span>
          {hasExpirationColumn && <span>Expiration</span>}
          <span>Unit Cost</span>
        </div>
        {lines.map((line) => (
          <div key={line.itemId} className="order-receive-row">
            <div className="order-receive-item-name">
              <span>{line.itemName}</span>
              {line.isFreeform && (
                <span className="order-receive-new-badge">New item</span>
              )}
              {line.packSize > 0 && (
                <div className="order-receive-packinfo">
                  {line.packSize} per box
                  {Number(line.qtyThisReceive) > 0 && (
                    <span className="order-receive-packinfo-math">
                      {" "}· adds {Number(line.qtyThisReceive) * line.packSize} to stock
                    </span>
                  )}
                </div>
              )}
              {line.error && <span className="order-form-line-error">{line.error}</span>}
            </div>
            <div className="order-receive-cell" data-label="Ordered">
              <div className="order-receive-progress">
                <span>
                  {line.receivingAsBoxes && line.packSize > 0
                    ? `${Math.ceil(line.qtyOrdered / line.packSize)} box${Math.ceil(line.qtyOrdered / line.packSize) === 1 ? "" : "es"}`
                    : line.qtyOrdered}
                </span>
                {line.qtyReceived > 0 && (
                  <span className="order-receive-remaining"> ({line.qtyRemaining} remaining)</span>
                )}
              </div>
            </div>
            <div
              className="order-receive-cell"
              data-label={line.receivingAsBoxes ? "Boxes Receiving" : "Qty Receiving"}
            >
              <input
                className="field"
                type="number"
                min="0"
                max={line.receivingAsBoxes && line.packSize > 0
                  ? Math.ceil(line.qtyRemaining / line.packSize)
                  : line.qtyRemaining}
                value={line.qtyThisReceive}
                onChange={(e) => updateLine(line.itemId, { qtyThisReceive: e.target.value, error: "" })}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => { if (e.currentTarget.value === "") updateLine(line.itemId, { qtyThisReceive: "0" }); }}
              />
            </div>
            {hasExpirationColumn && (
              <div className="order-receive-cell" data-label="Expiration">
                {line.tracksExpiration || line.isFreeform || line.showExpirationInput ? (
                  <input
                    className={`field${line.error && !line.expirationDate ? " field--error" : ""}`}
                    type="date"
                    value={line.expirationDate}
                    onChange={(e) => updateLine(line.itemId, { expirationDate: e.target.value, error: "" })}
                  />
                ) : (
                  <button
                    type="button"
                    className="button button-secondary button-sm order-receive-add-expiration"
                    onClick={() => updateLine(line.itemId, { showExpirationInput: true })}
                  >
                    <Plus size={14} /> Add expiration
                  </button>
                )}
              </div>
            )}
            <div
              className="order-receive-cell"
              data-label={line.receivingAsBoxes ? "Cost per Box" : "Unit Cost"}
            >
              <input
                className="field"
                type="text"
                inputMode="decimal"
                placeholder="$0.00"
                value={line.unitCost}
                onChange={(e) => updateLine(line.itemId, { unitCost: e.target.value, error: "" })}
                onBlur={(e) => handleUnitCostBlur(line.itemId, e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      {error && <p className="order-form-error">{error}</p>}

      {pendingShortLines ? (
        <div className="order-receive-warning">
          <div className="order-receive-warning-header">
            <AlertTriangle size={16} />
            <strong>Some items haven't been fully received.</strong>
          </div>
          <ul className="order-receive-warning-list">
            {pendingShortLines.map((l) => {
              // Display the short qty in the unit the user typed in. For pack
              // items that means converting both qtyOrdered and the shortfall
              // to boxes; for unit items both stay in units.
              const inBoxMode = l.receivingAsBoxes && l.packSize > 0;
              const receivingTyped = Number(l.qtyThisReceive) || 0;
              const orderedDisplay = inBoxMode
                ? Math.ceil(l.qtyRemaining / l.packSize)
                : l.qtyRemaining;
              const shortDisplay = orderedDisplay - receivingTyped;
              const unitWord = inBoxMode
                ? `box${orderedDisplay === 1 ? "" : "es"}`
                : "";
              const suffix = unitWord ? ` ${unitWord}` : "";
              return (
                <li key={l.itemId}>
                  {l.itemName}: receiving {receivingTyped} of {orderedDisplay}{suffix} — {shortDisplay} short
                </li>
              );
            })}
          </ul>
          <p className="order-receive-warning-hint">
            Close the order to finalize as-is, or just receive these and leave the rest open.
          </p>
          <div className="order-form-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setPendingShortLines(null)}
              disabled={submitting}
            >
              Back
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => submitReceive(lines, false)}
              disabled={submitting}
            >
              {submitting ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />}
              Receive these, keep order open
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => submitReceive(lines, true)}
              disabled={submitting}
            >
              {submitting ? <Loader2 size={14} className="spin" /> : <X size={14} />}
              Close order with these quantities
            </button>
          </div>
        </div>
      ) : (
        <div className="order-form-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={handleConfirmClick}
            disabled={submitting}
          >
            {submitting ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />}
            Confirm Receipt
          </button>
        </div>
      )}
    </div>
  );
}

// ── Order Card ─────────────────────────────────────────────────────────────

function OrderCard({
  order,
  hasExpirationColumn,
  inventoryRows,
  onRefresh,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  inventoryRows: InventoryRow[];
  // closedOrder is passed when the order was just received or closed,
  // so the parent can clear orderedAt for its items and refresh inventory.
  onRefresh: (closedOrder?: RestockOrder) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [closing, setClosing] = useState(false);
  // When true, the card swaps its action row for an inline confirm + note
  // textarea so the user can record why the order was cancelled.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState("");

  const total = orderTotalCost(order.items);
  const totalReceived = order.items.reduce((s, i) => s + i.qtyReceived, 0);
  const totalOrdered = order.items.reduce((s, i) => s + i.qtyOrdered, 0);
  // An order was "cancelled" (vs. closed after at least one receive) when it
  // was closed without anything being received.
  const isCancelled = order.status === "closed" && order.receives.length === 0;

  const handleConfirmCancel = async () => {
    setClosing(true);
    try {
      await closeRestockOrder(order.id, cancelNote.trim() || undefined);
      onRefresh(order);
    } catch { /* ignore */ } finally {
      setClosing(false);
      setConfirmingCancel(false);
      setCancelNote("");
    }
  };

  if (showReceive) {
    return (
      <ReceiveOrderForm
        order={order}
        hasExpirationColumn={hasExpirationColumn}
        inventoryRows={inventoryRows}
        onReceived={() => {
          setShowReceive(false);
          // Pass NO `closedOrder` — receive already cleared orderedAt
          // server-side AND incremented qty. Calling onRefresh(order)
          // would route through handleOrderChanged's cancel-cleanup
          // branch, which posts the row back with stale local state and
          // overwrites the receive's qty bump. The cancel button below
          // still passes `order` because the cancel server-flow doesn't
          // touch inventory rows — frontend cleanup is needed there.
          onRefresh();
        }}
        onCancel={() => setShowReceive(false)}
      />
    );
  }

  return (
    <div className={`order-card order-card--${order.status}`}>
      <div className="order-card-main">
        <div className="order-card-top">
          <div className="order-card-identity">
            <StatusBadge status={order.status} cancelled={isCancelled} />
            <span className="order-card-vendor">{order.vendor || "No vendor"}</span>
            <span className="order-card-date">{formatDate(order.createdAt)}</span>
          </div>
          <div className="order-card-summary">
            <span className="order-card-items-count">{order.items.length} item{order.items.length !== 1 ? "s" : ""}</span>
            <span className="order-card-progress">{totalReceived}/{totalOrdered} received</span>
            {total !== null && <span className="order-card-cost">{formatCurrency(total)}</span>}
          </div>
          <div className="order-card-actions">
            {order.status !== "closed" && !confirmingCancel && (
              <>
                <button
                  type="button"
                  className="button button-primary button-sm"
                  onClick={() => setShowReceive(true)}
                >
                  <PackageCheck size={14} /> Receive
                </button>
                <button
                  type="button"
                  className="button button-danger button-sm"
                  onClick={() => setConfirmingCancel(true)}
                  disabled={closing}
                  title="Cancel order — items return to reorder list"
                >
                  <X size={14} /> Cancel
                </button>
              </>
            )}
            {/* No expand for fresh-open orders — there's nothing in the detail
                that isn't already in the header. Keep expand for partial (to
                show progress) and closed (full history). */}
            {order.status !== "open" && (
              <button
                type="button"
                className="button button-secondary button-sm order-card-expand"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Collapse" : "Expand"}
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>
        </div>

        {order.notes && <p className="order-card-notes">{order.notes}</p>}
        <p className="order-card-by">Ordered by {order.createdByName}</p>

        {confirmingCancel && (
          <div className="order-cancel-confirm">
            <div className="order-cancel-confirm-header">
              <AlertTriangle size={16} />
              <strong>Cancel this order?</strong>
            </div>
            <p className="order-cancel-confirm-hint">
              Items will return to the reorder list. Add a note below if you want to record why (optional).
            </p>
            <textarea
              className="field order-cancel-note"
              placeholder="e.g. Vendor cancelled, or 6-week lead time — reordering elsewhere"
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
              rows={2}
              disabled={closing}
              autoFocus
            />
            <div className="order-cancel-actions">
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => {
                  setConfirmingCancel(false);
                  setCancelNote("");
                }}
                disabled={closing}
              >
                Back
              </button>
              <button
                type="button"
                className="button button-danger button-sm"
                onClick={handleConfirmCancel}
                disabled={closing}
              >
                {closing ? <Loader2 size={14} className="spin" /> : <X size={14} />}
                Cancel order
              </button>
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div className="order-card-detail">
          <table className="order-detail-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Ordered</th>
                <th>Received</th>
                <th>Expiration</th>
                <th>Unit Cost</th>
                <th>Line Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => {
                // Aggregate unique expiration dates from all receive events for this item
                const expirations = Array.from(
                  new Set(
                    order.receives.flatMap((ev) =>
                      ev.lines
                        .filter((l) => l.itemId === item.itemId && l.expirationDate)
                        .map((l) => l.expirationDate as string),
                    ),
                  ),
                ).sort();
                // Pack size: check the live inventory row first (most current),
                // fall back to the pack size captured on freeform order items.
                const row = inventoryRows.find((r) => r.id === item.itemId);
                const rowPack = row ? Number(row.values.packSize) : NaN;
                const packSize = Number.isFinite(rowPack) && rowPack > 0
                  ? rowPack
                  : (item.packSize ?? 0);
                const isPack = packSize > 0;
                const formatQtyWithBoxes = (unitQty: number) => {
                  if (!isPack || unitQty === 0) return String(unitQty);
                  const boxes = unitQty / packSize;
                  const whole = Number.isInteger(boxes);
                  const label = whole
                    ? `${boxes} box${boxes === 1 ? "" : "es"}`
                    : `${(Math.round(boxes * 10) / 10)} boxes`;
                  return `${unitQty} (${label})`;
                };
                return (
                  <tr key={item.itemId} className={item.qtyReceived >= item.qtyOrdered ? "order-detail-row--done" : ""}>
                    <td>
                      {item.itemName}
                      {item.itemId.startsWith("freeform-") && (
                        <span className="order-freeform-badge">new</span>
                      )}
                    </td>
                    <td>{formatQtyWithBoxes(item.qtyOrdered)}</td>
                    <td>{formatQtyWithBoxes(item.qtyReceived)}</td>
                    <td>
                      {expirations.length === 0
                        ? "—"
                        : expirations
                            .map((d) =>
                              new Date(d).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              }),
                            )
                            .join(", ")}
                    </td>
                    <td>
                      {item.unitCost !== undefined ? (
                        isPack
                          ? `${formatCurrency(item.unitCost * packSize)}/box`
                          : formatCurrency(item.unitCost)
                      ) : "—"}
                    </td>
                    <td>{item.unitCost !== undefined ? formatCurrency(item.unitCost * item.qtyOrdered) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="order-history">
            <h4 className="order-history-title">Order History</h4>
            <ul className="order-history-list">
              <li className="order-history-row">
                <span className="order-history-time">{formatDateTime(order.createdAt)}</span>
                <span className="order-history-text">Ordered by {order.createdByName}</span>
              </li>
              {order.receives.map((ev, i) => (
                <li key={i} className="order-history-row">
                  <span className="order-history-time">{formatDateTime(ev.receivedAt)}</span>
                  <span className="order-history-text">
                    Received by {ev.receivedByName}
                    {ev.closedOrder && <span className="order-history-closed"> · closed order</span>}
                  </span>
                </li>
              ))}
              {/* Show an explicit close/cancel event only when the close
                  happened via the Cancel flow (not during a receive) — i.e.
                  no receive event already carries the closedOrder flag. */}
              {order.status === "closed"
                && order.closedAt
                && !order.receives.some((r) => r.closedOrder) && (
                <li className="order-history-row">
                  <span className="order-history-time">{formatDateTime(order.closedAt)}</span>
                  <span className="order-history-text">
                    {isCancelled ? "Cancelled" : "Closed"} by {order.closedByName ?? "—"}
                  </span>
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Orders Help ────────────────────────────────────────────────────────────

export function OrdersHelp() {
  return (
    <HelpModal title="How Orders work" triggerLabel="How Orders work">
      <p className="help-modal-flow">
        <strong>Reorder</strong>
        <ArrowRight size={14} aria-hidden="true" />
        <strong>Pending Receipt</strong>
        <ArrowRight size={14} aria-hidden="true" />
        <strong>Closed Orders</strong>
      </p>

      <h4>Reorder</h4>
      <p>
        Items below their min quantity, grouped by vendor. Each
        vendor is a tab with an item count and estimated total.
      </p>
      <ul>
        <li>
          <strong>Check items + Mark as Ordered</strong> — creates a
          pending order for that vendor. Those items leave the
          reorder list until received or cancelled.
        </li>
        <li>
          <strong>Missing Info tab</strong> — items without a vendor.
          Bulk-assign one with the checkboxes, or set per-row.
        </li>
      </ul>

      <h4>+ New order</h4>
      <p>
        Top-right button for anything that doesn't fit a vendor card:
        in-person buys, brand-new items, mixed vendors, etc.
      </p>
      <ul>
        <li>
          Type in the <strong>vendor</strong> field to add a new one
          on the spot. Build the order by searching inventory or
          quick-adding freeform lines.
        </li>
        <li>
          <strong>Already received</strong> closes the order
          immediately and adds the items to inventory — for things
          you already have in hand.
        </li>
      </ul>

      <h4>Pending Receipt</h4>
      <ul>
        <li>
          <strong>Receive</strong> — log what arrived. Adjust qty for
          short shipments, add expiration, update price. Inventory
          goes up automatically. The order closes when fully received.
        </li>
        <li>
          <strong>Partial</strong> — enter what came, choose to close
          or leave open. Open partial orders show a
          <strong> Partially Received</strong> badge.
        </li>
        <li>
          <strong>Cancel</strong> — close without receiving. Items
          return to the reorder list. Add a note if you want.
        </li>
      </ul>

      <h4>Closed Orders</h4>
      <p>
        History. Search by vendor / item / note; filter by date.
        <strong> COMPLETED</strong> = received normally;
        <strong> CANCELLED</strong> = closed before anything arrived.
      </p>

      <h4>Tips</h4>
      <ul>
        <li>
          The min-quantity threshold is set per item in the Inventory
          tab.
        </li>
        <li>
          Expired stock doesn't count toward on-hand — an item can
          appear for reorder even if expired units are on the shelf.
        </li>
        <li>
          Items with a vendor assigned group under that vendor's
          card. Items without one land in Missing Info.
        </li>
      </ul>
    </HelpModal>
  );
}

// ── OrderItemAutocomplete ──────────────────────────────────────────────────

/** Inventory autocomplete used by the compose panel. Same dropdown pattern
 *  as Log Usage's ItemAutocomplete (keyboard nav, outside-click close,
 *  highlight scroll), but adapted for "pick to add to cart" semantics:
 *  picking an item clears the input and fires the callback rather than
 *  setting a selected state. The bottom of the dropdown always offers a
 *  "+ Add as new item" sentinel for freeform entry. */
function OrderItemAutocomplete({
  inputId,
  inventoryRows,
  excludeNames,
  onPickExisting,
  onPickFreeform,
  value,
  isFreeform,
  onClear,
  disabled,
  placeholder,
}: {
  inputId?: string;
  inventoryRows: InventoryRow[];
  /** Lowercased item names already in the cart. Used to filter ALL lots of
   *  the same item out of the dropdown — adding "1ml syringe" once should
   *  hide every other lot of that name from the search. */
  excludeNames: Set<string>;
  onPickExisting: (itemId: string, itemName: string) => void;
  onPickFreeform: (name: string) => void;
  /** Selected item name. When set, the autocomplete renders as a readonly
   *  chip with a × clear button instead of an editable search input. Used
   *  by per-line pickers in the New Order tab where each line locks in
   *  its item once chosen. */
  value?: string;
  /** True when `value` was added via the freeform sentinel — surfaces a
   *  small "NEW" badge so the user can tell it's a brand-new item. */
  isFreeform?: boolean;
  /** Required when `value` is set — restores the picker to search mode. */
  onClear?: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  type AutoOption =
    | { kind: "existing"; key: string; id: string; name: string }
    | { kind: "freeform"; key: string; text: string };

  const options = useMemo<AutoOption[]>(() => {
    const q = search.trim().toLowerCase();
    // Collect first, then sort, then cap. Avoids slicing the inventory
    // alphabetically and dropping items the user expects to find further
    // down the list.
    const matches: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    for (const row of inventoryRows) {
      if (row.values.retiredAt) continue;
      const name = String(row.values.itemName ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (excludeNames.has(key)) continue;
      if (q && !key.includes(q)) continue;
      seen.add(key);
      matches.push({ id: row.id, name });
    }
    matches.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    // No cap — users want to scroll the full inventory. The list itself is
    // virtualization-free but capped only by max-height + overflow scroll.
    const out: AutoOption[] = matches.map((m) => ({
      kind: "existing",
      key: `existing:${m.id}`,
      id: m.id,
      name: m.name,
    }));
    if (q) {
      // Only offer freeform when the typed text doesn't exact-match an
      // existing item — otherwise it's confusing (the user already sees that
      // item at the top of the list).
      const exact = out.some((o) => o.kind === "existing" && o.name.toLowerCase() === q);
      if (!exact) {
        out.push({ kind: "freeform", key: `freeform:${q}`, text: search.trim() });
      }
    }
    return out;
  }, [inventoryRows, excludeNames, search]);

  useEffect(() => { setHighlightIndex(-1); }, [options.length, open]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const selectOption = (opt: AutoOption) => {
    if (opt.kind === "existing") onPickExisting(opt.id, opt.name);
    else onPickFreeform(opt.text);
    setSearch("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") { setOpen(true); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = highlightIndex >= 0 ? options[highlightIndex] : options[0];
      if (target) selectOption(target);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showDropdown = open && options.length > 0;

  // Selected mode: render the locked-in name with a × clear button. The
  // dropdown is suppressed; the user has to clear before picking a new
  // item. Freeform-added items get a small NEW badge.
  if (value) {
    return (
      <div className="usage-autocomplete">
        <div className="usage-autocomplete-input-wrap">
          <input
            id={inputId}
            type="text"
            className="usage-autocomplete-input"
            value={value}
            readOnly
            disabled={disabled}
            aria-label="Selected item"
          />
          {isFreeform ? (
            <span className="usage-autocomplete-new-badge">NEW</span>
          ) : null}
          {onClear ? (
            <button
              type="button"
              className="usage-autocomplete-clear"
              onClick={onClear}
              disabled={disabled}
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="usage-autocomplete" ref={wrapRef}>
      <div className="usage-autocomplete-input-wrap">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className="usage-autocomplete-input"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? "Search inventory or type a new item name"}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          autoComplete="off"
        />
        {search && (
          <button
            type="button"
            className="usage-autocomplete-clear"
            onClick={() => { setSearch(""); inputRef.current?.focus(); }}
            disabled={disabled}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {showDropdown && (
        <ul className="usage-autocomplete-list" ref={listRef} role="listbox">
          {options.map((opt, i) => (
            <li
              key={opt.key}
              className={`usage-autocomplete-option${i === highlightIndex ? " usage-autocomplete-option--hl" : ""}${opt.kind === "freeform" ? " usage-autocomplete-option--freeform" : ""}`}
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectOption(opt)}
            >
              {opt.kind === "existing" ? (
                <span className="usage-autocomplete-option-name">{opt.name}</span>
              ) : (
                <span className="usage-autocomplete-option-name">+ Add "{opt.text}" as new item</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Compose Order Panel ────────────────────────────────────────────────────

/** Submit-time payload per line. Cost / pack / expiration are NOT collected
 *  here — they belong to the receive event. The order itself only captures
 *  what the user is asking for: vendor + item + qty + (optional URL). For
 *  freeform items, minQuantity sets the reorder threshold on the new
 *  inventory row when received. */
type ComposeOrderSubmitLine = {
  itemId?: string;
  itemName: string;
  qtyOrdered: number;
  minQuantity?: number;
  reorderLink?: string;
};

type ComposeLine = {
  /** Empty for a freeform line — set when picked from inventory. Drives
   *  whether qty bumps an existing item on receive or creates a new
   *  inventory row. */
  itemId?: string;
  itemName: string;
  /** String-typed so the user can clear the input. Parsed on submit. */
  qty: string;
  /** Reorder threshold for freeform items. Persisted to the new inventory
   *  row on receive so the item shows up in Reorder when low. Existing
   *  items already have a minQuantity on their inventory row, so this is
   *  only collected for freeform lines (no itemId). */
  minQuantity: string;
  /** Product URL (where to reorder). Persisted on the order item and on
   *  the inventory row when received with addToInventory. */
  productUrl: string;
  /** True when the user expanded the line to expose URL / min-qty fields.
   *  Freeform lines start expanded so the user sees the optional fields. */
  expanded: boolean;
};

function ComposeOrderPanel({
  inventoryRows,
  availableVendors,
  onAddVendor,
  onSubmit,
}: {
  inventoryRows: InventoryRow[];
  availableVendors: string[];
  onAddVendor?: (name: string) => Promise<void>;
  onSubmit: (input: {
    vendor: string;
    notes: string;
    lines: ComposeOrderSubmitLine[];
    markReceived: boolean;
  }) => Promise<void>;
}) {
  const blankLineExtras = {
    minQuantity: "",
    productUrl: "",
  };
  const makeEmptyLine = (): ComposeLine => ({
    itemName: "",
    qty: "0",
    expanded: false,
    ...blankLineExtras,
  });

  const [vendor, setVendor] = useState("");
  const [notes, setNotes] = useState("");
  const [markReceived, setMarkReceived] = useState(false);
  // Always start with one empty line so the picker is visible — matches
  // Log Usage's pattern (one empty entry waiting for input).
  const [lines, setLines] = useState<ComposeLine[]>(() => [makeEmptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lowercased item names already locked in across other lines — passed to
  // each line's autocomplete so the dropdown hides items already picked.
  const alreadyInCartNames = useMemo(
    () => new Set(lines.map((l) => l.itemName.trim().toLowerCase()).filter((n) => n.length > 0)),
    [lines],
  );

  const updateLine = (idx: number, patch: Partial<ComposeLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  // Pick an existing inventory item for the given line. Locks in the
  // itemId + itemName; the line stays in "filled" mode until the user
  // clicks × to clear it (which restores the autocomplete).
  const pickExistingForLine = (idx: number, itemId: string, name: string) => {
    if (lines.some((l, i) => i !== idx && l.itemId === itemId)) return;
    updateLine(idx, { itemId, itemName: name });
  };

  // Pick a freeform (brand-new) item for the given line. No itemId; we
  // expand the line by default since freeform items usually need pack /
  // expiration / URL / min qty filled in at creation time.
  const pickFreeformForLine = (idx: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateLine(idx, { itemId: undefined, itemName: trimmed, expanded: true });
  };

  // Restore a line to search mode (the autocomplete picker reappears).
  const clearLineItem = (idx: number) => {
    updateLine(idx, { itemId: undefined, itemName: "", expanded: false });
  };

  const addEmptyLine = () => {
    setLines((prev) => [...prev, makeEmptyLine()]);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => {
      // Always keep at least one line so the picker is always visible.
      if (prev.length <= 1) return [makeEmptyLine()];
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSubmit = async () => {
    setError(null);
    // Skip blank lines — they're just placeholder pickers waiting for input.
    const filledLines = lines.filter((l) => l.itemName.trim().length > 0);
    if (filledLines.length === 0) {
      setError("Add at least one item.");
      return;
    }
    const payloadLines: ComposeOrderSubmitLine[] = [];
    for (let i = 0; i < filledLines.length; i++) {
      const l = filledLines[i];
      const name = l.itemName.trim();
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`${name}: quantity must be greater than 0.`);
        return;
      }
      let minQuantity: number | undefined;
      if (l.minQuantity.trim()) {
        const parsed = Number(l.minQuantity);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(`${name}: min quantity must be non-negative.`);
          return;
        }
        minQuantity = Math.floor(parsed);
      }
      const productUrl = l.productUrl.trim();
      const reorderLink = productUrl
        ? (/^https?:\/\//i.test(productUrl) ? productUrl : `https://${productUrl}`)
        : undefined;
      payloadLines.push({
        ...(l.itemId ? { itemId: l.itemId } : {}),
        itemName: name,
        qtyOrdered: qty,
        ...(minQuantity !== undefined ? { minQuantity } : {}),
        ...(reorderLink ? { reorderLink } : {}),
      });
    }
    setSubmitting(true);
    try {
      await onSubmit({ vendor: vendor.trim(), notes: notes.trim(), lines: payloadLines, markReceived });
      // Reset the form so the user can start a new order on the same tab.
      setVendor("");
      setNotes("");
      setLines([makeEmptyLine()]);
      setMarkReceived(false);
    } catch (err: any) {
      setError(err?.message ?? "Failed to record order.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="compose-order app-card" aria-label="New order">
      <div className="compose-order-intro">
        <h3 className="compose-order-title">New Order</h3>
        <p className="compose-order-hint">
          Pick a vendor (or add a new one), then build the order by
          searching inventory or quick-adding freeform lines.
        </p>
      </div>
        <div className="manual-order-fields">
          <div className="manual-order-field">
            <label className="field-label" htmlFor="manual-order-vendor">Vendor</label>
            <VendorSelect
              inputId="manual-order-vendor"
              value={vendor}
              availableVendors={availableVendors}
              onChange={setVendor}
              onAddVendor={onAddVendor}
              disabled={submitting}
              ariaLabel="Vendor"
              placeholder="Choose or type to add new"
            />
          </div>
          <div className="manual-order-field">
            <label className="field-label" htmlFor="manual-order-notes">Notes (optional)</label>
            <input
              id="manual-order-notes"
              className="field"
              type="text"
              placeholder="e.g. Costco run — Apr 27"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <div className="usage-entries compose-order-lines">
          {lines.map((l, idx) => {
            const filled = l.itemName.trim().length > 0;
            return (
              <div className="usage-entry compose-order-line" key={idx}>
                <div className="usage-entry-main compose-order-line-main">
                  <div className="usage-entry-item">
                    <label className="field-label" htmlFor={`manual-order-item-${idx}`}>Item</label>
                    <OrderItemAutocomplete
                      inputId={`manual-order-item-${idx}`}
                      inventoryRows={inventoryRows}
                      excludeNames={alreadyInCartNames}
                      value={filled ? l.itemName : undefined}
                      isFreeform={filled && !l.itemId}
                      onPickExisting={(id, name) => pickExistingForLine(idx, id, name)}
                      onPickFreeform={(name) => pickFreeformForLine(idx, name)}
                      onClear={() => clearLineItem(idx)}
                      disabled={submitting}
                      placeholder="Search items or type a new name"
                    />
                  </div>
                  <div className="usage-entry-qty compose-order-line-qty">
                    <label className="field-label" htmlFor={`manual-order-qty-${idx}`}>Qty</label>
                    <input
                      id={`manual-order-qty-${idx}`}
                      className="field compose-order-line-qty-input"
                      type="number"
                      min="1"
                      value={l.qty}
                      onChange={(e) => updateLine(idx, { qty: e.target.value })}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      onBlur={(e) => { if (e.currentTarget.value === "") updateLine(idx, { qty: "0" }); }}
                      disabled={submitting || !filled}
                    />
                  </div>
                  {(filled || lines.length > 1) && (
                    <button
                      type="button"
                      className="usage-remove-line-btn"
                      onClick={() => removeLine(idx)}
                      disabled={submitting}
                      aria-label="Remove line"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {filled ? (
                  <button
                    type="button"
                    className="manual-order-more-toggle"
                    onClick={() => updateLine(idx, { expanded: !l.expanded })}
                    disabled={submitting}
                    aria-expanded={l.expanded}
                  >
                    {l.expanded ? (
                      <>Hide details <ChevronUp size={14} /></>
                    ) : (
                      <>More details <ChevronDown size={14} /></>
                    )}
                  </button>
                ) : null}

                {filled && l.expanded ? (
                  <div className="manual-order-line-details">
                    {!l.itemId ? (
                      <div className="manual-order-detail-field">
                        <label className="field-label" htmlFor={`manual-order-min-${idx}`}>Min quantity</label>
                        <input
                          id={`manual-order-min-${idx}`}
                          className="field"
                          type="number"
                          min="0"
                          placeholder="Reorder threshold"
                          value={l.minQuantity}
                          onChange={(e) => updateLine(idx, { minQuantity: e.target.value })}
                          onFocus={(e) => e.currentTarget.select()}
                          disabled={submitting}
                        />
                      </div>
                    ) : null}
                    <div className="manual-order-detail-field manual-order-detail-field--wide">
                      <label className="field-label" htmlFor={`manual-order-url-${idx}`}>Product URL</label>
                      <input
                        id={`manual-order-url-${idx}`}
                        className="field"
                        type="text"
                        placeholder="https://..."
                        value={l.productUrl}
                        onChange={(e) => updateLine(idx, { productUrl: e.target.value })}
                        disabled={submitting}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="usage-add-line-btn"
          onClick={addEmptyLine}
          disabled={submitting}
        >
          <Plus size={14} /> Add Item
        </button>

        <label className="manual-order-checkbox">
          <input
            type="checkbox"
            checked={markReceived}
            onChange={(e) => setMarkReceived(e.target.checked)}
            disabled={submitting}
          />
          <span>Already received (close immediately and add to inventory)</span>
        </label>

        {error ? <p className="field-error" role="alert">{error}</p> : null}

        <div className="compose-order-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={handleSubmit}
            disabled={submitting || lines.every((l) => l.itemName.trim().length === 0)}
          >
            {submitting ? "Saving…" : markReceived ? "Record + receive" : "Record order"}
          </button>
        </div>
    </section>
  );
}

// ── Main Orders Page ───────────────────────────────────────────────────────

export function OrdersPage({ selectedLocationId, onSelectedLocationIdChange }: OrdersPageProps) {
  const [orders, setOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [hasExpirationColumn, setHasExpirationColumn] = useState(false);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [registeredVendors, setRegisteredVendors] = useState<string[]>([]);
  const inventoryRowsRef = useRef<InventoryRow[]>([]);

  // Sorted location list. Replaces the previous merged-from-row-values
  // derivation — locations are first-class entities post-restructure.
  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
    ),
    [locations],
  );
  // Some downstream UI (the picker for free-form items) still wants names only.
  const locationValues = useMemo(
    () => sortedLocations.map((l) => l.name),
    [sortedLocations],
  );

  // Known vendors = registered ones (even if unused) + any vendor that shows up
  // on existing rows. Used by the "Add Item Not Listed" form and ReorderTab
  // grouping so users can pick from a dropdown.
  const vendorValues = useMemo(() => {
    const fromRows = inventoryRows
      .map((row) => String(row.values.vendor ?? "").trim())
      .filter((v) => v.length > 0);
    return Array.from(new Set([...registeredVendors, ...fromRows])).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [inventoryRows, registeredVendors]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRestockOrders();
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBootstrap = useCallback(() => {
    loadInventoryBootstrap().then(({ columns, items, locations: locs, registeredVendors: vendors }) => {
      setInventoryRows(items);
      inventoryRowsRef.current = items;
      setHasExpirationColumn(columns.some((c) => c.key === "expirationDate" && c.isVisible));
      setLocations(Array.isArray(locs) ? locs : []);
      setRegisteredVendors(Array.isArray(vendors) ? vendors : []);
    }).catch(() => {}).finally(() => {
      setInventoryLoaded(true);
    });
  }, []);

  // Quick-add a vendor from inside the Reorder UI (Missing Info dropdown /
  // bulk toolbar). Refreshes registeredVendors so the new entry appears in
  // every dropdown without a full bootstrap reload.
  const handleAddVendor = useCallback(async (name: string) => {
    const next = await addInventoryVendor(name);
    setRegisteredVendors(next);
  }, []);

  useEffect(() => {
    loadBootstrap();
    loadOrders();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMarkOrdered = useCallback(async (rowIds: string[], vendor: string, orderItems: OrderItem[]) => {
    const idSet = new Set(rowIds);
    const now = new Date().toISOString();
    const current = inventoryRowsRef.current;
    const toSave = current
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...r, position: current.indexOf(r), values: { ...r.values, orderedAt: now, reorderCheckedAt: null } }));
    const updated = current.map((r) =>
      idSet.has(r.id) ? { ...r, values: { ...r.values, orderedAt: now, reorderCheckedAt: null } } : r,
    );
    setInventoryRows(updated);
    inventoryRowsRef.current = updated;
    // Surface save errors instead of silently swallowing — the previous
    // .catch(()=>{}) was masking failures that left orderedAt unpersisted,
    // causing items to "reappear" on the reorder list and confusing receive
    // accounting.
    if (toSave.length > 0) {
      try {
        await saveInventoryItems(toSave, []);
      } catch (err) {
        console.error("Failed to stamp orderedAt on rows", err);
        setError(
          err instanceof Error
            ? `Could not mark items as ordered: ${err.message}`
            : "Could not mark items as ordered.",
        );
        return; // Don't create the order if we couldn't persist the marker
      }
    }

    if (orderItems.length > 0) {
      try {
        await createRestockOrder({
          vendor: vendor || undefined,
          items: orderItems.map((item) => ({
            ...(item.rowId ? { itemId: item.rowId } : {}),
            itemName: item.name,
            qtyOrdered: item.qty,
            ...(item.unitCost !== undefined ? { unitCost: item.unitCost } : {}),
            ...(item.minQuantity !== undefined ? { minQuantity: item.minQuantity } : {}),
            ...(item.packSize !== undefined ? { packSize: item.packSize } : {}),
            ...(item.packCost !== undefined ? { packCost: item.packCost } : {}),
            ...(item.reorderLink ? { reorderLink: item.reorderLink } : {}),
            ...(item.location ? { location: item.location } : {}),
          })),
        });
      } catch (err) {
        console.error("Failed to create restock order", err);
        setError(
          err instanceof Error
            ? `Could not create the order: ${err.message}`
            : "Could not create the order.",
        );
        return;
      }
      loadOrders();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Patch one or more inventory rows' values from the Reorder tab. Used by:
  //  - the link-prompt dialog (sets `reorderLink`)
  //  - the Missing Information section (sets `reorderLink` and/or
  //    `unitCost` / `packCost` when filling in incomplete items)
  // Same row gets all matching ids in `rowIds` (e.g. multiple lots of one
  // item share a link), so the patch is applied to every match.
  const handleSaveItemFields = useCallback(async (
    rowIds: string[],
    patch: Record<string, string | number | boolean | null>,
  ) => {
    const idSet = new Set(rowIds);
    const current = inventoryRowsRef.current;
    const toSave = current
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...r, position: current.indexOf(r), values: { ...r.values, ...patch } }));
    const updated = current.map((r) =>
      idSet.has(r.id) ? { ...r, values: { ...r.values, ...patch } } : r,
    );
    setInventoryRows(updated);
    inventoryRowsRef.current = updated;
    if (toSave.length > 0) await saveInventoryItems(toSave, []).catch(() => {});
  }, []);

  // Called after an OrderCard receives or closes an order. Clears orderedAt for the
  // order's items so they reappear in Needs Reorder if still low, then reloads
  // orders + inventory so the page reflects new quantities.
  const handleOrderChanged = useCallback(async (closedOrder?: RestockOrder) => {
    if (closedOrder) {
      // Cancel-before-receive: freeform items (itemId starts with "freeform-")
      // have no inventory row yet — they'd vanish when the order is cancelled.
      // Materialize them as rows with quantity=0 and minQuantity=qtyOrdered so
      // they surface in Needs Reorder and the user can retry with another vendor.
      // We only do this when nothing has been received yet — partial receives
      // with addToInventory already converted those items to real inventory rows.
      const noReceives = closedOrder.items.every((oi) => oi.qtyReceived === 0);
      if (noReceives) {
        const orphanedFreeform = closedOrder.items.filter((oi) =>
          oi.itemId.startsWith("freeform-"),
        );
        if (orphanedFreeform.length > 0) {
          const current = inventoryRowsRef.current;
          const now = new Date().toISOString();
          const newRows: InventoryRow[] = orphanedFreeform.map((oi, idx) => ({
            id: crypto.randomUUID(),
            position: current.length + idx,
            // Seed structural location from the order item (captured at Add-
            // Item time as locationId post-restructure, or as a name on
            // legacy orders). Falls back to the App-level selectedLocationId,
            // then to the first available location.
            locationId:
              oi.locationId
              ?? (oi.location ? sortedLocations.find((l) => l.name === oi.location)?.id : undefined)
              ?? selectedLocationId
              ?? sortedLocations[0]?.id,
            values: {
              itemName: oi.itemName,
              quantity: 0,
              // Use the user-supplied min quantity if they set one when
              // adding the freeform item; otherwise default to 0 so the
              // cancelled item doesn't auto-pop into Reorder. The user can
              // set a min later if they want to track this item.
              minQuantity: oi.minQuantity ?? 0,
              ...(oi.reorderLink ? { reorderLink: oi.reorderLink } : {}),
              ...(oi.unitCost !== undefined ? { unitCost: oi.unitCost } : {}),
              ...(oi.packSize !== undefined ? { packSize: oi.packSize } : {}),
              ...(oi.packCost !== undefined ? { packCost: oi.packCost } : {}),
            },
            createdAt: now,
          }));
          const updated = [...current, ...newRows];
          setInventoryRows(updated);
          inventoryRowsRef.current = updated;
          try {
            await saveInventoryItems(newRows, []);
          } catch (err) {
            // Surface the error — silently swallowing was hiding save failures
            // which caused materialized rows to vanish on the next bootstrap.
            console.error("Failed to materialize freeform items from cancelled order", err);
            setError(
              err instanceof Error
                ? `Could not save items back to inventory: ${err.message}`
                : "Could not save items back to inventory.",
            );
          }
        }
      }

      // Clear orderedAt for existing inventory items so they rejoin Needs Reorder
      // if still low.
      const itemIds = new Set(closedOrder.items.map((oi) => oi.itemId));
      const current = inventoryRowsRef.current;
      const toSave = current
        .filter((r) => itemIds.has(r.id) && r.values.orderedAt)
        .map((r) => ({
          ...r,
          position: current.indexOf(r),
          values: { ...r.values, orderedAt: null },
        }));
      if (toSave.length > 0) {
        const updated = current.map((r) =>
          itemIds.has(r.id) ? { ...r, values: { ...r.values, orderedAt: null } } : r,
        );
        setInventoryRows(updated);
        inventoryRowsRef.current = updated;
        await saveInventoryItems(toSave, []).catch(() => {});
      }
    }
    await loadOrders();
    loadBootstrap();
  }, [loadOrders, loadBootstrap]);

  const openOrders = orders.filter((o) => o.status !== "closed");
  const closedOrders = orders.filter((o) => o.status === "closed");

  // Top-level tab. Mirrors Inventory's chip pattern: only one section is shown
  // at a time so each gets the full vertical space. Default lands on Reorder
  // since that's the most-used workflow entry point.
  type OrdersTab = "reorder" | "new" | "pending" | "closed";
  const [activeTab, setActiveTab] = useState<OrdersTab>("reorder");
  // The compose panel lives on its own "New Order" tab. It's a clean slate
  // every time — low-stock items aren't pre-filled. The Reorder tab's
  // per-vendor checklist (Mark as Ordered) is the path for routine reorders;
  // New Order covers in-person buys, freeform items, and mixed-vendor orders.

  // Submit handler for the compose panel. Creates a restock order, then
  // optionally receives + closes it in one shot when the user picked "Already
  // received" (e.g. an in-person purchase that's already in hand). The receive
  // step needs the backend-assigned freeform-${uuid} ids, so we re-list orders
  // after create to discover them before posting the receive.
  const handleSubmitComposeOrder = useCallback(async (input: {
    vendor: string;
    notes: string;
    lines: ComposeOrderSubmitLine[];
    markReceived: boolean;
  }) => {
    const itemsPayload = input.lines.map((l) => ({
      ...(l.itemId ? { itemId: l.itemId } : {}),
      itemName: l.itemName,
      qtyOrdered: l.qtyOrdered,
      ...(l.minQuantity !== undefined ? { minQuantity: l.minQuantity } : {}),
      ...(l.reorderLink ? { reorderLink: l.reorderLink } : {}),
    }));
    const { orderId } = await createRestockOrder({
      vendor: input.vendor || undefined,
      notes: input.notes || undefined,
      items: itemsPayload,
    });

    // Stamp orderedAt on every inventory row referenced by this order so
    // those items leave the Reorder vendor cards (otherwise the user sees
    // them in BOTH Reorder and Pending Receipt). On close/cancel/receive,
    // handleOrderChanged clears orderedAt so the rows can re-enter the pool
    // if still low. Skip the stamp when the order is being received in the
    // same call — qty bumps via the receive flow handle that case.
    if (!input.markReceived) {
      const orderedRowIds = new Set(input.lines.map((l) => l.itemId).filter((id): id is string => !!id));
      if (orderedRowIds.size > 0) {
        const now = new Date().toISOString();
        const current = inventoryRowsRef.current;
        const toSave = current
          .filter((r) => orderedRowIds.has(r.id))
          .map((r) => ({ ...r, position: current.indexOf(r), values: { ...r.values, orderedAt: now } }));
        const updated = current.map((r) =>
          orderedRowIds.has(r.id) ? { ...r, values: { ...r.values, orderedAt: now } } : r,
        );
        setInventoryRows(updated);
        inventoryRowsRef.current = updated;
        if (toSave.length > 0) await saveInventoryItems(toSave, []).catch(() => {});
      }
    }
    if (input.markReceived) {
      const refreshed = await listRestockOrders();
      const created = refreshed.find((o) => o.id === orderId);
      if (created) {
        // Cost + expiration aren't collected on New Order — they belong to
        // the receive event. With "Already received" we close immediately,
        // so any cost the order item carries (e.g. via existing inventory
        // unit cost) is forwarded; otherwise the user can edit the closed
        // order later if they want to log price.
        const receiveLines: RestockReceiveLine[] = created.items.map((oi) => ({
          itemId: oi.itemId,
          qtyThisReceive: oi.qtyOrdered,
          ...(oi.unitCost !== undefined ? { unitCost: oi.unitCost } : {}),
          addToInventory: true,
        }));
        await receiveRestockOrder(orderId, { lines: receiveLines, closeOrder: true });
      }
      setOrders(refreshed);
    } else {
      await loadOrders();
    }
    loadBootstrap();
  }, [loadOrders, loadBootstrap]);
  // Count of items in the reorder list, surfaced from inside ReorderTab via
  // its onCountChange callback. Powers the tab-bar badge on Reorder so it's
  // visually consistent with Pending Receipt / Closed Orders counts.
  const [reorderCount, setReorderCount] = useState(0);

  // Closed-orders filter state: free-text search (vendor / notes / item names)
  // plus optional date range on createdAt.
  const [closedSearch, setClosedSearch] = useState("");
  const [closedFromDate, setClosedFromDate] = useState("");
  const [closedToDate, setClosedToDate] = useState("");
  // Whether the "Date range" popover is currently open.
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const dateFilterRef = useRef<HTMLDivElement | null>(null);

  // Click outside / Escape closes the date popover.
  useEffect(() => {
    if (!dateFilterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!dateFilterRef.current) return;
      if (!dateFilterRef.current.contains(e.target as Node)) setDateFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDateFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [dateFilterOpen]);

  const filteredClosedOrders = useMemo(() => {
    const q = closedSearch.trim().toLowerCase();
    const fromMs = closedFromDate ? new Date(closedFromDate).getTime() : null;
    // Inclusive "to" — bump to end of day so 2026-04-16 includes that whole day.
    const toMs = closedToDate
      ? new Date(closedToDate).getTime() + 24 * 60 * 60 * 1000 - 1
      : null;
    return closedOrders.filter((o) => {
      const created = new Date(o.createdAt).getTime();
      if (fromMs !== null && created < fromMs) return false;
      if (toMs !== null && created > toMs) return false;
      if (!q) return true;
      if ((o.vendor ?? "").toLowerCase().includes(q)) return true;
      if ((o.notes ?? "").toLowerCase().includes(q)) return true;
      return o.items.some((i) => i.itemName.toLowerCase().includes(q));
    });
  }, [closedOrders, closedSearch, closedFromDate, closedToDate]);

  const closedFilterActive = Boolean(
    closedSearch.trim() || closedFromDate || closedToDate,
  );

  // Group closed orders by calendar day for the disclosure UI. Use closedAt
  // when present (status="closed" implies it's set on the backend) and fall
  // back to createdAt as a defensive default. Already sorted by the API
  // (newest first), so groups stay newest-first too.
  const closedOrdersByDay = useMemo(() => {
    type Bucket = { label: string; orders: RestockOrder[] };
    const days: Bucket[] = [];
    for (const order of filteredClosedOrders) {
      const ts = order.closedAt ?? order.createdAt;
      const label = dayGroupLabel(ts);
      let day = days[days.length - 1];
      if (!day || day.label !== label) {
        day = { label, orders: [] };
        days.push(day);
      }
      day.orders.push(order);
    }
    return days;
  }, [filteredClosedOrders]);

  // Compact label for the "Date range" pill button. Only shows when at least
  // one bound is set; format mirrors the audit feed's terse date style.
  const dateRangeLabel = useMemo(() => {
    if (!closedFromDate && !closedToDate) return null;
    const fmt = (iso: string) =>
      new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    if (closedFromDate && closedToDate) return `${fmt(closedFromDate)} → ${fmt(closedToDate)}`;
    if (closedFromDate) return `From ${fmt(closedFromDate)}`;
    return `Until ${fmt(closedToDate)}`;
  }, [closedFromDate, closedToDate]);

  return (
    <section className="app-page orders-page">
      <div className="orders-content">
        {error && <p className="orders-error">{error}</p>}

        {loading && <LoadingState />}

        {!loading && (
          <>
            {/* Section tabs only. Location scope moved into ReorderTab's
             *  own header (where the Estimated total used to live) — orders
             *  are org-wide entities so the scope picker doesn't apply to
             *  Pending Receipt or Closed Orders. New Order picks location
             *  per-item via its own form fields. */}
            <div className="audit-tabs orders-tabs" role="tablist" aria-label="Orders sections">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "reorder"}
                className={`audit-tab${activeTab === "reorder" ? " active" : ""}`}
                onClick={() => setActiveTab("reorder")}
              >
                <ShoppingCart size={16} /> Reorder
                {reorderCount > 0 ? (
                  <span className="audit-tab-badge">{reorderCount}</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "new"}
                className={`audit-tab${activeTab === "new" ? " active" : ""}`}
                onClick={() => setActiveTab("new")}
              >
                <Plus size={16} /> New Order
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "pending"}
                className={`audit-tab${activeTab === "pending" ? " active" : ""}`}
                onClick={() => setActiveTab("pending")}
              >
                <PackageCheck size={16} /> Pending Receipt
                {openOrders.length > 0 ? (
                  <span className="audit-tab-badge">{openOrders.length}</span>
                ) : null}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "closed"}
                className={`audit-tab${activeTab === "closed" ? " active" : ""}`}
                onClick={() => setActiveTab("closed")}
              >
                <CheckCircle size={16} /> Closed Orders
              </button>
            </div>

            {/* ReorderTab stays mounted across tab switches (hidden via CSS
             *  when not active) so onCountChange keeps firing as inventory
             *  changes. Otherwise, receiving an order on the Pending tab
             *  would silently leave the Reorder badge stale until the user
             *  navigates back. */}
            {inventoryLoaded && (
              <div style={{ display: activeTab === "reorder" ? undefined : "none" }}>
                <ReorderTab
                  rows={inventoryRows}
                  availableLocations={locationValues}
                  availableLocationsFull={sortedLocations}
                  availableVendors={vendorValues}
                  onAddVendor={handleAddVendor}
                  selectedLocationId={selectedLocationId ?? null}
                  onSelectedLocationIdChange={onSelectedLocationIdChange}
                  onSaveItemFields={handleSaveItemFields}
                  onCountChange={setReorderCount}
                  onMarkOrdered={handleMarkOrdered}
                />
              </div>
            )}

            {activeTab === "new" && (
              <ComposeOrderPanel
                inventoryRows={inventoryRows}
                availableVendors={vendorValues}
                onAddVendor={handleAddVendor}
                onSubmit={handleSubmitComposeOrder}
              />
            )}

            {activeTab === "pending" && (
              <div className="orders-section">
                {openOrders.length === 0 ? (
                  <EmptyState
                    icon={PackageCheck}
                    title="No orders waiting to be received"
                    hint="Place an order from the Reorder or New Order tab and it'll show up here."
                  />
                ) : (
                  openOrders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      hasExpirationColumn={hasExpirationColumn}
                      inventoryRows={inventoryRows}
                      onRefresh={handleOrderChanged}
                    />
                  ))
                )}
              </div>
            )}

            {activeTab === "closed" && (
              <div className="orders-section">
                {closedOrders.length === 0 ? (
                  <EmptyState
                    icon={CheckCircle}
                    title="No closed orders yet"
                    hint="Orders move here once they're fully received or cancelled."
                  />
                ) : (
                  <>
                    {/* Search + compact "Date range" popover. Mirrors Activity's
                     *  search styling; the date range is hidden behind a pill
                     *  button so the toolbar reads as one row instead of the
                     *  old wide From/To strip. */}
                    <div className="closed-orders-filter">
                      <div className="audit-search-container">
                        <Search size={14} className="audit-search-icon" aria-hidden="true" />
                        <input
                          type="search"
                          className="audit-search-input"
                          placeholder="Search vendor, item, or note…"
                          value={closedSearch}
                          onChange={(e) => setClosedSearch(e.target.value)}
                          aria-label="Search closed orders"
                        />
                        {closedSearch ? (
                          <button
                            type="button"
                            className="audit-search-clear"
                            onClick={() => setClosedSearch("")}
                            aria-label="Clear search"
                            title="Clear search"
                          >
                            <X size={14} />
                          </button>
                        ) : null}
                      </div>
                      <div className="audit-filter-container" ref={dateFilterRef}>
                        <button
                          type="button"
                          className={`button button-secondary button-sm closed-orders-daterange-toggle${
                            dateRangeLabel ? " active" : ""
                          }`}
                          onClick={() => setDateFilterOpen((o) => !o)}
                          aria-expanded={dateFilterOpen}
                          aria-haspopup="dialog"
                        >
                          <Calendar size={14} />
                          {dateRangeLabel ?? "Date range"}
                        </button>
                        {dateFilterOpen && (
                          <div
                            className="audit-filter-menu closed-orders-daterange-menu"
                            role="dialog"
                            aria-label="Filter closed orders by date"
                          >
                            <div className="closed-orders-daterange-fields">
                              <div className="closed-orders-daterange-field">
                                <label className="field-label" htmlFor="closed-orders-date-from">From</label>
                                <input
                                  id="closed-orders-date-from"
                                  className="field"
                                  type="date"
                                  value={closedFromDate}
                                  onChange={(e) => setClosedFromDate(e.target.value)}
                                />
                              </div>
                              <div className="closed-orders-daterange-field">
                                <label className="field-label" htmlFor="closed-orders-date-to">To</label>
                                <input
                                  id="closed-orders-date-to"
                                  className="field"
                                  type="date"
                                  value={closedToDate}
                                  onChange={(e) => setClosedToDate(e.target.value)}
                                />
                              </div>
                            </div>
                            {(closedFromDate || closedToDate) && (
                              <button
                                type="button"
                                className="button button-secondary button-sm closed-orders-daterange-clear"
                                onClick={() => {
                                  setClosedFromDate("");
                                  setClosedToDate("");
                                }}
                              >
                                Clear dates
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      {closedFilterActive && (
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          onClick={() => {
                            setClosedSearch("");
                            setClosedFromDate("");
                            setClosedToDate("");
                          }}
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                    {closedFilterActive && (
                      <p className="orders-section-count">
                        {filteredClosedOrders.length} of {closedOrders.length}
                      </p>
                    )}
                    {filteredClosedOrders.length === 0 ? (
                      <p className="closed-orders-empty">No closed orders match your filter.</p>
                    ) : (
                      <div className="audit-flat-feed closed-orders-feed">
                        {closedOrdersByDay.map((day) => (
                          <DaySection
                            key={day.label}
                            label={day.label}
                            summary={`${day.orders.length} order${day.orders.length !== 1 ? "s" : ""}`}
                            defaultOpen={day.label === "Today" || day.label === "Yesterday"}
                          >
                            <div className="closed-orders-day-cards">
                              {day.orders.map((order) => (
                                <OrderCard
                                  key={order.id}
                                  order={order}
                                  hasExpirationColumn={hasExpirationColumn}
                                  inventoryRows={inventoryRows}
                                  onRefresh={handleOrderChanged}
                                />
                              ))}
                            </div>
                          </DaySection>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
