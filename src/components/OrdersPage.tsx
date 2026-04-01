import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  PackageCheck,
  PackagePlus,
  Plus,
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
import { QuickAddPage } from "./QuickAddPage";
import { ReorderTab, type PlaceOrderItem } from "./ReorderTab";

type OrdersTab = "main" | "quickadd";

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

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount);
}

function orderTotalCost(items: RestockOrderItem[]): number | null {
  const itemsWithCost = items.filter((i) => i.unitCost !== undefined);
  if (itemsWithCost.length === 0) return null;
  return itemsWithCost.reduce((sum, i) => sum + (i.unitCost ?? 0) * i.qtyOrdered, 0);
}

function StatusBadge({ status }: { status: RestockOrder["status"] }) {
  const map = {
    open: { label: "Open", className: "order-status-badge order-status-badge--open" },
    partial: { label: "Partial", className: "order-status-badge order-status-badge--partial" },
    closed: { label: "Closed", className: "order-status-badge order-status-badge--closed" },
  };
  const { label, className } = map[status];
  return <span className={className}>{label}</span>;
}

// ── Create Order Form ──────────────────────────────────────────────────────

type CreateOrderLine = {
  id: string;
  itemId: string;       // "" for freeform items
  itemSearch: string;
  isFreeform: boolean;
  qtyOrdered: string;
  unitCost: string;
  error: string;
};

