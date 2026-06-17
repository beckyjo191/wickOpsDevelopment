import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  PackageCheck,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from "lucide-react";
import { HelpModal } from "./shared/HelpModal";
import { EmptyState } from "./shared/EmptyState";
import { LoadingState } from "./shared/LoadingState";
import { QtyStepper } from "./shared/QtyStepper";
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
  type ItemVendorPricingEntry,
} from "../lib/inventoryApi";
import { VendorSelect, type OrderItem } from "./ReorderTab";
import { ShoppingListTab } from "./ShoppingListTab";
import { ItemDetailModal } from "./inventory/ItemDetailModal";
import { PaginationControls } from "./inventory/PaginationControls";
import { UnitCombobox } from "./inventory/UnitCombobox";
import { formatCurrency, parseCurrency } from "../lib/currency";
import {
  dimensionForUnit,
  KNOWN_UNITS,
  pricePerCanonical,
} from "../lib/uom";


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
  /** Pack size snapshotted from the order line's vendor pricing row at
   *  compose time. >0 enables "Received by pack" mode where the user
   *  enters packs + pack cost instead of units + unit cost. The receive
   *  form live-reads the current `vendorPricing` map on render to
   *  pick up i-modal edits made mid-receive — this snapshot is the
   *  fallback for freeform items that don't have a vendor pricing row
   *  yet. */
  packSize: number;
  /** Box mode toggle (only meaningful when packSize > 0). When true,
   *  qtyThisReceive is in PACKS and unitCost is the PER-PACK price. We convert
   *  back to units on submit. */
  receivingAsBoxes: boolean;
  /** The item's tracking unit (1f). Drives the receive form's label so
   *  weight/volume items don't read "Qty Receiving (ct)" by default.
   *  Falls back to "ct" for legacy items without a unit set. */
  unit: string;
  /** Pack label from the vendor's pricing row (1g). Used to render pack
   *  info as "1 box of 100 ct" instead of generic "1 pack of 100 ct".
   *  Defaults to "pack" when absent. */
  packLabel: string;
  error: string;
};

