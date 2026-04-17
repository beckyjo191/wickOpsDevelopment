import { useMemo, useState } from "react";
import type { InventoryRow } from "../lib/inventoryApi";
import { formatCurrency } from "../lib/currency";
import { Check, ExternalLink, Link2Off, Package, Plus, Save, X } from "lucide-react";

export type OrderItem = {
  rowId: string | null;
  name: string;
  qty: number;
  // For freeform items only: vendor URL the user entered when adding the item.
  // Persisted onto the new inventory row when received with addToInventory.
  reorderLink?: string;
  // For freeform items only: location the user picked when adding the item.
  location?: string;
};

interface ReorderTabProps {
  rows: InventoryRow[];
  availableLocations?: string[];
  selectedLocation?: string | null;
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
  onMarkOrdered?: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
}

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
  // Per-unit price: prefers packCost / packSize when both are set, falls back
  // to the row's stored unitCost. Null when we have no price data at all.
  unitCost: number | null;
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

// ── Top-level "Add Item Not Listed" form ───────────────────────────────────

function AddItemCard({
  availableLocations,
  defaultLocation,
  onAdd,
  onClose,
}: {
  availableLocations: string[];
  defaultLocation: string;
  onAdd: (input: {
    name: string;
    link: string;
    qty: string;
    location: string;
  }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [qty, setQty] = useState("1");
  const [location, setLocation] = useState(defaultLocation);
  const [error, setError] = useState("");

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Item name is required.");
      return;
    }
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setError("Quantity must be greater than 0.");
      return;
    }
    onAdd({ name, link, qty, location });
    onClose();
  };

  return (
    <div className="reorder-add-item-form app-card">
      <div className="reorder-add-item-form-header">
        <h4>Add Item Not Listed</h4>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="reorder-add-item-grid">
        <label className="reorder-add-item-field reorder-add-item-field--wide">
          <span>Item name</span>
          <input
            className="field"
            placeholder="e.g. Endotracheal Tube — 8.0"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label className="reorder-add-item-field reorder-add-item-field--wide">
          <span>Vendor link (optional)</span>
          <input
            className="field"
            placeholder="https://vendor.com/product..."
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </label>
        <label className="reorder-add-item-field">
          <span>Qty</span>
          <input
            className="field"
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label className="reorder-add-item-field">
          <span>Location</span>
          <select
            className="field"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          >
            <option value="">Unassigned</option>
            {availableLocations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="reorder-add-item-error">{error}</p>}
      <div className="reorder-add-item-actions">
        <button
          type="button"
          className="button button-primary button-sm"
          onClick={handleSubmit}
        >
          Add to reorder list
        </button>
      </div>
    </div>
  );
}

// ── Raw lines (items added via "Add item not listed") ───────────────────────

type RawLine = {
  id: string;
  name: string;
  link: string;
  qty: string;
  // Location the user picked when adding the item. Threaded through to the
  // restock order so the new inventory row can be created with the right
  // location context.
  location: string;
  // Card the row was originally added in. Used as fallback routing when no link
  // is provided so the row stays where the user typed it.
  originDomain: string;
};

// Routing domain: link's hostname if present and parseable, otherwise originDomain.
const computeRawLineDomain = (raw: RawLine): string => {
  const trimmed = raw.link.trim();
  if (!trimmed) return raw.originDomain;
  const normalized = normalizeLinkValue(trimmed);
  try {
    return new URL(normalized).hostname.replace(/^www\./, "");
  } catch {
    return raw.originDomain;
  }
};

