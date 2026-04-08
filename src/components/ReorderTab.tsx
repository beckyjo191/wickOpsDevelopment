import { useMemo, useState } from "react";
import type { InventoryRow } from "../lib/inventoryApi";
import { Check, ExternalLink, Link2Off, Package, PackageCheck, Plus, ShoppingCart, Undo2, X } from "lucide-react";

interface ReorderTabProps {
  rows: InventoryRow[];
  onEditReorderLink?: (rowId: string) => void;
  onClearOrderedAt?: (rowIds: string[]) => void;
  onMarkOrdered?: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
}

export type OrderItem = { rowId: string | null; name: string; qty: number; unitCost?: number };

const isMobile = () => window.innerWidth <= 780;

type ReorderItem = {
  row: InventoryRow;        // representative row (lowest active qty)
  allRowIds: string[];      // all row IDs in this name+location group
  itemName: string;
  reorderLink: string;
  activeQty: number;        // non-expired qty summed across all rows
  expiredQty: number;       // expired qty summed across all rows
  minQuantity: number;
  suggestedQty: number;
  hasExpired: boolean;
  orderedAt: string | null; // most recent orderedAt across all rows
};

type VendorGroup = {
  domain: string;
  items: ReorderItem[];
};

const normalizeLinkValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const getVendorDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const getDaysUntilExpiration = (value: string | number | boolean | null | undefined) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.floor((targetStart - todayStart) / (1000 * 60 * 60 * 24));
};

const openVendorChecklist = (group: VendorGroup) => {
  const data = {
    domain: group.domain,
    items: group.items.map((item) => ({
      rowId: item.row.id,
      allRowIds: item.allRowIds,
      name: item.itemName,
      link: item.reorderLink,
      activeQty: item.activeQty,
      expiredQty: item.expiredQty,
      minQuantity: item.minQuantity,
      suggestedQty: item.suggestedQty,
      hasExpired: item.hasExpired,
    })),
  };
  const storageKey = `wickops-reorder-${group.domain}`;
  sessionStorage.setItem(storageKey, JSON.stringify(data));
  const checklistUrl = `${window.location.origin}/?reorder-checklist=${encodeURIComponent(group.domain)}`;
  window.open(
    checklistUrl,
    `wickops-checklist-${group.domain}`,
    "width=400,height=620,scrollbars=yes,resizable=yes",
  );
};

// ── Mobile Checklist Overlay ─────────────────────────────────────────────────

type MobileLineState = {
  rowId: string;
  allRowIds: string[];
  name: string;
  link: string;
  checked: boolean;
  qty: string;
  unitCost: string;
};
type MobileRawLine = { id: string; name: string; qty: string; unitCost: string };