function ReceiveOrderForm({
  order,
  hasExpirationColumn,
  inventoryRows,
  vendorPricing,
  onOpenItemDetails,
  onReceived,
  onCancel,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  /** Current inventory rows — used to pre-fill unit cost from the row's
   *  cached latest price when the order item itself doesn't carry one. */
  inventoryRows: InventoryRow[];
  /** 1g.6: per-(item, vendor) pricing rows. Pre-fill prefers the entry for
   *  the order's vendor (most accurate — matches what the user paid last
   *  time at this vendor) over the row.values cached latest. */
  vendorPricing: Map<string, Map<string, ItemVendorPricingEntry>>;
  /** 1h.8: per-line "edit pricing" opener. Each line renders an i
   *  button that calls this with the item id; the parent owns the
   *  ItemDetailModal mount. Mid-receive edits to the modal flow back
   *  to this form via `vendorPricing` (live-read on render). */
  onOpenItemDetails?: (itemId: string) => void;
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
      let rowUnit = "ct"; // 1f: tracking unit per row, default ct for legacy items
      let packLabel = ""; // 1g: vendor's name for the pack ("box", "bag"); default → "pack"
      if (!freeform) {
        const row = inventoryRows.find((r) => r.id === i.itemId);
        // 1g.6: vendorPricing for the order's vendor is the freshest known
        // price. Falls through to the legacy row.values reads when no entry
        // exists yet (transitional — the migration seeded entries from
        // existing data, so most items will have one).
        const vp = order.vendor && row
          ? vendorPricing.get(row.id)?.get(order.vendor.trim().toLowerCase())
          : undefined;
        if (row) {
          if (prefillUnitCost === undefined) {
            if (vp?.unitCost !== undefined) {
              prefillUnitCost = vp.unitCost;
            } else {
              const rowCost = Number(row.values.unitCost);
              if (Number.isFinite(rowCost) && rowCost >= 0) prefillUnitCost = rowCost;
            }
          }
          // A non-freeform item "tracks expiration" when its inventory row
          // already has a non-empty expiration date. Permanent items (e.g.
          // stethoscopes) have no expiration and shouldn't prompt for one.
          tracksExpiration = String(row.values.expirationDate ?? "").trim() !== "";
          // 1h.7: prefer the new dual-axis `packCount` field (count of
          // items per pack) over legacy `packSize`. Falls back to the
          // legacy row.values.packSize for very old rows that haven't
          // been touched in the i modal yet.
          if (vp?.packCount !== undefined && vp.packCount > 0) {
            packSize = vp.packCount;
          } else if (vp?.packSize !== undefined && vp.packSize > 0) {
            packSize = vp.packSize;
          } else {
            const rowPack = Number(row.values.packSize);
            if (Number.isFinite(rowPack) && rowPack > 0) packSize = rowPack;
          }
          if (vp?.packCost !== undefined && vp.packCost >= 0) {
            rowPackCost = vp.packCost;
          } else {
            const pc = Number(row.values.packCost);
            if (Number.isFinite(pc) && pc >= 0) rowPackCost = pc;
          }
          const u = String(row.values.unit ?? "").trim();
          if (u) rowUnit = u;
          // packLabel only lives on the per-vendor pricing row; no inventory-
          // row fallback. Empty string → render falls back to "pack".
          if (vp?.packLabel) packLabel = vp.packLabel;
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
        unit: rowUnit,
        packLabel,
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
      // 1h.8: live-read pack size from current vendorPricing on
      // submit. Modal edits during receive flow are reflected in the
      // payload because we don't trust the per-line snapshot for
      // anything other than fallback (freeform items pre-pricing).
      const orderVendorLowerSubmit = (order.vendor ?? "").trim().toLowerCase();
      const receiveLines: RestockReceiveLine[] = validated
        .filter((l) => Number(l.qtyThisReceive) > 0)
        .map((l) => {
          const rawQty = Number(l.qtyThisReceive);
          const liveVp = orderVendorLowerSubmit
            ? vendorPricing.get(l.itemId)?.get(orderVendorLowerSubmit)
            : undefined;
          const effectivePackSize = Number(liveVp?.packCount ?? liveVp?.packSize ?? l.packSize ?? 0);
          const unitQty = l.receivingAsBoxes && effectivePackSize > 0 ? rawQty * effectivePackSize : rawQty;
          const perUnitCost = l.unitCost.trim()
            ? (l.receivingAsBoxes && effectivePackSize > 0
                ? parseCurrency(l.unitCost) / effectivePackSize
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
        {lines.map((line) => {
          // 1h.8: live-read pack size from current vendorPricing on
          // each render. The order line carries a snapshot from
          // compose time, but if the user opens the i modal mid-
          // receive and changes pack count, we want the receive form
          // to reflect that immediately. Falls through to the
          // snapshot for items with no vendor pricing row yet
          // (freeform purchases that haven't materialized).
          const orderVendorLower = (order.vendor ?? "").trim().toLowerCase();
          const liveVp = orderVendorLower
            ? vendorPricing.get(line.itemId)?.get(orderVendorLower)
            : undefined;
          const effectivePackSize = Number(liveVp?.packCount ?? liveVp?.packSize ?? line.packSize ?? 0);
          return (
          <div key={line.itemId} className="order-receive-row">
            <div className="order-receive-item-name">
              <div className="order-receive-name-row">
                {/* 1h.8: per-line edit-pricing button. Mirrors the
                 *  Reorder + Inventory pattern — single canonical
                 *  entry into the i modal. Hidden for freeform items
                 *  (no vendor pricing row exists yet). */}
                {onOpenItemDetails && !line.isFreeform ? (
                  <button
                    type="button"
                    className="shop-row-edit-btn order-receive-edit-btn"
                    onClick={() => onOpenItemDetails(line.itemId)}
                    aria-label={`Edit pricing for ${line.itemName}`}
                    title="Edit pack count, price, or URL"
                  >
                    <Info size={14} aria-hidden="true" />
                  </button>
                ) : null}
                <span>{line.itemName}</span>
                {line.isFreeform && (
                  <span className="order-receive-new-badge">New item</span>
                )}
              </div>
              {effectivePackSize > 0 && (() => {
                // Render as "1 box of 100 ct" — count + label + size + unit.
                //
                // 1h.8: pack-size edits go through the i modal (the
                // edit-pricing button to the left of the line opens
                // it). The receive form live-reads the current
                // vendorPricing on each render, so a user who edits
                // the modal mid-receive sees the new pack size
                // reflected here immediately — no inline override.
                //
                // Defensive: only append the unit suffix when `unit`
                // is a recognized UoM string. Legacy rows can carry
                // weird values (e.g. a stale packLabel that ended up
                // in the unit field) — falling back to a unit-less
                // "1 pack of 100" reads cleanly without garbling.
                const labelSingular = line.packLabel || "pack";
                const labelPlural = line.packLabel
                  ? (line.packLabel + "s")
                  : "packs";
                const receiving = Number(line.qtyThisReceive) || 0;
                const label = receiving === 1 ? labelSingular : labelPlural;
                const unitClean = (line.unit ?? "").trim();
                const unitSuffix = unitClean && dimensionForUnit(unitClean)
                  ? ` ${unitClean}`
                  : "";
                return (
                  <div className="order-receive-packinfo">
                    {receiving > 0
                      ? `${receiving} ${label} of ${effectivePackSize}${unitSuffix}`
                      : `${labelSingular} of ${effectivePackSize}${unitSuffix}`}
                    {receiving > 0 && (
                      <span className="order-receive-packinfo-math">
                        {" "}· adds {receiving * effectivePackSize}{unitSuffix} to stock
                      </span>
                    )}
                  </div>
                );
              })()}
              {line.error && <span className="order-form-line-error">{line.error}</span>}
            </div>
            <div className="order-receive-cell" data-label="Ordered">
              <div className="order-receive-progress">
                <span>
                  {line.receivingAsBoxes && effectivePackSize > 0
                    ? `${Math.ceil(line.qtyOrdered / effectivePackSize)} pack${Math.ceil(line.qtyOrdered / effectivePackSize) === 1 ? "" : "s"}`
                    : `${line.qtyOrdered} ${line.unit}`}
                </span>
                {line.qtyReceived > 0 && (
                  <span className="order-receive-remaining"> ({line.qtyRemaining} {line.unit} remaining)</span>
                )}
              </div>
            </div>
            <div
              className="order-receive-cell"
              data-label={line.receivingAsBoxes ? "Packs Receiving" : `Receiving (${line.unit})`}
            >
              <input
                className="field"
                type="number"
                min="0"
                step="any"
                max={line.receivingAsBoxes && effectivePackSize > 0
                  ? Math.ceil(line.qtyRemaining / effectivePackSize)
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
              data-label={line.receivingAsBoxes ? "Cost per Pack" : `Cost per ${line.unit}`}
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
          );
        })}
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
  vendorPricing,
  onRefresh,
  onOpenItemDetails,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  inventoryRows: InventoryRow[];
  /** 1g.6: per-(item, vendor) pricing for the receive form pre-fill. */
  vendorPricing: Map<string, Map<string, ItemVendorPricingEntry>>;
  // closedOrder is passed when the order was just received or closed,
  // so the parent can clear orderedAt for its items and refresh inventory.
  onRefresh: (closedOrder?: RestockOrder) => void;
  /** 1h.8: per-line "edit pricing" callback. Forwarded to the receive
   *  form so each line gets an i button that opens the i modal scoped
   *  to that item. Modal edits live-update the form's pack-size
   *  readout via the parent's vendorPricing map. */
  onOpenItemDetails?: (itemId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [closing, setClosing] = useState(false);
  // When true, the card swaps its action row for an inline confirm + note
  // textarea so the user can record why the order was cancelled.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState("");

  const total = orderTotalCost(order.items);
  // Per-line progress instead of per-unit qty totals. Per-unit math gets
  // misleading when an item was ordered as units but received as boxes (or
  // vice versa) because qtyOrdered and qtyReceived end up in different units
  // of measure. Counting lines is the same regardless of pack-size: a line is
  // either fully received or it isn't.
  const linesFullyReceived = order.items.filter(
    (i) => i.qtyReceived >= i.qtyOrdered,
  ).length;
  const totalLines = order.items.length;
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
        vendorPricing={vendorPricing}
        onOpenItemDetails={onOpenItemDetails}
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
            <span className="order-card-items-count">{totalLines} item{totalLines !== 1 ? "s" : ""}</span>
            <span className="order-card-progress">
              {linesFullyReceived === totalLines
                ? `${totalLines} received`
                : `${linesFullyReceived}/${totalLines} received`}
            </span>
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
                // Pack-aware qty rendering. Three branches:
                //   - No pack: just the raw number
                //   - Clean multiple of packSize: "N box of M"
                //   - Otherwise: render as full boxes + a units remainder so
                //     mixed quantities (e.g. 15 units of pack-10) read as
                //     "1 box of 10, 5 units" instead of "1.5 boxes" garbage.
                const formatQtyWithBoxes = (unitQty: number) => {
                  if (unitQty === 0) return "0";
                  if (!isPack) return String(unitQty);
                  const fullBoxes = Math.floor(unitQty / packSize);
                  const remainder = unitQty - fullBoxes * packSize;
                  const boxLabel = (n: number) =>
                    `${n} box${n === 1 ? "" : "es"} of ${packSize}`;
                  const unitLabel = (n: number) =>
                    `${n} unit${n === 1 ? "" : "s"}`;
                  if (fullBoxes === 0) return unitLabel(remainder);
                  if (remainder === 0) return boxLabel(fullBoxes);
                  return `${boxLabel(fullBoxes)}, ${unitLabel(remainder)}`;
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
  /** Per-unit cost. Persists to the order line for analytics and back to the
   *  inventory item's `unitCost` when provided — fills in pricing for items
   *  that didn't have it before. */
  unitCost?: number;
  /** Pack size + pack cost. When both are set, unitCost = packCost / packSize.
   *  Send pack values explicitly so the server can persist them on the item
   *  record (analytics needs the per-pack figure for "spend by pack"). */
  packSize?: number;
  packCost?: number;
  // ── 1f: amount/UoM/price triplet ──────────────────────────────────────────
  // Server infers dimension from purchaseUnit via uom.ts; client doesn't
  // need to send it. Legacy unitCost/packSize/packCost above are still
  // populated for back-compat with the receive form display.
  purchaseAmount?: number;
  purchaseUnit?: string;
  purchasePrice?: number;
};

type ComposeLine = {
  /** Empty for a freeform line — set when picked from inventory. Drives
   *  whether qty bumps an existing item on receive or creates a new
   *  inventory row. */
  itemId?: string;
  itemName: string;
  /** UoM for this line. For existing items it's read from the inventory
   *  row's `unit` column (default "ct" if absent). For freeform items the
   *  user picks from the line's unit dropdown. The dimension family
   *  (count|weight|volume) is inferred from this string at runtime via
   *  uom.ts — no separate dimension field. */
  unit: string;
  /** Purchase amount in `unit` (string-typed so the user can clear).
   *  Count items get a QtyStepper; weight/volume get a decimal input. */
  amount: string;
  /** Total $ paid for this purchase line (currency string). e.g. "$14.99". */
  price: string;
  /** Reorder threshold for freeform items. Existing items already carry
   *  minQuantity on their inventory row, so only collected for freeform. */
  minQuantity: string;
  /** Product URL (where to reorder). Persisted on the order item and on the
   *  inventory row when received with addToInventory. */
  productUrl: string;
  /** Whether the reorder URL input is visible. Hidden behind a button
   *  ("+ Reorder URL") when empty so the line stays compact; auto-true when
   *  a URL is pre-filled from the picked inventory row. */
  urlOpen: boolean;
  /** 1h.1: pack-mode for ordering. Single = amount is in primary units;
   *  Pack = amount is in packs (multiplied by packSize at submit).
   *  Default is "pack" when the vendor has packSize on file (most natural
   *  way to order — "2 boxes" not "200 pads"); otherwise "single". The
   *  toggle is always available even without a vendor packSize so a
   *  one-off pack purchase ("normally buy by unit but grabbed a box of 10
   *  this time") gets recorded properly. */
  mode: "single" | "pack";
  /** 1h.1d: pack size for this purchase when no vendor packSize is on
   *  file. Empty string when the vendor's stored packSize is being used
   *  (the more common case post-1g.7 migration). Submitted alongside the
   *  receipt so the next bootstrap caches it on the vendor's pricing row. */
  packSizeDraft: string;
};

function ComposeOrderPanel({
  inventoryRows,
  availableVendors,
  onAddVendor,
  onSubmit,
  vendorPricing,
  // `allowedUnits` is still passed by the parent for backward-compat but is
  // no longer used — unit comboboxes pull straight from KNOWN_UNITS now.
  allowedUnits: _allowedUnits,
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
  /** 1g.6: per-(item, vendor) pricing rows. When the user has selected a
   *  vendor at the top of the form AND picks an existing item that has a
   *  pricing row for that vendor, defaults are pulled from there. */
  vendorPricing: Map<string, Map<string, ItemVendorPricingEntry>>;
  /** 1h.2c: per-org curated unit list, used by the freeform unit picker.
   *  Empty falls back to the master KNOWN_UNITS list. */
  allowedUnits: string[];
}) {
  const blankLineExtras = {
    minQuantity: "",
    productUrl: "",
    amount: "1",
    price: "",
  };
  const makeEmptyLine = (): ComposeLine => ({
    itemName: "",
    unit: "ct",
    urlOpen: false,
    mode: "single",
    packSizeDraft: "",
    ...blankLineExtras,
  });

  /** Build a partial ComposeLine patch when picking an existing inventory
   *  item. Pricing/pack/URL come ONLY from `vendorPricing[itemId][vendor]`
   *  — never from legacy row.values fields. Those legacy fields belonged
   *  to the pre-1g single-vendor world and bleed in stale data now: an
   *  item that was last bought from BoundTree shouldn't show BoundTree's
   *  URL when the user has Bitterroot selected (or no vendor at all).
   *
   *  Without an active vendor, the line shows just unit + blank pricing.
   *  Without an entry for the active vendor, same. The user fills it in;
   *  on submit the receive flow persists onto the (item, vendor) row.
   *  Unit is always read from row.values.unit since it's item-level. */
  const defaultsFromInventoryRow = (
    row: InventoryRow,
    activeVendor: string,
  ): Partial<ComposeLine> => {
    const v = row.values;
    const storedUnit = String(v.unit ?? "").trim();

    const vp = activeVendor
      ? vendorPricing.get(row.id)?.get(activeVendor.trim().toLowerCase())
      : undefined;

    // 1h.7: derive the line's unit from the dual-axis pricing row.
    //   - packAmountUnit set      → that's the bulk weight/volume unit.
    //   - packCount set, no amount → count tracking ("ct").
    //   - neither                  → fall back to legacy item.unit, then "ct".
    const candidateUnit = (vp?.packAmountUnit ?? "").trim()
      || (vp?.packCount !== undefined ? "ct" : "")
      || storedUnit;
    const unit = candidateUnit && dimensionForUnit(candidateUnit) ? candidateUnit : "ct";
    const isCountUnit = dimensionForUnit(unit) === "count";

    // Vendor-only sources — empty when no vp entry exists. No row.values
    // fallback (legacy fields would leak data the user didn't intend).
    // 1h.7: prefer packCount over the legacy packSize when both are
    // present; old rows that haven't been touched in the i modal still
    // surface via packSize so the compose preview isn't blank.
    const unitCost = vp?.unitCost ?? null;
    const packSize = vp?.packCount ?? vp?.packSize ?? null;
    const packCost = vp?.packCost ?? null;
    const reorderLink = vp?.reorderUrl ?? "";

    const hasVendorPack = (packSize ?? 0) > 0;
    const mode: "single" | "pack" = hasVendorPack ? "pack" : "single";

    let amount = "1";
    let price = "";
    if (mode === "pack" && packSize && packSize > 0) {
      amount = "1"; // 1 pack
      if (packCost !== null) price = formatCurrency(packCost);
    } else if (isCountUnit && unitCost !== null) {
      amount = "1";
      price = formatCurrency(unitCost);
    }
    // Weight/volume single mode (or any mode without a vendor entry):
    // leave price blank — user types per-purchase.

    return {
      unit,
      amount,
      price,
      productUrl: reorderLink,
      urlOpen: reorderLink.length > 0,
      mode,
      // Reset any user-typed pack-size override; vendor data (or its
      // absence) drives this line's display now.
      packSizeDraft: "",
    };
  };

  const [vendor, setVendor] = useState("");
  const [notes, setNotes] = useState("");
  const [markReceived, setMarkReceived] = useState(false);
  // Always start with one empty line so the picker is visible — matches
  // Log Usage's pattern (one empty entry waiting for input).
  const [lines, setLines] = useState<ComposeLine[]>(() => [makeEmptyLine()]);

  /** 1h.0: when the user changes the top-level vendor mid-edit, locked-in
   *  lines re-pull pricing + URL from the new vendor's pricing row. Lines
   *  the user added that have NO inventory itemId (freeform) are untouched
   *  — their data is whatever the user typed. The receive-side info bug
   *  ("BoundTree URL leaking into a Bitterroot session") is fixed here by
   *  letting the defaults function refetch with the new activeVendor. */
  const handleVendorChange = (next: string) => {
    setVendor(next);
    setLines((prev) => prev.map((l) => {
      if (!l.itemId) return l; // freeform — leave the user's typed values
      const row = inventoryRows.find((r) => r.id === l.itemId);
      if (!row) return l;
      const refreshed = defaultsFromInventoryRow(row, next);
      // 1h.1: vendor change refreshes vendor-scoped fields. price/url/mode
      // come straight from defaultsFromInventoryRow which now always
      // returns defined values (empty when no vendor entry exists), so
      // switching to a vendor with no data clears the previous vendor's
      // pre-fill instead of leaving it stranded.
      return {
        ...l,
        unit: refreshed.unit ?? l.unit,
        amount: refreshed.amount ?? l.amount,
        price: refreshed.price ?? "",
        productUrl: refreshed.productUrl ?? "",
        urlOpen: refreshed.urlOpen ?? false,
        mode: refreshed.mode ?? "single",
        packSizeDraft: "",
      };
    }));
  };
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
  // itemId + itemName, and pre-fills cost / pack / link from the inventory
  // row so the user sees what's currently on file. Anything left untouched
  // stays as-is on submit (server only writes fields the user actually
  // populated). The line stays in "filled" mode until the user clicks × to
  // clear it (which restores the autocomplete).
  const pickExistingForLine = (idx: number, itemId: string, name: string) => {
    if (lines.some((l, i) => i !== idx && l.itemId === itemId)) return;
    const row = inventoryRows.find((r) => r.id === itemId);
    const defaults = row ? defaultsFromInventoryRow(row, vendor) : {};
    updateLine(idx, { itemId, itemName: name, ...defaults });
  };

  // Pick a freeform (brand-new) item for the given line. No itemId; pricing
  // and min-qty inputs surface inline once a line is filled (for any line),
  // so freeform items don't need a separate "expanded" flag.
  const pickFreeformForLine = (idx: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateLine(idx, { itemId: undefined, itemName: trimmed });
  };

  // Restore a line to search mode (the autocomplete picker reappears).
  const clearLineItem = (idx: number) => {
    updateLine(idx, {
      itemId: undefined,
      itemName: "",
      unit: "ct",
      ...blankLineExtras,
      urlOpen: false,
      mode: "single",
      packSizeDraft: "",
    });
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
      const amountNum = Number(l.amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setError(`${name}: amount must be greater than 0.`);
        return;
      }
      // Reject unrecognized units up-front so the server doesn't have to
      // bounce the request back. Picker constrains this in normal use.
      const unitDimension = dimensionForUnit(l.unit);
      if (!unitDimension) {
        setError(`${name}: unrecognized unit "${l.unit}".`);
        return;
      }
      let priceNum: number | undefined;
      if (l.price.trim()) {
        const parsed = parseCurrency(l.price);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(`${name}: price must be a non-negative number.`);
          return;
        }
        priceNum = parsed;
      }

      let minQuantity: number | undefined;
      if (l.minQuantity.trim()) {
        const parsed = Number(l.minQuantity);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(`${name}: min quantity must be non-negative.`);
          return;
        }
        minQuantity = unitDimension === "count" ? Math.floor(parsed) : parsed;
      }
      const productUrl = l.productUrl.trim();
      const reorderLink = productUrl
        ? (/^https?:\/\//i.test(productUrl) ? productUrl : `https://${productUrl}`)
        : undefined;

      // 1h.1: pack-mode multiplier. Pack mode means amount = packs; the
      // server stores in primary units so we multiply through. Pack size
      // comes from (in order): vendor's stored packSize → user-typed
      // packSizeDraft on this line → fallback 1 (no-op). The typed value
      // gets persisted onto the vendor pricing row at receive time so the
      // next purchase at this vendor auto-populates.
      const vp = (l.itemId && vendor.trim())
        ? vendorPricing.get(l.itemId)?.get(vendor.trim().toLowerCase())
        : undefined;
      const vendorPackSize = Number(vp?.packSize ?? 0);
      const draftPackSize = Number(l.packSizeDraft);
      const submitPackSize = vendorPackSize > 0
        ? vendorPackSize
        : (Number.isFinite(draftPackSize) && draftPackSize > 0
            ? Math.floor(draftPackSize)
            : 0);
      const isPackSubmit = l.mode === "pack" && submitPackSize > 0;
      // When user toggled Pack but didn't type a size, error out so we
      // don't silently treat it as single mode (their intent was packs).
      if (l.mode === "pack" && submitPackSize === 0) {
        setError(`${name}: pack size required for pack-mode order.`);
        return;
      }
      const effectivePackSize = isPackSubmit ? submitPackSize : 1;
      const qtyInPrimaryUnits = amountNum * effectivePackSize;

      // ── Back-compat shim: derive legacy unitCost / packSize / packCost so
      // the receive form + analytics that still read these fields keep
      // working. In pack mode the user typed "1 box for $24.99" so:
      //   packSize = vendor's packSize, packCost = price, unitCost = price/packSize
      // In single mode, fall back to the prior count/weight/volume rules.
      let legacyUnitCost: number | undefined;
      let legacyPackSize: number | undefined;
      let legacyPackCost: number | undefined;
      if (priceNum !== undefined) {
        if (isPackSubmit && effectivePackSize > 0) {
          legacyPackSize = effectivePackSize;
          // packCost = $ per pack. amount=2 packs at $X total → packCost = X/2.
          legacyPackCost = priceNum / amountNum;
          legacyUnitCost = legacyPackCost / effectivePackSize;
        } else if (unitDimension === "count") {
          if (amountNum > 1) {
            legacyPackSize = Math.floor(amountNum);
            legacyPackCost = priceNum;
            legacyUnitCost = priceNum / amountNum;
          } else {
            legacyUnitCost = priceNum;
          }
        } else {
          const canon = pricePerCanonical(priceNum, amountNum, l.unit);
          if (canon) legacyUnitCost = canon.pricePerCanonical;
        }
      }

      payloadLines.push({
        ...(l.itemId ? { itemId: l.itemId } : {}),
        itemName: name,
        // qtyOrdered is always in primary units. Pack-mode amounts are
        // multiplied through here before sending.
        qtyOrdered: qtyInPrimaryUnits,
        ...(minQuantity !== undefined ? { minQuantity } : {}),
        ...(reorderLink ? { reorderLink } : {}),
        // Legacy back-compat shape.
        ...(legacyUnitCost !== undefined ? { unitCost: legacyUnitCost } : {}),
        ...(legacyPackSize !== undefined ? { packSize: legacyPackSize } : {}),
        ...(legacyPackCost !== undefined ? { packCost: legacyPackCost } : {}),
        // 1f shape — server infers dimension from purchaseUnit.
        purchaseAmount: qtyInPrimaryUnits,
        purchaseUnit: l.unit,
        ...(priceNum !== undefined ? { purchasePrice: priceNum } : {}),
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
              onChange={handleVendorChange}
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
            const isFreeform = filled && !l.itemId;
            // Live $/canonical preview. Renders below the price input so the
            // user sees what the receipt will store as the comparable price
            // (e.g. "$0.039/fl oz" for a gallon of milk at $4.99).
            const amountForPreview = Number(l.amount);
            const priceForPreview = l.price.trim() ? parseCurrency(l.price) : NaN;
            const canonical =
              Number.isFinite(amountForPreview) && amountForPreview > 0 &&
              Number.isFinite(priceForPreview) && priceForPreview >= 0
                ? pricePerCanonical(priceForPreview, amountForPreview, l.unit)
                : null;
            const lineDimension = dimensionForUnit(l.unit) ?? "count";
            // 1h.1d: pack-mode toggle is always available on filled lines so
            // a one-off pack purchase ("normally buy by unit but grabbed a
            // box of 10 this time") can be recorded. When the active vendor
            // has packSize on file we use it; otherwise the user types a
            // size for THIS purchase and it gets persisted onto the vendor
            // pricing row at receive time.
            const lineVendorPricing = l.itemId && vendor.trim()
              ? vendorPricing.get(l.itemId)?.get(vendor.trim().toLowerCase())
              : undefined;
            const vendorPackSize = Number(lineVendorPricing?.packSize ?? 0);
            const draftPackSize = Number(l.packSizeDraft);
            const effectivePackSize = vendorPackSize > 0
              ? vendorPackSize
              : (Number.isFinite(draftPackSize) && draftPackSize > 0 ? draftPackSize : 0);
            const lineIsPackMode = l.mode === "pack";
            const linePackLabelSingular = lineVendorPricing?.packLabel || "pack";
            const linePackLabelPlural = lineVendorPricing?.packLabel
              ? lineVendorPricing.packLabel + "s"
              : "packs";
            const lineAmountLabel = lineIsPackMode
              ? (Number(l.amount) === 1 ? linePackLabelSingular : linePackLabelPlural)
              : l.unit;
            return (
              <div className="usage-entry compose-order-line" key={idx}>
                <div className="usage-entry-main compose-order-line-main">
                  <div className="usage-entry-item">
                    <label className="field-label" htmlFor={`manual-order-item-${idx}`}>Item</label>
                    {/* 1h.3: gating items behind a vendor pick avoids the
                     *  pre-fill ambiguity from the legacy single-vendor
                     *  world — without an active vendor, we have no row to
                     *  pull pricing/URL/pack from, so the picker would
                     *  silently produce a blank line. Forcing the vendor
                     *  first means every line opens with the right context. */}
                    <OrderItemAutocomplete
                      inputId={`manual-order-item-${idx}`}
                      inventoryRows={inventoryRows}
                      excludeNames={alreadyInCartNames}
                      value={filled ? l.itemName : undefined}
                      isFreeform={isFreeform}
                      onPickExisting={(id, name) => pickExistingForLine(idx, id, name)}
                      onPickFreeform={(name) => pickFreeformForLine(idx, name)}
                      onClear={() => clearLineItem(idx)}
                      disabled={submitting || !vendor.trim()}
                      placeholder={
                        vendor.trim()
                          ? "Search items or type a new name"
                          : "Pick a vendor first"
                      }
                    />
                  </div>
                  {(filled || lines.length > 1) && (
                    <button
                      type="button"
                      className="usage-remove-line-btn"
                      onClick={() => removeLine(idx)}
                      disabled={submitting}
                      aria-label="Remove line"
                      title="Remove this line"
                    >
                      {/* Trash icon (not X) so this reads as "delete row"
                       *  next to the autocomplete's own X (which means
                       *  "clear the item, keep the row"). Two distinct
                       *  glyphs, two distinct outcomes. */}
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                {/* Pricing + URL surface inline once a line has an item picked.
                 *  Existing items render the unit as a read-only label (it's
                 *  set on the inventory row's `unit` column). Freeform items
                 *  show a unit dropdown so the user picks the tracking unit
                 *  inline — that becomes the row's `unit` value on receive. */}
                {filled ? (
                  <div className="manual-order-line-details">
                    {/* 1h.8: Order As is just the Single|Pack toggle now.
                     *  The "ct per pack N" affordance moved to the right
                     *  of the Amount stepper as secondary info — it
                     *  describes what's IN one pack, which reads more
                     *  naturally next to "1 pack" than tucked into the
                     *  mode toggle column. */}
                    <div className="manual-order-detail-field">
                      <label className="field-label">Order as</label>
                      <div className="reorder-price-mode" role="tablist" aria-label="Order mode">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={!lineIsPackMode}
                          className={`reorder-price-mode-btn${!lineIsPackMode ? " active" : ""}`}
                          onClick={() => updateLine(idx, { mode: "single", amount: "1" })}
                          disabled={submitting}
                        >
                          Single
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={lineIsPackMode}
                          className={`reorder-price-mode-btn${lineIsPackMode ? " active" : ""}`}
                          onClick={() => updateLine(idx, { mode: "pack", amount: "1" })}
                          disabled={submitting}
                          title={effectivePackSize > 0
                            ? `1 ${linePackLabelSingular} = ${effectivePackSize} ${l.unit}`
                            : `Pack purchase — type the pack size below`}
                        >
                          {effectivePackSize > 0
                            ? `${linePackLabelSingular} (${effectivePackSize})`
                            : "Pack"}
                        </button>
                      </div>
                    </div>
                    {/* Amount + unit. Count items get a QtyStepper; everything
                     *  else gets a decimal input (you don't step grams). */}
                    <div className="manual-order-detail-field">
                      <label className="field-label" htmlFor={`manual-order-amount-${idx}`}>Amount</label>
                      <div className="manual-order-amount-row">
                        {lineDimension === "count" || lineIsPackMode ? (
                          <QtyStepper
                            inputId={`manual-order-amount-${idx}`}
                            value={l.amount}
                            min={1}
                            onChange={(v) => updateLine(idx, { amount: v })}
                            disabled={submitting}
                          />
                        ) : (
                          <input
                            id={`manual-order-amount-${idx}`}
                            className="field manual-order-amount-input"
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            placeholder="0"
                            value={l.amount}
                            onChange={(e) => updateLine(idx, { amount: e.target.value })}
                            onFocus={(e) => e.currentTarget.select()}
                            disabled={submitting}
                          />
                        )}
                        {isFreeform ? (
                          // KNOWN_UNITS feeds the autocomplete suggestions;
                          // the user can type anything (sleeve, case, etc.)
                          // The per-org `allowedUnits` curation list was
                          // retired in favor of always-on autocomplete.
                          <UnitCombobox
                            id={`order-line-${idx}`}
                            className="field manual-order-unit-select"
                            ariaLabel="Unit"
                            value={l.unit}
                            onChange={(v) => updateLine(idx, { unit: v })}
                            options={KNOWN_UNITS}
                            disabled={submitting}
                          />
                        ) : (
                          <span className="manual-order-unit-label" aria-label="Unit">
                            {lineAmountLabel}
                          </span>
                        )}
                        {/* 1h.8: secondary pack-size info, sits to the
                         *  right of the qty stepper. Reads as
                         *  "× 100 ct each" when the vendor has a known
                         *  pack size; becomes an editable "[N] ct each"
                         *  input when the vendor row has no packSize on
                         *  file. Only renders in Pack mode. */}
                        {lineIsPackMode && effectivePackSize > 0 && vendorPackSize > 0 ? (
                          <span className="manual-order-pack-secondary">
                            × {effectivePackSize} {l.unit} each
                          </span>
                        ) : null}
                        {lineIsPackMode && vendorPackSize === 0 ? (
                          <label className="manual-order-pack-secondary manual-order-pack-secondary--editable">
                            <span className="manual-order-pack-secondary-x">×</span>
                            <input
                              className="field manual-order-pack-size-input"
                              type="number"
                              min="1"
                              placeholder="N"
                              aria-label={`${l.unit} per ${linePackLabelSingular}`}
                              value={l.packSizeDraft}
                              onChange={(e) => updateLine(idx, { packSizeDraft: e.target.value })}
                              onFocus={(e) => e.currentTarget.select()}
                              disabled={submitting}
                            />
                            <span>{l.unit} each</span>
                          </label>
                        ) : null}
                      </div>
                    </div>

                    <div className="manual-order-detail-field">
                      <label className="field-label" htmlFor={`manual-order-price-${idx}`}>Price</label>
                      <input
                        id={`manual-order-price-${idx}`}
                        className="field"
                        type="text"
                        inputMode="decimal"
                        placeholder="$0.00"
                        value={l.price}
                        onChange={(e) => updateLine(idx, { price: e.target.value })}
                        onBlur={(e) => {
                          const raw = e.currentTarget.value.trim();
                          if (!raw) return;
                          const parsed = parseCurrency(raw);
                          if (Number.isFinite(parsed) && parsed >= 0) {
                            updateLine(idx, { price: formatCurrency(parsed) });
                          }
                        }}
                        disabled={submitting}
                      />
                      {canonical ? (
                        <span className="manual-order-price-preview">
                          {`${formatCurrency(canonical.pricePerCanonical)}/${canonical.canonicalUnit}`}
                        </span>
                      ) : null}
                    </div>

                    {isFreeform ? (
                      <div className="manual-order-detail-field">
                        <label className="field-label" htmlFor={`manual-order-min-${idx}`}>Min on hand</label>
                        <input
                          id={`manual-order-min-${idx}`}
                          className="field"
                          type="number"
                          min="0"
                          step="any"
                          placeholder={`Reorder when below (${l.unit})`}
                          value={l.minQuantity}
                          onChange={(e) => updateLine(idx, { minQuantity: e.target.value })}
                          onFocus={(e) => e.currentTarget.select()}
                          disabled={submitting}
                        />
                      </div>
                    ) : null}

                    {/* Reorder URL stays gated behind a button when empty so
                     *  the line stays compact. Pre-filled URLs auto-expand. */}
                    <div className="manual-order-detail-field manual-order-detail-field--wide">
                      {l.urlOpen ? (
                        <>
                          <label className="field-label" htmlFor={`manual-order-url-${idx}`}>Reorder URL</label>
                          <div className="manual-order-url-row">
                            <input
                              id={`manual-order-url-${idx}`}
                              className="field"
                              type="text"
                              placeholder="https://..."
                              value={l.productUrl}
                              onChange={(e) => updateLine(idx, { productUrl: e.target.value })}
                              disabled={submitting}
                            />
                            <button
                              type="button"
                              className="usage-remove-line-btn"
                              onClick={() => updateLine(idx, { productUrl: "", urlOpen: false })}
                              disabled={submitting}
                              aria-label="Remove reorder URL"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary button-sm manual-order-add-url"
                          onClick={() => updateLine(idx, { urlOpen: true })}
                          disabled={submitting}
                        >
                          <Plus size={14} /> Reorder URL
                        </button>
                      )}
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

export function OrdersPage({ selectedLocationId }: OrdersPageProps) {
  const [orders, setOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [hasExpirationColumn, setHasExpirationColumn] = useState(false);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [registeredVendors, setRegisteredVendors] = useState<string[]>([]);
  // 1g.6: per-(item, vendor) pricing rows. New Order pre-fills from
  // vendorPricing[itemId][selectedVendor] when both are known. Receive
  // form pre-fills from vendorPricing[itemId][order.vendor]. Falls back to
  // legacy row.values.* fields when no entry exists yet (transitional).
  const [vendorPricing, setVendorPricing] = useState<Map<string, Map<string, ItemVendorPricingEntry>>>(new Map());
  // 1h.2c: per-org curated unit list, used by the freeform unit picker on
  // New Order. Empty fallback uses the master KNOWN_UNITS list.
  const [allowedUnits, setAllowedUnits] = useState<string[]>([]);
  // 1h.7: org-wide UoM gate. Forwarded to the i modal so EMS-style orgs
  // see the simple form and pantry orgs see the dual-axis Pack form.
  const [tracksUnits, setTracksUnits] = useState<boolean>(false);
  // Item-detail modal state (mirrors InventoryPage). Opened from Shop's
  // All-Vendors mode when the user clicks an item name → manage vendor
  // pricing without bouncing to Inventory.
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const detailItem = detailItemId
    ? inventoryRows.find((r) => r.id === detailItemId) ?? null
    : null;
  const detailItemPricing: ItemVendorPricingEntry[] = detailItemId
    ? Array.from(vendorPricing.get(detailItemId)?.values() ?? [])
    : [];
  // Patch a single (item, vendor) pricing row into the in-memory map so the
  // Shop list and any open Receive form pick up the change without a full
  // bootstrap reload. Mirrors the InventoryPage handlers.
  const handlePricingUpserted = (entry: ItemVendorPricingEntry) => {
    setVendorPricing((prev) => {
      const next = new Map(prev);
      const inner = new Map(next.get(entry.itemId) ?? new Map());
      inner.set(entry.vendorLower, entry);
      next.set(entry.itemId, inner);
      return next;
    });
  };
  const handlePricingDeleted = (id: string) => {
    setVendorPricing((prev) => {
      const next = new Map(prev);
      // Walk the maps to find the (itemId, vendorLower) for this row id —
      // the id format isn't trusted here so a future schema change doesn't
      // silently break delete state sync.
      for (const [itemId, inner] of next.entries()) {
        for (const [vendorLower, entry] of inner.entries()) {
          if (entry.id === id) {
            const updated = new Map(inner);
            updated.delete(vendorLower);
            if (updated.size === 0) next.delete(itemId);
            else next.set(itemId, updated);
            return next;
          }
        }
      }
      return next;
    });
  };
  const inventoryRowsRef = useRef<InventoryRow[]>([]);

  // Sorted location list. Replaces the previous merged-from-row-values
  // derivation — locations are first-class entities post-restructure.
  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
    ),
    [locations],
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
    loadInventoryBootstrap().then(({ columns, items, locations: locs, registeredVendors: vendors, vendorPricing: vp, allowedUnits: au, tracksUnits: tu }) => {
      setInventoryRows(items);
      inventoryRowsRef.current = items;
      setHasExpirationColumn(columns.some((c) => c.key === "expirationDate" && c.isVisible));
      setLocations(Array.isArray(locs) ? locs : []);
      setRegisteredVendors(Array.isArray(vendors) ? vendors : []);
      setAllowedUnits(Array.isArray(au) ? au : []);
      setTracksUnits(typeof tu === "boolean" ? tu : false);
      // 1g.6: index per-(item, vendor) pricing for fast read in New Order
      // line pre-fill + Receive form pre-fill. Map<itemId, Map<vendorLower,
      // entry>> matches the shape useInventoryData uses on the inventory
      // page so logic that walks the map can be shared.
      const map = new Map<string, Map<string, ItemVendorPricingEntry>>();
      for (const entry of vp ?? []) {
        const inner = map.get(entry.itemId) ?? new Map<string, ItemVendorPricingEntry>();
        inner.set(entry.vendorLower, entry);
        map.set(entry.itemId, inner);
      }
      setVendorPricing(map);
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
            // 1d: forward amount/UoM/price/dimension when the Shop tab supplied
            // them. Server re-derives pricePerCanonical via uom.ts.
            ...(item.purchaseAmount !== undefined ? { purchaseAmount: item.purchaseAmount } : {}),
            ...(item.purchaseUnit ? { purchaseUnit: item.purchaseUnit } : {}),
            ...(item.purchasePrice !== undefined ? { purchasePrice: item.purchasePrice } : {}),
            ...(item.dimension ? { dimension: item.dimension } : {}),
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
  // Hide synthetic price-history backfill orders from Closed Orders display.
  // They're real records (price-history endpoint reads them as time-series)
  // but the user didn't actually place them — showing them clutters the
  // Closed Orders feed with one row per item. createdByUserId === "system"
  // is the signal: 1e seed sets it explicitly to mark these as auto-generated.
  const closedOrders = orders.filter(
    (o) => o.status === "closed" && o.createdByUserId !== "system",
  );

  // Top-level tab. Mirrors Inventory's chip pattern: only one section is shown
  // at a time so each gets the full vertical space. Default lands on Reorder
  // since that's the most-used workflow entry point.
  type OrdersTab = "shop" | "new" | "pending" | "closed";
  // 1e: Reorder retired in favor of Shop (vendor-aware shopping list with
  // best-price comparison from receipt history). The ReorderTab module
  // stays in tree as `./ReorderTab` since OrderItem + VendorSelect still
  // export from there; reverting is "re-add the tab button + render".
  const [activeTab, setActiveTab] = useState<OrdersTab>("shop");
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
      ...(l.unitCost !== undefined ? { unitCost: l.unitCost } : {}),
      ...(l.packSize !== undefined ? { packSize: l.packSize } : {}),
      ...(l.packCost !== undefined ? { packCost: l.packCost } : {}),
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

  // Closed-orders filter state: free-text search (vendor / notes / item names)
  // plus optional date range on createdAt.
  const [closedSearch, setClosedSearch] = useState("");
  const [closedFromDate, setClosedFromDate] = useState("");
  // Pagination for Closed Orders. Synthesized backfill orders are already
  // filtered out, but a real org with months of receipts can still build up
  // hundreds of rows — paginate so the day-grouped list doesn't render
  // them all at once.
  const CLOSED_ORDERS_PAGE_SIZE = 25;
  const [closedOrdersPage, setClosedOrdersPage] = useState(1);
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
  // Reset to page 1 when the filtered set shrinks below the current page's
  // start — otherwise applying a search would leave the view "blank past
  // page 1" until the user clicked back.
  const closedOrdersTotalPages = Math.max(
    1,
    Math.ceil(filteredClosedOrders.length / CLOSED_ORDERS_PAGE_SIZE),
  );
  const closedOrdersSafePage = Math.min(closedOrdersPage, closedOrdersTotalPages);
  useEffect(() => {
    if (closedOrdersPage > closedOrdersTotalPages) {
      setClosedOrdersPage(1);
    }
  }, [closedOrdersTotalPages, closedOrdersPage]);

  const closedOrdersByDay = useMemo(() => {
    const start = (closedOrdersSafePage - 1) * CLOSED_ORDERS_PAGE_SIZE;
    const slice = filteredClosedOrders.slice(start, start + CLOSED_ORDERS_PAGE_SIZE);
    type Bucket = { label: string; orders: RestockOrder[] };
    const days: Bucket[] = [];
    for (const order of slice) {
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
  }, [filteredClosedOrders, closedOrdersSafePage]);

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
                aria-selected={activeTab === "shop"}
                className={`audit-tab${activeTab === "shop" ? " active" : ""}`}
                onClick={() => setActiveTab("shop")}
              >
                <ShoppingCart size={16} /> Reorder
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

            {/* Shop is the 1d vendor-aware list. Mounted only when active
             *  (no count badge to keep alive across tab switches). */}
            {inventoryLoaded && activeTab === "shop" && (
              <ShoppingListTab
                rows={inventoryRows}
                availableVendors={vendorValues}
                vendorPricing={vendorPricing}
                onMarkOrdered={handleMarkOrdered}
                onOpenItemDetails={setDetailItemId}
              />
            )}

            {activeTab === "new" && (
              <ComposeOrderPanel
                inventoryRows={inventoryRows}
                availableVendors={vendorValues}
                onAddVendor={handleAddVendor}
                onSubmit={handleSubmitComposeOrder}
                vendorPricing={vendorPricing}
                allowedUnits={allowedUnits}
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
                      vendorPricing={vendorPricing}
                      onRefresh={handleOrderChanged}
                      onOpenItemDetails={setDetailItemId}
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
                      <>
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
                                    vendorPricing={vendorPricing}
                                    onRefresh={handleOrderChanged}
                                    onOpenItemDetails={setDetailItemId}
                                  />
                                ))}
                              </div>
                            </DaySection>
                          ))}
                        </div>
                        {closedOrdersTotalPages > 1 && (
                          <PaginationControls
                            currentPage={closedOrdersSafePage}
                            totalPages={closedOrdersTotalPages}
                            totalItems={filteredClosedOrders.length}
                            pageSize={CLOSED_ORDERS_PAGE_SIZE}
                            onPageChange={setClosedOrdersPage}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 1h.3: per-item vendor-pricing manager. Opened from Shop's
       *  All-Vendors mode (item name click) so users can curate pricing
       *  without bouncing to Inventory. */}
      {detailItemId && detailItem ? (
        <ItemDetailModal
          itemId={detailItemId}
          itemName={String(detailItem.values.itemName ?? "").trim() || `Item ${detailItemId.slice(0, 8)}`}
          pricing={detailItemPricing}
          availableVendors={vendorValues}
          allowedUnits={allowedUnits}
          tracksUnits={tracksUnits}
          onClose={() => setDetailItemId(null)}
          onPricingUpserted={handlePricingUpserted}
          onPricingDeleted={handlePricingDeleted}
          onAddVendor={handleAddVendor}
        />
      ) : null}
    </section>
  );
}