function RawLineRow({
  raw,
  onUpdate,
  onRemove,
}: {
  raw: RawLine;
  onUpdate: (id: string, patch: Partial<RawLine>) => void;
  onRemove: (id: string) => void;
}) {
  // Local draft for the link input so the row doesn't jump to another card
  // mid-keystroke. Committed to parent state on blur / Enter.
  const [linkDraft, setLinkDraft] = useState(raw.link);

  const commitLink = () => {
    if (linkDraft !== raw.link) onUpdate(raw.id, { link: linkDraft });
  };

  return (
    <div className="checklist-item checklist-item--form checklist-item--raw">
      <div className="checklist-raw-dot" />
      <div className="checklist-raw-fields">
        <input
          className="field checklist-raw-name-field"
          placeholder="Item name"
          value={raw.name}
          onChange={(e) => onUpdate(raw.id, { name: e.target.value })}
        />
        <input
          className="field checklist-raw-link-field"
          placeholder="Vendor link (optional)"
          value={linkDraft}
          onChange={(e) => setLinkDraft(e.target.value)}
          onBlur={commitLink}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitLink();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      <input
        className="field checklist-qty-field"
        type="number"
        min="1"
        placeholder="Qty"
        value={raw.qty}
        onChange={(e) => onUpdate(raw.id, { qty: e.target.value })}
      />
      <button
        type="button"
        className="checklist-raw-remove"
        onClick={() => onRemove(raw.id)}
        aria-label="Remove"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── VendorChecklistCard ──────────────────────────────────────────────────────

type LineState = {
  rowId: string;
  allRowIds: string[];
  name: string;
  link: string;
  checked: boolean;
  qty: string;
};

function VendorChecklistCard({
  group,
  rawLines,
  onUpdateRawLine,
  onRemoveRawLine,
  onMarkOrdered,
}: {
  group: VendorGroup;
  rawLines: RawLine[];
  onUpdateRawLine: (id: string, patch: Partial<RawLine>) => void;
  onRemoveRawLine: (id: string) => void;
  onMarkOrdered: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
}) {
  const [lines, setLines] = useState<LineState[]>(() =>
    group.items.map((item) => ({
      rowId: item.row.id,
      allRowIds: item.allRowIds,
      name: item.itemName,
      link: item.reorderLink,
      checked: false,
      qty: String(item.suggestedQty),
    })),
  );

  const toggleLine = (rowId: string) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: !l.checked } : l)));

  const updateLine = (rowId: string, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, ...patch } : l)));

  const markLineChecked = (rowId: string) => {
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: true } : l)));
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
      }));
    const freeformItems = rawLines
      .filter((r) => r.name.trim() && Number(r.qty) > 0)
      .map((r) => {
        const link = r.link.trim();
        return {
          rowId: null as string | null,
          name: r.name.trim(),
          qty: Number(r.qty),
          ...(link ? { reorderLink: normalizeLinkValue(link) } : {}),
          ...(r.location ? { location: r.location } : {}),
        };
      });
    // Use allRowIds so every lot in the group gets stamped as ordered
    const checkedRowIds = lines.filter((l) => l.checked).flatMap((l) => l.allRowIds);
    onMarkOrdered(checkedRowIds, group.domain, [...inventoryItems, ...freeformItems]);
    // Parent clears routed raw lines for this vendor.
  };

  return (
    <div className="reorder-vendor-card app-card">
      <div className="reorder-vendor-header">
        <div className="reorder-vendor-info">
          <h4 className="reorder-vendor-name">{group.domain}</h4>
          <span className="reorder-vendor-count">
            {group.items.length + rawLines.length} item
            {group.items.length + rawLines.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="checklist-items checklist-items--inline">
        <div className="checklist-items-header">
          <span />
          <span>Item</span>
          <span>Qty</span>
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
                <a
                  className="checklist-item-name"
                  href={normalizeLinkValue(line.link)}
                  target={`wickops-vendor-${group.domain}`}
                  rel="noopener noreferrer"
                  onClick={() => markLineChecked(line.rowId)}
                  title={`Open ${line.name} on ${group.domain}`}
                >
                  {line.name}
                  <ExternalLink size={12} />
                </a>
                {itemData && (
                  <span className="checklist-item-detail">
                    <span className="reorder-item-status reorder-status-lowStock">
                      Low: {itemData.activeQty}/{itemData.minQuantity}
                    </span>
                    {itemData.unitCost !== null && (
                      <span className="reorder-item-unitcost">
                        {formatCurrency(itemData.unitCost)}/unit
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
              />
            </div>
          );
        })}

        {rawLines.map((raw) => (
          <RawLineRow
            key={raw.id}
            raw={raw}
            onUpdate={onUpdateRawLine}
            onRemove={onRemoveRawLine}
          />
        ))}
      </div>

      {checkedCount > 0 && (
        <div className="checklist-done-banner checklist-done-banner--inline">
          <div className="checklist-done-banner-row">
            <span className="checklist-done-banner-count">
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
          <p className="checklist-done-banner-hint">
            Unchecked items will stay in your reorder list.
          </p>
        </div>
      )}
    </div>
  );
}

// ── NoLinkCard ───────────────────────────────────────────────────────────────

