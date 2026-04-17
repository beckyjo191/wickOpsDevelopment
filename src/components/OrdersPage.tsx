import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Loader2,
  PackageCheck,
  RotateCcw,
  X,
} from "lucide-react";
import {
  closeRestockOrder,
  createRestockOrder,
  listRestockOrders,
  loadInventoryBootstrap,
  receiveRestockOrder,
  saveInventoryItems,
  type InventoryRow,
  type RestockOrder,
  type RestockOrderItem,
  type RestockReceiveLine,
} from "../lib/inventoryApi";
import { ReorderTab, type OrderItem } from "./ReorderTab";


interface OrdersPageProps {
  selectedLocation?: string | null;
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

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount);
}

// Accepts user input like "$4,239.00", "4239", "4,239.5" and returns the
// parsed number. Returns NaN for empty / unparseable strings — callers should
// check `Number.isFinite` before using the result.
function parseCurrency(input: string): number {
  return Number(input.replace(/[$,\s]/g, ""));
}

function orderTotalCost(items: RestockOrderItem[]): number | null {
  const itemsWithCost = items.filter((i) => i.unitCost !== undefined);
  if (itemsWithCost.length === 0) return null;
  return itemsWithCost.reduce((sum, i) => sum + (i.unitCost ?? 0) * i.qtyOrdered, 0);
}