function CreateOrderForm({
  rows,
  initialVendor,
  initialItems,
  onCreated,
  onCancel,
}: {
  rows: InventoryRow[];
  initialVendor?: string;
  initialItems?: PlaceOrderItem[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const getItemName = (row: InventoryRow) =>
    String(row.values.itemName ?? "").trim() || `Item ${row.id.slice(0, 8)}`;

  function newLine(): CreateOrderLine {
    return { id: crypto.randomUUID(), itemId: "", itemSearch: "", isFreeform: false, qtyOrdered: "", unitCost: "", error: "" };
  }

  const [vendor, setVendor] = useState(initialVendor ?? "");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<CreateOrderLine[]>(
    initialItems?.length
      ? initialItems.map((r) => ({
          id: crypto.randomUUID(),
          itemId: r.itemId,
          itemSearch: r.itemName,
          isFreeform: false,
          qtyOrdered: String(r.suggestedQty),
          unitCost: "",
          error: "",
        }))
      : [newLine()],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredOptions = (search: string) => {
    const q = search.toLowerCase();
    return rows.filter((r) => getItemName(r).toLowerCase().includes(q)).slice(0, 8);
  };

  const updateLine = (id: string, patch: Partial<CreateOrderLine>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const selectItem = (lineId: string, row: InventoryRow) =>
    updateLine(lineId, { itemId: row.id, itemSearch: getItemName(row), isFreeform: false, error: "" });

  const selectFreeform = (lineId: string, name: string) =>
    updateLine(lineId, { itemId: "", itemSearch: name, isFreeform: true, error: "" });

  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));

  const handleSubmit = async () => {
    let hasError = false;
    const validated = lines.map((l) => {
      if (!l.itemId && !l.isFreeform) { hasError = true; return { ...l, error: "Select an item" }; }
      if (l.isFreeform && !l.itemSearch.trim()) { hasError = true; return { ...l, error: "Enter item name" }; }
      const qty = Number(l.qtyOrdered);
      if (!Number.isFinite(qty) || qty <= 0) { hasError = true; return { ...l, error: "Enter a valid qty" }; }
      const cost = l.unitCost.trim() ? Number(l.unitCost) : undefined;
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) { hasError = true; return { ...l, error: "Invalid cost" }; }
      return { ...l, error: "" };
    });
    setLines(validated);
    if (hasError) return;

    setSubmitting(true);
    setError(null);
    try {
      await createRestockOrder({
        vendor: vendor.trim() || undefined,
        notes: notes.trim() || undefined,
        items: validated.map((l) => ({
          ...(l.isFreeform ? {} : { itemId: l.itemId }),
          itemName: l.isFreeform ? l.itemSearch.trim() : getItemName(rows.find((r) => r.id === l.itemId)!),
          qtyOrdered: Number(l.qtyOrdered),
          ...(l.unitCost.trim() ? { unitCost: Number(l.unitCost) } : {}),
        })),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create order.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="order-form-card">
      <div className="order-form-header">
        <h3 className="order-form-title">New Restock Order</h3>
        <button type="button" className="button button-ghost button-sm" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <div className="order-form-meta">
        <div className="order-form-field">
          <label className="order-form-label">Vendor</label>
          <input
            className="field"
            placeholder="e.g. Bound Tree Medical"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
        </div>
        <div className="order-form-field">
          <label className="order-form-label">Notes</label>
          <input
            className="field"
            placeholder="Optional notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="order-form-items">
        <div className="order-form-items-header">
          <span>Item</span>
          <span>Qty to Order</span>
          <span>Unit Cost</span>
          <span />
        </div>
        {lines.map((line) => (
          <div key={line.id} className="order-form-item-row">
            <div className="order-form-item-search">
              {line.isFreeform ? (
                <div className="order-form-freeform">
                  <input
                    className="field"
                    placeholder="Item name"
                    value={line.itemSearch}
                    onChange={(e) => updateLine(line.id, { itemSearch: e.target.value, error: "" })}
                  />
                  <span className="order-form-freeform-badge">New item</span>
                </div>
              ) : (
                <>
                  <input
                    className={`field${line.error && !line.itemId ? " field--error" : ""}`}
                    placeholder="Search inventory..."
                    value={line.itemSearch}
                    onChange={(e) => updateLine(line.id, { itemSearch: e.target.value, itemId: "", error: "" })}
                  />
                  {line.itemSearch && !line.itemId && (
                    <div className="order-item-dropdown">
                      {filteredOptions(line.itemSearch).map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          className="order-item-option"
                          onClick={() => selectItem(line.id, r)}
                        >
                          {getItemName(r)}
                          <span className="order-item-option-qty">Qty: {String(r.values.quantity ?? 0)}</span>
                        </button>
                      ))}
                      {line.itemSearch.trim() && (
                        <button
                          type="button"
                          className="order-item-option order-item-option--new"
                          onClick={() => selectFreeform(line.id, line.itemSearch.trim())}
                        >
                          <Plus size={12} /> Add "{line.itemSearch.trim()}" as new item
                        </button>
                      )}
                      {filteredOptions(line.itemSearch).length === 0 && !line.itemSearch.trim() && (
                        <div className="order-item-option order-item-option--empty">No items found</div>
                      )}
                    </div>
                  )}
                </>
              )}
              {line.error && <span className="order-form-line-error">{line.error}</span>}
            </div>
            <input
              className="field"
              type="number"
              min="1"
              placeholder="Qty"
              value={line.qtyOrdered}
              onChange={(e) => updateLine(line.id, { qtyOrdered: e.target.value })}
            />
            <input
              className="field"
              type="number"
              min="0"
              step="0.01"
              placeholder="$0.00"
              value={line.unitCost}
              onChange={(e) => updateLine(line.id, { unitCost: e.target.value })}
            />
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => removeLine(line.id)}
              disabled={lines.length === 1}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button-ghost button-sm order-add-line-btn"
          onClick={() => setLines((prev) => [...prev, newLine()])}
        >
          <Plus size={14} /> Add item
        </button>
      </div>

      {error && <p className="order-form-error">{error}</p>}

      <div className="order-form-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? <Loader2 size={14} className="spin" /> : <PackagePlus size={14} />}
          Place Order
        </button>
      </div>
    </div>
  );
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
  error: string;
};

function ReceiveOrderForm({
  order,
  hasExpirationColumn,
  onReceived,
  onCancel,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  onReceived: () => void;
  onCancel: () => void;
}) {
  const pendingItems = order.items.filter((i) => i.qtyReceived < i.qtyOrdered);
  const [lines, setLines] = useState<ReceiveLine[]>(
    pendingItems.map((i) => {
      const freeform = i.itemId.startsWith("freeform-");
      return {
        itemId: i.itemId,
        itemName: i.itemName,
        isFreeform: freeform,
        qtyOrdered: i.qtyOrdered,
        qtyReceived: i.qtyReceived,
        qtyRemaining: i.qtyOrdered - i.qtyReceived,
        qtyThisReceive: String(i.qtyOrdered - i.qtyReceived),
        expirationDate: "",
        unitCost: i.unitCost !== undefined ? String(i.unitCost) : "",
        addToInventory: freeform,  // default to save for freeform items
        error: "",
      };
    }),
  );
  const [closeOrder, setCloseOrder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateLine = (itemId: string, patch: Partial<ReceiveLine>) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, ...patch } : l)));

  const handleSubmit = async () => {
    let hasError = false;
    const validated = lines.map((l) => {
      const qty = Number(l.qtyThisReceive);
      if (!Number.isFinite(qty) || qty <= 0) {
        hasError = true;
        return { ...l, error: "Enter a valid qty" };
      }
      if (hasExpirationColumn && !l.isFreeform && !l.expirationDate) {
        hasError = true;
        return { ...l, error: "Expiration date required" };
      }
      if (l.isFreeform && l.addToInventory && hasExpirationColumn && !l.expirationDate) {
        hasError = true;
        return { ...l, error: "Expiration date required" };
      }
      const cost = l.unitCost.trim() ? Number(l.unitCost) : undefined;
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
        hasError = true;
        return { ...l, error: "Invalid cost" };
      }
      return { ...l, error: "" };
    });
    setLines(validated);
    if (hasError) return;

    setSubmitting(true);
    setError(null);
    try {
      const receiveLines: RestockReceiveLine[] = validated.map((l) => ({
        itemId: l.itemId,
        qtyThisReceive: Number(l.qtyThisReceive),
        ...(l.expirationDate ? { expirationDate: l.expirationDate } : {}),
        ...(l.unitCost.trim() ? { unitCost: Number(l.unitCost) } : {}),
        ...(l.isFreeform ? { addToInventory: l.addToInventory } : {}),
      }));
      await receiveRestockOrder(order.id, { lines: receiveLines, closeOrder });
      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to receive order.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="order-form-card">
      <div className="order-form-header">
        <h3 className="order-form-title">
          Receive Items
          {order.vendor && <span className="order-form-vendor"> — {order.vendor}</span>}
        </h3>
        <button type="button" className="button button-ghost button-sm" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <div className="order-receive-items">
        <div className="order-receive-header">
          <span>Item</span>
          <span>Ordered / Received</span>
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
              {line.error && <span className="order-form-line-error">{line.error}</span>}
            </div>
            <div className="order-receive-progress">
              <span>{line.qtyOrdered}</span>
              <span className="order-receive-progress-sep">/</span>
              <span className="order-receive-received">{line.qtyReceived}</span>
              <span className="order-receive-remaining"> ({line.qtyRemaining} remaining)</span>
            </div>
            <input
              className="field"
              type="number"
              min="1"
              max={line.qtyRemaining}
              value={line.qtyThisReceive}
              onChange={(e) => updateLine(line.itemId, { qtyThisReceive: e.target.value, error: "" })}
            />
            {hasExpirationColumn && (
              <input
                className={`field${line.error && !line.expirationDate ? " field--error" : ""}`}
                type="date"
                value={line.expirationDate}
                onChange={(e) => updateLine(line.itemId, { expirationDate: e.target.value, error: "" })}
              />
            )}
            <input
              className="field"
              type="number"
              min="0"
              step="0.01"
              placeholder="$0.00"
              value={line.unitCost}
              onChange={(e) => updateLine(line.itemId, { unitCost: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="order-receive-close-option">
        <label className="order-receive-close-label">
          <input
            type="checkbox"
            checked={closeOrder}
            onChange={(e) => setCloseOrder(e.target.checked)}
          />
          Close order after receiving (even if items are still outstanding)
        </label>
      </div>

      {error && <p className="order-form-error">{error}</p>}

      <div className="order-form-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? <Loader2 size={14} className="spin" /> : <PackageCheck size={14} />}
          Confirm Receipt
        </button>
      </div>
    </div>
  );
}

// ── Order Card ─────────────────────────────────────────────────────────────

function OrderCard({
  order,
  hasExpirationColumn,
  onRefresh,
}: {
  order: RestockOrder;
  hasExpirationColumn: boolean;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [closing, setClosing] = useState(false);

  const total = orderTotalCost(order.items);
  const totalReceived = order.items.reduce((s, i) => s + i.qtyReceived, 0);
  const totalOrdered = order.items.reduce((s, i) => s + i.qtyOrdered, 0);

  const handleClose = async () => {
    if (!confirm("Close this order without fully receiving all items?")) return;
    setClosing(true);
    try {
      await closeRestockOrder(order.id);
      onRefresh();
    } catch { /* ignore */ } finally {
      setClosing(false);
    }
  };

  if (showReceive) {
    return (
      <ReceiveOrderForm
        order={order}
        hasExpirationColumn={hasExpirationColumn}
        onReceived={() => { setShowReceive(false); onRefresh(); }}
        onCancel={() => setShowReceive(false)}
      />
    );
  }

  return (
    <div className={`order-card order-card--${order.status}`}>
      <div className="order-card-main">
        <div className="order-card-top">
          <div className="order-card-identity">
            <StatusBadge status={order.status} />
            <span className="order-card-vendor">{order.vendor || "No vendor"}</span>
            <span className="order-card-date">{formatDate(order.createdAt)}</span>
          </div>
          <div className="order-card-summary">
            <span className="order-card-items-count">{order.items.length} item{order.items.length !== 1 ? "s" : ""}</span>
            <span className="order-card-progress">{totalReceived}/{totalOrdered} received</span>
            {total !== null && <span className="order-card-cost">{formatCurrency(total)}</span>}
          </div>
          <div className="order-card-actions">
            {order.status !== "closed" && (
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
                  onClick={handleClose}
                  disabled={closing}
                  title="Close order"
                >
                  {closing ? <Loader2 size={13} className="spin" /> : <X size={13} />}
                </button>
              </>
            )}
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {order.notes && <p className="order-card-notes">{order.notes}</p>}
        <p className="order-card-by">Ordered by {order.createdByName}</p>
      </div>

      {expanded && (
        <div className="order-card-detail">
          <table className="order-detail-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Ordered</th>
                <th>Received</th>
                <th>Unit Cost</th>
                <th>Line Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.itemId} className={item.qtyReceived >= item.qtyOrdered ? "order-detail-row--done" : ""}>
                  <td>
                    {item.itemName}
                    {item.itemId.startsWith("freeform-") && (
                      <span className="order-freeform-badge">new</span>
                    )}
                  </td>
                  <td>{item.qtyOrdered}</td>
                  <td>{item.qtyReceived}</td>
                  <td>{item.unitCost !== undefined ? formatCurrency(item.unitCost) : "—"}</td>
                  <td>{item.unitCost !== undefined ? formatCurrency(item.unitCost * item.qtyOrdered) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {order.receives.length > 0 && (
            <div className="order-receive-history">
              <h4 className="order-receive-history-title">Receive History</h4>
              {order.receives.map((ev, i) => (
                <div key={i} className="order-receive-history-event">
                  <span className="order-receive-history-meta">
                    {formatDate(ev.receivedAt)} by {ev.receivedByName}
                    {ev.closedOrder && <span className="order-receive-history-closed"> · closed order</span>}
                  </span>
                  <div className="order-receive-history-lines">
                    {ev.lines.map((l, j) => {
                      const item = order.items.find((oi) => oi.itemId === l.itemId);
                      return (
                        <span key={j} className="audit-change-chip">
                          {item?.itemName ?? l.itemId}: +{l.qtyThisReceive}
                          {l.expirationDate && ` · Exp: ${new Date(l.expirationDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
                          {l.unitCost !== undefined && ` · ${formatCurrency(l.unitCost)}/ea`}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Orders Page ───────────────────────────────────────────────────────

export function OrdersPage({ selectedLocation }: OrdersPageProps) {
  const [tab, setTab] = useState<OrdersTab>("main");
  const [orders, setOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialVendor, setCreateInitialVendor] = useState<string | undefined>();
  const [createInitialItems, setCreateInitialItems] = useState<PlaceOrderItem[] | undefined>();
  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [hasExpirationColumn, setHasExpirationColumn] = useState(false);
  const inventoryRowsRef = useRef<InventoryRow[]>([]);

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
    loadInventoryBootstrap().then(({ columns, items }) => {
      setInventoryRows(items);
      inventoryRowsRef.current = items;
      setHasExpirationColumn(columns.some((c) => c.key === "expirationDate" && c.isVisible));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "main") {
      loadBootstrap();
      loadOrders();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // BroadcastChannel: listen for "mark-ordered" from the vendor checklist popup
  useEffect(() => {
    const channel = new BroadcastChannel("wickops-reorder");
    channel.onmessage = async (event) => {
      if (event.data?.type === "mark-ordered" && Array.isArray(event.data.rowIds)) {
        const orderedIds = new Set<string>(event.data.rowIds);
        const now = new Date().toISOString();
        const current = inventoryRowsRef.current;
        const toSave = current
          .filter((r) => orderedIds.has(r.id))
          .map((r) => ({
            ...r,
            position: current.indexOf(r),
            values: { ...r.values, orderedAt: now },
          }));
        const updated = current.map((r) =>
          orderedIds.has(r.id) ? { ...r, values: { ...r.values, orderedAt: now } } : r,
        );
        setInventoryRows(updated);
        inventoryRowsRef.current = updated;
        if (toSave.length > 0) await saveInventoryItems(toSave, []).catch(() => {});
      }
    };
    return () => channel.close();
  }, []);

  // Reorder callbacks (for ReorderTab orderedAt tracking)
  const handleClearOrderedAt = useCallback(async (rowIds: string[]) => {
    const idSet = new Set(rowIds);
    const current = inventoryRowsRef.current;
    const toSave = current
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...r, position: current.indexOf(r), values: { ...r.values, orderedAt: null } }));
    const updated = current.map((r) =>
      idSet.has(r.id) ? { ...r, values: { ...r.values, orderedAt: null } } : r,
    );
    setInventoryRows(updated);
    inventoryRowsRef.current = updated;
    if (toSave.length > 0) await saveInventoryItems(toSave, []).catch(() => {});
  }, []);

  const handleMarkOrdered = useCallback(async (rowIds: string[]) => {
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
  }, []);

  const handleReorderCheck = useCallback(async (rowId: string, checked: boolean) => {
    const now = new Date().toISOString();
    const current = inventoryRowsRef.current;
    const rowIndex = current.findIndex((r) => r.id === rowId);
    const original = current[rowIndex];
    if (!original) return;
    const updatedRow = { ...original, position: rowIndex, values: { ...original.values, reorderCheckedAt: checked ? now : null } };
    const updated = current.map((r) =>
      r.id === rowId ? { ...r, values: { ...r.values, reorderCheckedAt: checked ? now : null } } : r,
    );
    setInventoryRows(updated);
    inventoryRowsRef.current = updated;
    await saveInventoryItems([updatedRow], []);
  }, []);

  const handlePlaceOrder = useCallback((vendor: string, items: PlaceOrderItem[]) => {
    setCreateInitialVendor(vendor);
    setCreateInitialItems(items);
    setShowCreate(true);
  }, []);

  const openOrders = orders.filter((o) => o.status !== "closed");
  const closedOrders = orders.filter((o) => o.status === "closed");

  return (
    <section className="app-page orders-page">
      <div className="orders-tabs">
        <button
          type="button"
          className={`orders-tab${tab === "main" ? " active" : ""}`}
          onClick={() => setTab("main")}
        >
          <RotateCcw size={15} /> Orders
        </button>
        <button
          type="button"
          className={`orders-tab${tab === "quickadd" ? " active" : ""}`}
          onClick={() => setTab("quickadd")}
        >
          <Plus size={15} /> Quick Add
        </button>
      </div>

      {tab === "main" && (
        <div className="orders-content">
          <div className="orders-toolbar">
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={() => {
                setCreateInitialVendor(undefined);
                setCreateInitialItems(undefined);
                setShowCreate(true);
              }}
              disabled={showCreate}
            >
              <PackagePlus size={14} /> New Order
            </button>
          </div>

          {showCreate && (
            <CreateOrderForm
              rows={inventoryRows}
              initialVendor={createInitialVendor}
              initialItems={createInitialItems}
              onCreated={() => { setShowCreate(false); loadOrders(); }}
              onCancel={() => setShowCreate(false)}
            />
          )}

          {error && <p className="orders-error">{error}</p>}

          {loading && (
            <div className="orders-loading">
              <Loader2 size={20} className="spin" />
            </div>
          )}

          {!loading && openOrders.length > 0 && (
            <div className="orders-section">
              {openOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  hasExpirationColumn={hasExpirationColumn}
                  onRefresh={loadOrders}
                />
              ))}
            </div>
          )}

          <div className="orders-needs-reorder">
            <div className="orders-needs-reorder-header">
              <AlertTriangle size={15} />
              <span>Needs Reorder</span>
            </div>
            <ReorderTab
              rows={inventoryRows}
              onClearOrderedAt={handleClearOrderedAt}
              onMarkOrdered={handleMarkOrdered}
              onReorderCheck={handleReorderCheck}
              onPlaceOrder={handlePlaceOrder}
            />
          </div>

          {closedOrders.length > 0 && (
            <div className="orders-section">
              <div className="orders-section-header">
                <CheckCircle size={14} />
                <span>Closed Orders</span>
              </div>
              {closedOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  hasExpirationColumn={hasExpirationColumn}
                  onRefresh={loadOrders}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "quickadd" && (
        <QuickAddPage selectedLocation={selectedLocation} />
      )}
    </section>
  );
}