function NoLinkCard({
  items,
  onSaveReorderLink,
}: {
  items: ReorderItem[];
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
}) {
  const [linkInputs, setLinkInputs] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const handleSave = async (item: ReorderItem) => {
    const value = (linkInputs[item.row.id] ?? "").trim();
    if (!value || !onSaveReorderLink) return;
    setSavingId(item.row.id);
    try {
      await onSaveReorderLink(item.allRowIds, normalizeLinkValue(value));
      setLinkInputs((prev) => {
        const next = { ...prev };
        delete next[item.row.id];
        return next;
      });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="reorder-vendor-card reorder-nolink-card app-card">
      <div className="reorder-vendor-header">
        <div className="reorder-vendor-info">
          <Link2Off size={18} />
          <h4 className="reorder-vendor-name">No Reorder Link</h4>
          <span className="reorder-vendor-count">
            {items.length} item{items.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <p className="reorder-nolink-hint">
        Add a vendor link below so you can reorder this item next time.
      </p>
      <div className="reorder-nolink-list">
        {items.map((item) => {
          const value = linkInputs[item.row.id] ?? "";
          const saving = savingId === item.row.id;
          return (
            <div key={item.row.id} className="reorder-nolink-row">
              <div className="reorder-nolink-name">
                <span className="reorder-item-name">{item.itemName}</span>
                <span className="reorder-item-badges">
                  <span className="reorder-item-status reorder-status-lowStock">
                    Low: {item.activeQty}/{item.minQuantity}
                  </span>
                  {item.unitCost !== null && (
                    <span className="reorder-item-unitcost">
                      {formatCurrency(item.unitCost)}/unit
                    </span>
                  )}
                </span>
              </div>
              <input
                className="field reorder-nolink-input"
                placeholder="https://vendor.com/product..."
                value={value}
                onChange={(e) =>
                  setLinkInputs((prev) => ({ ...prev, [item.row.id]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave(item);
                }}
                disabled={!onSaveReorderLink || saving}
              />
              <button
                type="button"
                className="button button-primary button-sm"
                onClick={() => handleSave(item)}
                disabled={!value.trim() || !onSaveReorderLink || saving}
                title="Save link"
              >
                <Save size={13} />
                Save
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ReorderTab ───────────────────────────────────────────────────────────────

export function ReorderTab({
  rows,
  availableLocations = [],
  selectedLocation = null,
  onSaveReorderLink,
  onMarkOrdered,
}: ReorderTabProps) {
  const { vendorGroups, noLinkItems } = useMemo(() => {
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

    for (const [key, agg] of groupMap.entries()) {
      // Only show if actively low — expired qty doesn't count toward stock
      if (!agg.hasMin || agg.activeQty >= agg.minQuantity) continue;
      // Already-ordered items live in the Pending Receipt section; skip here.
      if (agg.latestOrderedAt) continue;

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

      // Effective unit cost for estimating reorder spend: prefer the derived
      // price from packCost / packSize when both are set, else the row's
      // stored unitCost. Null when neither is available.
      const packCost = Number(repRow.values.packCost);
      const packSize = Number(repRow.values.packSize);
      const storedUnit = Number(repRow.values.unitCost);
      let unitCost: number | null = null;
      if (Number.isFinite(packCost) && Number.isFinite(packSize) && packSize > 0) {
        unitCost = packCost / packSize;
      } else if (Number.isFinite(storedUnit) && storedUnit >= 0) {
        unitCost = storedUnit;
      }

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
        unitCost,
      };

      if (agg.reorderLink) {
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

    return { vendorGroups: groups, noLinkItems: noLink };
  }, [rows]);

  // Manually-added items ("Add item not listed"). Lifted here so they can be
  // smart-routed to vendor cards based on the link domain.
  const [rawLines, setRawLines] = useState<RawLine[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);

  // Combine real vendor groups with synthetic groups for raw lines whose link
  // points to a domain that isn't already in the reorder list (or to a brand
  // new vendor).
  const allGroups = useMemo(() => {
    const existingDomains = new Set(vendorGroups.map((g) => g.domain));
    const syntheticDomains = new Set<string>();
    for (const raw of rawLines) {
      const domain = computeRawLineDomain(raw);
      if (!existingDomains.has(domain)) syntheticDomains.add(domain);
    }
    const synthetic: VendorGroup[] = Array.from(syntheticDomains)
      .sort()
      .map((domain) => ({ domain, items: [] }));
    return [...vendorGroups, ...synthetic];
  }, [vendorGroups, rawLines]);

  const getRawLinesForDomain = (domain: string) =>
    rawLines.filter((r) => computeRawLineDomain(r) === domain);

  // Called from the top-level "Add Item Not Listed" form with all fields.
  const handleAddRawLine = (input: {
    name: string;
    link: string;
    qty: string;
    location: string;
  }) => {
    const trimmedLink = input.link.trim();
    // Pre-compute routing so the row lands under the right card immediately,
    // no on-blur migration needed.
    const originDomain = trimmedLink
      ? (() => {
          try {
            return new URL(normalizeLinkValue(trimmedLink)).hostname.replace(/^www\./, "");
          } catch {
            return "Other";
          }
        })()
      : "Other";
    setRawLines((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        link: trimmedLink,
        qty: input.qty.trim() || "1",
        location: input.location,
        originDomain,
      },
    ]);
  };

  const handleUpdateRawLine = (id: string, patch: Partial<RawLine>) =>
    setRawLines((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleRemoveRawLine = (id: string) =>
    setRawLines((prev) => prev.filter((r) => r.id !== id));

  // Wraps onMarkOrdered so we also clear the raw lines that were routed to the
  // vendor that just placed an order.
  const handleMarkOrderedForVendor = (rowIds: string[], vendor: string, orderItems: OrderItem[]) => {
    onMarkOrdered?.(rowIds, vendor, orderItems);
    setRawLines((prev) => prev.filter((r) => computeRawLineDomain(r) !== vendor));
  };

  const totalReorderItems = vendorGroups.reduce((sum, g) => sum + g.items.length, 0);
  const isEmpty =
    totalReorderItems === 0 && noLinkItems.length === 0 && rawLines.length === 0;

  // Estimated total to reorder everything in the list at the suggested qty.
  // Raw-added items (Add Item Not Listed) and items without a known price are
  // skipped; we count those separately so the user sees what's missing.
  const priceableItems = [
    ...vendorGroups.flatMap((g) => g.items),
    ...noLinkItems,
  ];
  const estimatedTotal = priceableItems.reduce((sum, item) => {
    if (item.unitCost === null) return sum;
    return sum + item.unitCost * item.suggestedQty;
  }, 0);
  const missingPriceCount = priceableItems.filter((i) => i.unitCost === null).length;

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
          {!isEmpty && (
            <span className="reorder-subtitle">
              {allGroups.length} vendor{allGroups.length !== 1 ? "s" : ""}
              {noLinkItems.length > 0 && ` · ${noLinkItems.length} missing link${noLinkItems.length !== 1 ? "s" : ""}`}
            </span>
          )}
          {!isEmpty && (estimatedTotal > 0 || missingPriceCount > 0) && (
            <span className="reorder-estimate">
              Estimated:{" "}
              <strong>{formatCurrency(estimatedTotal)}</strong>
              {missingPriceCount > 0 && (
                <span className="reorder-estimate-missing">
                  {" "}({missingPriceCount} item{missingPriceCount !== 1 ? "s" : ""} without prices)
                </span>
              )}
            </span>
          )}
        </div>
        {!showAddForm && (
          <button
            type="button"
            className="button button-secondary reorder-add-item-btn"
            onClick={() => setShowAddForm(true)}
          >
            <Plus size={15} /> Add Item Not Listed
          </button>
        )}
      </div>

      {showAddForm && (
        <AddItemCard
          availableLocations={availableLocations}
          defaultLocation={selectedLocation ?? ""}
          onAdd={handleAddRawLine}
          onClose={() => setShowAddForm(false)}
        />
      )}

      {isEmpty && (
        <div className="reorder-empty">
          <Package size={48} strokeWidth={1.5} />
          <h3>Nothing to reorder</h3>
          <p>All items are stocked and up to date.</p>
        </div>
      )}

      {allGroups.map((group) => {
        const cardRawLines = getRawLinesForDomain(group.domain);
        return (
          <VendorChecklistCard
            key={`${group.domain}-${group.items.map((i) => i.row.id).sort().join(",")}`}
            group={group}
            rawLines={cardRawLines}
            onUpdateRawLine={handleUpdateRawLine}
            onRemoveRawLine={handleRemoveRawLine}
            onMarkOrdered={handleMarkOrderedForVendor}
          />
        );
      })}

      {noLinkItems.length > 0 && (
        <NoLinkCard items={noLinkItems} onSaveReorderLink={onSaveReorderLink} />
      )}
    </div>
  );
}