function StatusBadge({ status, cancelled }: { status: RestockOrder["status"]; cancelled?: boolean }) {
  if (cancelled) {
    return (
      <span className="order-status-badge order-status-badge--cancelled">Cancelled</span>
    );
  }
  const map = {
    open: { label: "Ordered", className: "order-status-badge order-status-badge--open" },
    partial: { label: "Partially Received", className: "order-status-badge order-status-badge--partial" },
    closed: { label: "Completed", className: "order-status-badge order-status-badge--closed" },
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
      let prefillCost: number | undefined = i.unitCost;
      let tracksExpiration = false;
      let packSize = 0;
      if (!freeform) {
        const row = inventoryRows.find((r) => r.id === i.itemId);
        if (row) {
          const rowCost = Number(row.values.unitCost);
          if (prefillCost === undefined && Number.isFinite(rowCost) && rowCost >= 0) {
            prefillCost = rowCost;
          }
          // A non-freeform item "tracks expiration" when its inventory row
          // already has a non-empty expiration date. Permanent items (e.g.
          // stethoscopes) have no expiration and shouldn't prompt for one.
          tracksExpiration = String(row.values.expirationDate ?? "").trim() !== "";
          const rowPack = Number(row.values.packSize);
          if (Number.isFinite(rowPack) && rowPack > 0) packSize = rowPack;
        }
      }
      return {
        itemId: i.itemId,
        itemName: i.itemName,
        isFreeform: freeform,
        qtyOrdered: i.qtyOrdered,
        qtyReceived: i.qtyReceived,
        qtyRemaining: i.qtyOrdered - i.qtyReceived,
        qtyThisReceive: String(i.qtyOrdered - i.qtyReceived),
        expirationDate: "",
        unitCost: prefillCost !== undefined ? formatCurrency(prefillCost) : "",
        addToInventory: freeform,  // default to save for freeform items
        tracksExpiration,
        packSize,
        receivingAsBoxes: false,
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
            ...(l.isFreeform ? { addToInventory: l.addToInventory } : {}),
          };
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
      if (qty > 0 && l.isFreeform && l.addToInventory && hasExpirationColumn && !l.expirationDate) {
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
    const shortLines = validated.filter((l) => Number(l.qtyThisReceive) < l.qtyRemaining);
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
        <button type="button" className="button button-ghost button-sm" onClick={onCancel}>
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
                <label className="order-receive-add-inventory">
                  <input
                    type="checkbox"
                    checked={line.addToInventory}
                    onChange={(e) => updateLine(line.itemId, { addToInventory: e.target.checked })}
                  />
                  Save to inventory
                </label>
              )}
              {line.packSize > 0 && (
                <div className="order-receive-box-toggle">
                  <label className="order-receive-add-inventory">
                    <input
                      type="checkbox"
                      checked={line.receivingAsBoxes}
                      onChange={(e) => updateLine(line.itemId, {
                        receivingAsBoxes: e.target.checked,
                        // Reset qty/cost to defaults when flipping mode so the
                        // numbers stay coherent.
                        qtyThisReceive: "",
                        unitCost: "",
                      })}
                    />
                    {line.receivingAsBoxes ? "Received by box —" : `Received by box (${line.packSize}/box)`}
                  </label>
                  {line.receivingAsBoxes && (
                    <span className="order-receive-packsize-wrap">
                      <input
                        type="number"
                        min="1"
                        className="order-receive-packsize-input"
                        value={line.packSize}
                        onChange={(e) => {
                          // Per-receive override: change pack size for this
                          // shipment without writing back to the inventory
                          // row. Handles vendors that ship different box
                          // sizes than the row's default.
                          const n = Number(e.target.value);
                          updateLine(line.itemId, {
                            packSize: Number.isFinite(n) && n > 0 ? n : 0,
                          });
                        }}
                      />
                      <span>/box</span>
                    </span>
                  )}
                </div>
              )}
              {line.error && <span className="order-form-line-error">{line.error}</span>}
            </div>
            <div className="order-receive-cell" data-label="Ordered">
              <div className="order-receive-progress">
                <span>{line.qtyOrdered}</span>
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
              />
            </div>
            {hasExpirationColumn && (
              <div className="order-receive-cell" data-label="Expiration">
                {line.tracksExpiration || (line.isFreeform && line.addToInventory) ? (
                  <input
                    className={`field${line.error && !line.expirationDate ? " field--error" : ""}`}
                    type="date"
                    value={line.expirationDate}
                    onChange={(e) => updateLine(line.itemId, { expirationDate: e.target.value, error: "" })}
                  />
                ) : (
                  <span className="order-receive-cell-na">—</span>
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
              const short = l.qtyRemaining - Number(l.qtyThisReceive);
              return (
                <li key={l.itemId}>
                  {l.itemName}: receiving {Number(l.qtyThisReceive)} of {l.qtyRemaining} — {short} short
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
              className="button button-ghost"
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
        onReceived={() => { setShowReceive(false); onRefresh(order); }}
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
                  <PackageCheck size={13} /> Receive
                </button>
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  onClick={() => setConfirmingCancel(true)}
                  disabled={closing}
                  title="Cancel order — items return to reorder list"
                >
                  <X size={13} /> Cancel
                </button>
              </>
            )}
            {/* No expand for fresh-open orders — there's nothing in the detail
                that isn't already in the header. Keep expand for partial (to
                show progress) and closed (full history). */}
            {order.status !== "open" && (
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Collapse" : "Expand"}
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
              <AlertTriangle size={15} />
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
                className="button button-ghost button-sm"
                onClick={handleConfirmCancel}
                disabled={closing}
              >
                {closing ? <Loader2 size={13} className="spin" /> : <X size={13} />}
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
                return (
                  <tr key={item.itemId} className={item.qtyReceived >= item.qtyOrdered ? "order-detail-row--done" : ""}>
                    <td>
                      {item.itemName}
                      {item.itemId.startsWith("freeform-") && (
                        <span className="order-freeform-badge">new</span>
                      )}
                    </td>
                    <td>{item.qtyOrdered}</td>
                    <td>{item.qtyReceived}</td>
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
                    <td>{item.unitCost !== undefined ? formatCurrency(item.unitCost) : "—"}</td>
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

function OrdersHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="orders-help-btn"
        onClick={() => setOpen(true)}
        aria-label="How Orders work"
        title="How Orders work"
      >
        <HelpCircle size={16} />
      </button>
      {open && (
        <div
          className="orders-help-overlay"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="orders-help-modal app-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="orders-help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="orders-help-modal-header">
              <h3 id="orders-help-title">How Orders work</h3>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="orders-help-modal-body">
              <p className="orders-help-lead">
                The Orders page helps you keep stock topped up — from spotting
                low items, to placing orders, to logging what arrived.
              </p>

              <p className="orders-help-flow">
                <strong>Reorder</strong>
                <span aria-hidden="true"> → </span>
                <strong>Pending Receipt</strong>
                <span aria-hidden="true"> → </span>
                <strong>Closed Orders</strong>
              </p>

              <h4>Reorder</h4>
              <p>
                Shows items that are running low (below the minimum you set for
                that item). Items are grouped by vendor.
              </p>
              <ul>
                <li>
                  <strong>Check the items</strong> you want to order. Adjust the
                  suggested quantity or fill in a price if you know it.
                </li>
                <li>
                  <strong>Add Item Not Listed</strong> — type in something that
                  isn't in your inventory yet (a new product, or trying a new
                  vendor).
                </li>
                <li>
                  <strong>Mark as Ordered</strong> — creates an order in Pending
                  Receipt. Those items leave the reorder list until you receive
                  or cancel.
                </li>
              </ul>

              <h4>Pending Receipt</h4>
              <p>Orders you've placed but haven't received yet.</p>
              <ul>
                <li>
                  <strong>Receive</strong> — log what actually arrived. You can
                  enter a smaller quantity if the shipment was short, add the
                  expiration date, and update the price. Your inventory
                  quantities go up automatically. When you've received
                  everything, the order closes itself.
                </li>
                <li>
                  <strong>Partial shipments</strong> — if only some of the items
                  arrived, enter the smaller amounts you actually received and
                  confirm. You'll be asked whether to close the order with
                  those amounts, or leave it open so you can receive the rest
                  later. If you leave it open, the order stays in Pending
                  Receipt with a <strong>Partially Received</strong> badge, and
                  you can click Receive again when the rest shows up. The
                  inventory numbers update each time you receive.
                </li>
                <li>
                  <strong>Cancel</strong> — close the order without receiving
                  anything. The items go back to the reorder list so you can
                  try again (maybe with a different vendor). Jot a quick note
                  explaining why if you want (for example, "vendor cancelled"
                  or "6-week lead time"). Brand-new items you added get saved
                  to your inventory so nothing is lost.
                </li>
              </ul>

              <h4>Closed Orders</h4>
              <p>
                Finished orders. You can search by vendor, item, or note, and
                filter by date range.
              </p>
              <ul>
                <li>
                  <strong>COMPLETED</strong> — the order wrapped up normally
                  (everything arrived, or you closed it after a partial
                  shipment).
                </li>
                <li>
                  <strong>CANCELLED</strong> — the order was closed before
                  anything arrived.
                </li>
                <li>
                  Click any order to see its items and a timeline of when
                  things happened (ordered, received, closed).
                </li>
              </ul>

              <h4>Tips</h4>
              <ul>
                <li>
                  The "low stock" number is set on each item in the Inventory
                  tab — change it there to tune when an item shows up here.
                </li>
                <li>
                  Expired stock doesn't count toward what you have on hand, so
                  an item can show up for reorder even if there are expired
                  units sitting on the shelf.
                </li>
                <li>
                  Adding a vendor link to an item lets WickOps group it under
                  the right vendor card next time you reorder.
                </li>
                <li>
                  You can paste a price like $4,239.00 in the unit cost field —
                  it'll clean itself up once you click somewhere else.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Orders Page ───────────────────────────────────────────────────────

export function OrdersPage({ selectedLocation }: OrdersPageProps) {
  const [orders, setOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [hasExpirationColumn, setHasExpirationColumn] = useState(false);
  const [registeredLocations, setRegisteredLocations] = useState<string[]>([]);
  const inventoryRowsRef = useRef<InventoryRow[]>([]);

  // Known locations = registered ones (even if unused) + any location that shows up
  // on existing rows. Used by the "Add Item Not Listed" form so users can assign
  // a location to new items.
  const locationValues = useMemo(() => {
    const fromRows = inventoryRows
      .map((row) => String(row.values.location ?? "").trim())
      .filter((v) => v.length > 0);
    return Array.from(new Set([...registeredLocations, ...fromRows])).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [inventoryRows, registeredLocations]);

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
    loadInventoryBootstrap().then(({ columns, items, registeredLocations: locs }) => {
      setInventoryRows(items);
      inventoryRowsRef.current = items;
      setHasExpirationColumn(columns.some((c) => c.key === "expirationDate" && c.isVisible));
      setRegisteredLocations(Array.isArray(locs) ? locs : []);
    }).catch(() => {}).finally(() => {
      setInventoryLoaded(true);
    });
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
    if (toSave.length > 0) await saveInventoryItems(toSave, []).catch(() => {});

    if (orderItems.length > 0) {
      await createRestockOrder({
        vendor: vendor || undefined,
        items: orderItems.map((item) => ({
          ...(item.rowId ? { itemId: item.rowId } : {}),
          itemName: item.name,
          qtyOrdered: item.qty,
          ...(item.reorderLink ? { reorderLink: item.reorderLink } : {}),
          ...(item.location ? { location: item.location } : {}),
        })),
      }).catch(() => {});
      loadOrders();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveReorderLink = useCallback(async (rowIds: string[], link: string) => {
    const idSet = new Set(rowIds);
    const current = inventoryRowsRef.current;
    const toSave = current
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...r, position: current.indexOf(r), values: { ...r.values, reorderLink: link } }));
    const updated = current.map((r) =>
      idSet.has(r.id) ? { ...r, values: { ...r.values, reorderLink: link } } : r,
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
            values: {
              itemName: oi.itemName,
              quantity: 0,
              minQuantity: oi.qtyOrdered,
              // Seed location from the order item (captured at Add-Item time).
              // Fall back to the current location context, then "" (Unassigned).
              location: oi.location ?? selectedLocation ?? "",
              ...(oi.reorderLink ? { reorderLink: oi.reorderLink } : {}),
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

  // Closed-orders filter state: free-text search (vendor / notes / item names)
  // plus optional date range on createdAt.
  const [closedSearch, setClosedSearch] = useState("");
  const [closedFromDate, setClosedFromDate] = useState("");
  const [closedToDate, setClosedToDate] = useState("");

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

  return (
    <section className="app-page orders-page">
      <div className="orders-page-header">
        <h2 className="orders-page-title">
          <RotateCcw size={16} /> Orders
        </h2>
        <OrdersHelp />
      </div>

      <div className="orders-content">
        {error && <p className="orders-error">{error}</p>}

          {loading && (
            <div className="orders-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}

          {!loading && openOrders.length > 0 && (
            <div className="orders-section">
              <div className="orders-section-header">
                <PackageCheck size={14} />
                <span>Pending Receipt</span>
              </div>
              {openOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  hasExpirationColumn={hasExpirationColumn}
                  inventoryRows={inventoryRows}
                  onRefresh={handleOrderChanged}
                />
              ))}
            </div>
          )}

          {inventoryLoaded && (
            <ReorderTab
              rows={inventoryRows}
              availableLocations={locationValues}
              selectedLocation={selectedLocation ?? null}
              onMarkOrdered={handleMarkOrdered}
              onSaveReorderLink={handleSaveReorderLink}
            />
          )}

          {closedOrders.length > 0 && (
            <div className="orders-section">
              <div className="orders-section-header">
                <CheckCircle size={14} />
                <span>Closed Orders</span>
                <span className="orders-section-count">
                  {closedFilterActive
                    ? `${filteredClosedOrders.length} of ${closedOrders.length}`
                    : closedOrders.length}
                </span>
              </div>
              <div className="closed-orders-filter">
                <input
                  className="field"
                  type="search"
                  placeholder="Search vendor, item, or note…"
                  value={closedSearch}
                  onChange={(e) => setClosedSearch(e.target.value)}
                />
                <label className="closed-orders-filter-date">
                  <span>From</span>
                  <input
                    className="field"
                    type="date"
                    value={closedFromDate}
                    onChange={(e) => setClosedFromDate(e.target.value)}
                  />
                </label>
                <label className="closed-orders-filter-date">
                  <span>To</span>
                  <input
                    className="field"
                    type="date"
                    value={closedToDate}
                    onChange={(e) => setClosedToDate(e.target.value)}
                  />
                </label>
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
                    Clear
                  </button>
                )}
              </div>
              {filteredClosedOrders.length === 0 ? (
                <p className="closed-orders-empty">No closed orders match your filter.</p>
              ) : (
                filteredClosedOrders.map((order) => (
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
      </div>
    </section>
  );
}