function MobileChecklist({
  group,
  onClose,
  onPlaceOrder,
}: {
  group: VendorGroup;
  onClose: () => void;
  onPlaceOrder: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
}) {
  const [lines, setLines] = useState<MobileLineState[]>(() =>
    group.items.map((item) => ({
      rowId: item.row.id,
      allRowIds: item.allRowIds,
      name: item.itemName,
      link: item.reorderLink,
      checked: false,
      qty: String(item.suggestedQty),
      unitCost: "",
    })),
  );
  const [rawLines, setRawLines] = useState<MobileRawLine[]>([]);

  const toggleLine = (rowId: string) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: !l.checked } : l)));

  const updateLine = (rowId: string, patch: Partial<MobileLineState>) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, ...patch } : l)));

  const updateRaw = (id: string, patch: Partial<MobileRawLine>) =>
    setRawLines((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleItemClick = (link: string, rowId: string) => {
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: true } : l)));
    window.open(link, `wickops-vendor-${group.domain}`);
  };

  const checkedCount =
    lines.filter((l) => l.checked).length +
    rawLines.filter((r) => r.name.trim() && Number(r.qty) > 0).length;

  const handlePlaceOrder = () => {
    const inventoryItems = lines
      .filter((l) => l.checked)
      .map((l) => ({
        rowId: l.rowId,
        name: l.name,
        qty: Math.max(1, Number(l.qty) || 1),
        ...(l.unitCost.trim() ? { unitCost: Number(l.unitCost) } : {}),
      }));
    const freeformItems = rawLines
      .filter((r) => r.name.trim() && Number(r.qty) > 0)
      .map((r) => ({
        rowId: null as string | null,
        name: r.name.trim(),
        qty: Number(r.qty),
        ...(r.unitCost.trim() ? { unitCost: Number(r.unitCost) } : {}),
      }));
    // Use allRowIds so every lot in the group gets stamped as ordered
    const checkedRowIds = lines.filter((l) => l.checked).flatMap((l) => l.allRowIds);
    onPlaceOrder(checkedRowIds, group.domain, [...inventoryItems, ...freeformItems]);
    onClose();
  };

  return (
    <div className="reorder-mobile-overlay">
      <div className="reorder-mobile-checklist">
        <div className="reorder-mobile-checklist-header">
          <div>
            <h4 className="reorder-mobile-checklist-title">{group.domain}</h4>
            <p className="reorder-mobile-checklist-subtitle">
              {lines.filter((l) => l.checked).length}/{lines.length} items checked
            </p>
          </div>
          <button
            type="button"
            className="reorder-mobile-checklist-close"
            onClick={onClose}
            aria-label="Close checklist"
          >
            <X size={18} />
          </button>
        </div>
        <div className="reorder-mobile-checklist-progress">
          <div
            className="reorder-mobile-checklist-progress-fill"
            style={{
              width: `${lines.length > 0 ? (lines.filter((l) => l.checked).length / lines.length) * 100 : 0}%`,
            }}
          />
        </div>
        <p className="reorder-mobile-checklist-instructions">
          Tap an item to open it on {group.domain}. Set qty and price, then place your order.
        </p>

        <div className="checklist-items">
          <div className="checklist-items-header">
            <span />
            <span>Item</span>
            <span>Qty</span>
            <span>Unit Cost</span>
          </div>

          {lines.map((line) => {
            const itemData = group.items.find((i) => i.row.id === line.rowId);
            return (
              <div key={line.rowId} className={`checklist-item checklist-item--form${line.checked ? " checked" : ""}`}>
                <button
                  type="button"
                  className={`checklist-checkbox${line.checked ? " checked" : ""}`}
                  onClick={() => toggleLine(line.rowId)}
                  aria-label={line.checked ? `Uncheck ${line.name}` : `Check ${line.name}`}
                >
                  {line.checked && <Check size={14} />}
                </button>
                <div className="checklist-item-info">
                  <button
                    type="button"
                    className="checklist-item-name"
                    onClick={() => handleItemClick(line.link, line.rowId)}
                    title={`Open ${line.name} on ${group.domain}`}
                  >
                    {line.name}
                    <ExternalLink size={12} />
                  </button>
                  {itemData && (
                    <span className="checklist-item-detail">
                      <span className="reorder-item-status reorder-status-lowStock">
                        Low: {itemData.activeQty}/{itemData.minQuantity}
                      </span>
                      {itemData.hasExpired && (
                        <span className="reorder-item-status reorder-status-expired">
                          {itemData.expiredQty} expired
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <input
                  className="field checklist-qty-field"
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => updateLine(line.rowId, { qty: e.target.value })}
                  onClick={() => !line.checked && toggleLine(line.rowId)}
                />
                <input
                  className="field checklist-cost-field"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="$0.00"
                  value={line.unitCost}
                  onChange={(e) => updateLine(line.rowId, { unitCost: e.target.value })}
                  onClick={() => !line.checked && toggleLine(line.rowId)}
                />
              </div>
            );
          })}

          {rawLines.map((raw) => (
            <div key={raw.id} className="checklist-item checklist-item--form checklist-item--raw">
              <div className="checklist-raw-dot" />
              <input
                className="field checklist-raw-name-field"
                placeholder="Item name"
                value={raw.name}
                onChange={(e) => updateRaw(raw.id, { name: e.target.value })}
              />
              <input
                className="field checklist-qty-field"
                type="number"
                min="1"
                placeholder="Qty"
                value={raw.qty}
                onChange={(e) => updateRaw(raw.id, { qty: e.target.value })}
              />
              <input
                className="field checklist-cost-field"
                type="number"
                min="0"
                step="0.01"
                placeholder="$0.00"
                value={raw.unitCost}
                onChange={(e) => updateRaw(raw.id, { unitCost: e.target.value })}
              />
              <button
                type="button"
                className="checklist-raw-remove"
                onClick={() => setRawLines((prev) => prev.filter((r) => r.id !== raw.id))}
                aria-label="Remove"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="checklist-add-raw-btn"
          onClick={() =>
            setRawLines((prev) => [...prev, { id: crypto.randomUUID(), name: "", qty: "1", unitCost: "" }])
          }
        >
          <Plus size={13} /> Add item not listed
        </button>

        {checkedCount > 0 && (
          <div className="reorder-mobile-checklist-footer">
            <div className="reorder-mobile-checklist-footer-row">
              <span className="reorder-mobile-checklist-footer-count">
                {checkedCount} item{checkedCount !== 1 ? "s" : ""} selected
              </span>
              <button
                type="button"
                className="button button-primary button-sm"
                onClick={handlePlaceOrder}
              >
                Mark as Ordered
              </button>
            </div>
            <p className="reorder-mobile-checklist-footer-hint">
              Unchecked items will stay in your reorder list.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ReorderTab ───────────────────────────────────────────────────────────────

export function ReorderTab({ rows, onEditReorderLink, onClearOrderedAt, onMarkOrdered }: ReorderTabProps) {
  const [reorderedVendors, setReorderedVendors] = useState<Set<string>>(new Set());

  const { vendorGroups, noLinkItems, orderedItems } = useMemo(() => {
    // Aggregate rows by itemName + location into one entry per item
    type ItemAgg = {
      rows: InventoryRow[];
      activeQty: number;
      expiredQty: number;
      minQuantity: number;
      hasMin: boolean;
      reorderLink: string;
      latestOrderedAt: string | null;
    };

    const groupMap = new Map<string, ItemAgg>();

    for (const row of rows) {
      const itemName = String(row.values.itemName ?? "").trim();
      if (!itemName) continue;
      // Include location in key so items at different locations stay separate
      const location = String(row.values.location ?? "").trim();
      const key = `${itemName}\x00${location}`;

      const quantity = Number.isFinite(Number(row.values.quantity)) ? Number(row.values.quantity) : 0;
      const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
      const isExpired = daysUntil !== null && daysUntil < 0;
      const rowLink = normalizeLinkValue(String(row.values.reorderLink ?? "").trim());
      const rowOrderedAt = row.values.orderedAt ? String(row.values.orderedAt) : null;

      const existing = groupMap.get(key);
      if (!existing) {
        const minQuantityRaw = row.values.minQuantity;
        const minQuantity = Number(minQuantityRaw);
        const hasMin =
          minQuantityRaw !== null &&
          minQuantityRaw !== undefined &&
          String(minQuantityRaw).trim() !== "" &&
          Number.isFinite(minQuantity) &&
          minQuantity > 0;

        groupMap.set(key, {
          rows: [row],
          activeQty: isExpired ? 0 : quantity,
          expiredQty: isExpired ? quantity : 0,
          minQuantity: hasMin ? minQuantity : 0,
          hasMin,
          reorderLink: rowLink,
          latestOrderedAt: rowOrderedAt,
        });
      } else {
        existing.rows.push(row);
        if (isExpired) {
          existing.expiredQty += quantity;
        } else {
          existing.activeQty += quantity;
        }
        // Take the highest minQuantity across lots
        const minQuantityRaw = row.values.minQuantity;
        const minQuantity = Number(minQuantityRaw);
        const hasMin =
          minQuantityRaw !== null &&
          minQuantityRaw !== undefined &&
          String(minQuantityRaw).trim() !== "" &&
          Number.isFinite(minQuantity) &&
          minQuantity > 0;
        if (hasMin && minQuantity > existing.minQuantity) {
          existing.minQuantity = minQuantity;
          existing.hasMin = true;
        }
        // Prefer any row with a reorder link
        if (!existing.reorderLink && rowLink) {
          existing.reorderLink = rowLink;
        }
        // Track most recent orderedAt across all rows
        if (rowOrderedAt && (!existing.latestOrderedAt || rowOrderedAt > existing.latestOrderedAt)) {
          existing.latestOrderedAt = rowOrderedAt;
        }
      }
    }

    const reorderItems: ReorderItem[] = [];
    const noLink: ReorderItem[] = [];
    const ordered: ReorderItem[] = [];

    for (const [key, agg] of groupMap.entries()) {
      // Only show if actively low — expired qty doesn't count toward stock
      if (!agg.hasMin || agg.activeQty >= agg.minQuantity) continue;

      const itemName = key.split("\x00")[0];
      const suggestedQty = Math.max(1, Math.ceil(agg.minQuantity - agg.activeQty));

      // Representative row: prefer non-expired row with lowest active qty
      const activeRows = agg.rows.filter((r) => {
        const d = getDaysUntilExpiration(r.values.expirationDate);
        return d === null || d >= 0;
      });
      const candidateRows = activeRows.length > 0 ? activeRows : agg.rows;
      const repRow = candidateRows.reduce((best, r) =>
        Number(r.values.quantity ?? 0) < Number(best.values.quantity ?? 0) ? r : best,
      );

      const item: ReorderItem = {
        row: repRow,
        allRowIds: agg.rows.map((r) => r.id),
        itemName,
        reorderLink: agg.reorderLink,
        activeQty: agg.activeQty,
        expiredQty: agg.expiredQty,
        minQuantity: agg.minQuantity,
        suggestedQty,
        hasExpired: agg.expiredQty > 0,
        orderedAt: agg.latestOrderedAt,
      };

      if (agg.latestOrderedAt) {
        ordered.push(item);
      } else if (agg.reorderLink) {
        reorderItems.push(item);
      } else {
        noLink.push(item);
      }
    }

    // Group reorder items by vendor domain
    const domainMap = new Map<string, ReorderItem[]>();
    for (const item of reorderItems) {
      const domain = getVendorDomain(item.reorderLink);
      const existing = domainMap.get(domain);
      if (existing) existing.push(item);
      else domainMap.set(domain, [item]);
    }

    const groups: VendorGroup[] = Array.from(domainMap.entries())
      .map(([domain, items]) => ({ domain, items }))
      .sort((a, b) => b.items.length - a.items.length);

    return { vendorGroups: groups, noLinkItems: noLink, orderedItems: ordered };
  }, [rows]);

  const totalReorderItems = vendorGroups.reduce((sum, g) => sum + g.items.length, 0);

  const [mobileChecklistDomain, setMobileChecklistDomain] = useState<string | null>(null);
  const handleReorder = (group: VendorGroup) => {
    if (isMobile()) {
      setMobileChecklistDomain(group.domain);
    } else {
      openVendorChecklist(group);
    }
  };

  const handleReorderAll = () => {
    for (const group of vendorGroups) {
      handleReorder(group);
    }
  };

  if (totalReorderItems === 0 && noLinkItems.length === 0 && orderedItems.length === 0) {
    return (
      <div className="reorder-empty">
        <Package size={48} strokeWidth={1.5} />
        <h3>Nothing to reorder</h3>
        <p>All items are stocked and up to date.</p>
      </div>
    );
  }

  const renderItemBadges = (item: ReorderItem) => (
    <span className="reorder-item-badges">
      <span className="reorder-item-status reorder-status-lowStock">
        Low: {item.activeQty}/{item.minQuantity}
      </span>
      {item.hasExpired && (
        <span className="reorder-item-status reorder-status-expired">
          {item.expiredQty} expired
        </span>
      )}
    </span>
  );

  return (
    <div className="reorder-tab">
      <div className="reorder-header">
        <div className="reorder-header-left">
          <h3 className="reorder-title">
            Reorder
            {totalReorderItems > 0 && (
              <span className="reorder-count-badge">{totalReorderItems}</span>
            )}
          </h3>
          <span className="reorder-subtitle">
            {vendorGroups.length} vendor{vendorGroups.length !== 1 ? "s" : ""}
            {noLinkItems.length > 0 && ` · ${noLinkItems.length} missing link${noLinkItems.length !== 1 ? "s" : ""}`}
          </span>
        </div>
        {vendorGroups.length > 0 && (
          <button
            type="button"
            className="button button-primary"
            onClick={handleReorderAll}
          >
            <ShoppingCart size={16} />
            Reorder All
          </button>
        )}
      </div>

      {vendorGroups.map((group) => (
        <div key={group.domain} className="reorder-vendor-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <h4 className="reorder-vendor-name">{group.domain}</h4>
              <span className="reorder-vendor-count">
                {group.items.length} item{group.items.length !== 1 ? "s" : ""}
              </span>
            </div>
            <button
              type="button"
              className={`button ${reorderedVendors.has(group.domain) ? "button-secondary" : "button-ghost"} button-sm`}
              onClick={() => {
                handleReorder(group);
                setReorderedVendors((prev) => new Set(prev).add(group.domain));
              }}
              title="Open vendor checklist"
            >
              <ExternalLink size={14} />
              {reorderedVendors.has(group.domain) ? "Reopen" : "Order"}
            </button>
          </div>
          <div className="reorder-item-list">
            {group.items.map((item) => (
              <div key={item.row.id} className="reorder-item-row">
                <span className="reorder-item-name">{item.itemName}</span>
                {renderItemBadges(item)}
              </div>
            ))}
          </div>
        </div>
      ))}

      {noLinkItems.length > 0 && (
        <div className="reorder-vendor-card reorder-nolink-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <Link2Off size={18} />
              <h4 className="reorder-vendor-name">No Reorder Link</h4>
              <span className="reorder-vendor-count">
                {noLinkItems.length} item{noLinkItems.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <p className="reorder-nolink-hint">
            Click an item name to jump to its reorder link field.
          </p>
          <div className="reorder-item-list">
            {noLinkItems.map((item) => (
              <div key={item.row.id} className="reorder-item-row">
                {onEditReorderLink ? (
                  <button
                    type="button"
                    className="reorder-item-name reorder-item-name-btn"
                    onClick={() => onEditReorderLink(item.row.id)}
                  >
                    {item.itemName}
                  </button>
                ) : (
                  <span className="reorder-item-name">{item.itemName}</span>
                )}
                {renderItemBadges(item)}
              </div>
            ))}
          </div>
        </div>
      )}

      {mobileChecklistDomain && (() => {
        const group = vendorGroups.find((g) => g.domain === mobileChecklistDomain);
        if (!group) return null;
        return (
          <MobileChecklist
            group={group}
            onClose={() => setMobileChecklistDomain(null)}
            onPlaceOrder={onMarkOrdered ?? (() => {})}
          />
        );
      })()}

      {orderedItems.length > 0 && (
        <div className="reorder-vendor-card reorder-ordered-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <PackageCheck size={18} />
              <h4 className="reorder-vendor-name">Ordered</h4>
              <span className="reorder-vendor-count">
                {orderedItems.length} item{orderedItems.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <div className="reorder-item-list">
            {orderedItems.map((item) => {
              const daysAgo = item.orderedAt
                ? Math.floor((Date.now() - new Date(item.orderedAt).getTime()) / (1000 * 60 * 60 * 24))
                : null;
              return (
                <div key={item.row.id} className="reorder-item-row">
                  <span className="reorder-item-name">{item.itemName}</span>
                  <span className="reorder-item-ordered-info">
                    {daysAgo !== null && daysAgo > 0
                      ? `Ordered ${daysAgo}d ago`
                      : "Ordered today"}
                    {onClearOrderedAt && (
                      <button
                        type="button"
                        className="reorder-undo-btn"
                        title="Move back to reorder list"
                        onClick={() => onClearOrderedAt(item.allRowIds)}
                      >
                        <Undo2 size={14} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
