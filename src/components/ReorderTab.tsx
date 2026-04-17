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
  // True when the user added this item via the "Add Items" panel (not flagged
  // as low by the auto-reorder logic). Pre-checked in the vendor card so it
  // rolls into Mark-as-Ordered alongside low-stock items.
  isExtra?: boolean;
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
  onBack,
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
  /** Optional: when provided, shows a "← Back" button that returns the user
   *  to the previous view (typically the OrderBuilderPanel). Without this
   *  prop, only Close (×) is shown. */
  onBack?: () => void;
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
        {onBack ? (
          <button
            type="button"
            className="button button-ghost button-sm reorder-add-item-back"
            onClick={onBack}
          >
            ← Back
          </button>
        ) : null}
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

// ── OrderBuilderPanel ──────────────────────────────────────────────────────
// Top-of-reorder-page search panel. Lets users add existing inventory items
// to the current reorder (even if they're not low) and fall through to the
// "+ Add new item" flow for brand-new items. Picked items route into the
// matching vendor card by reorderLink domain, pre-checked.

function OrderBuilderPanel({
  inventoryRows,
  availableLocations,
  defaultLocation,
  alreadyPickedRowIds,
  onPick,
  onAddNew,
  onClose,
  onSaveReorderLink,
}: {
  inventoryRows: InventoryRow[];
  availableLocations: string[];
  defaultLocation: string;
  /** Row IDs already in the reorder list (low-stock, No-Link, or previously
   *  picked). We exclude these from search results so users don't add dupes. */
  alreadyPickedRowIds: Set<string>;
  onPick: (rowId: string) => void;
  onAddNew: () => void;
  onClose: () => void;
  /** When provided, picking an item that has no reorderLink triggers an inline
   *  prompt to add one before the item goes onto the reorder list. The user
   *  can also skip, in which case the item lands in the No-Link card. */
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
}) {
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  // When the user picks an unlinked row, we hold it here and show an inline
  // link-prompt form instead of adding to the reorder list immediately.
  const [linkPromptRow, setLinkPromptRow] = useState<InventoryRow | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = inventoryRows.filter((row) => {
      if (alreadyPickedRowIds.has(row.id)) return false;
      // Skip retired rows — they're not orderable.
      if (row.values.retiredAt) return false;
      const rowLocation = String(row.values.location ?? "").trim();
      if (location) {
        // If the user picked a location, only include matches. Empty location
        // on the row means "unassigned" — only matches when filter is also "".
        if (rowLocation !== location) return false;
      }
      if (!q) return true;
      const itemName = String(row.values.itemName ?? "").trim().toLowerCase();
      return itemName.includes(q);
    });
    // Limit to first 20 so the panel doesn't explode for huge inventories.
    return filtered.slice(0, 20);
  }, [inventoryRows, alreadyPickedRowIds, search, location]);

  const formatItem = (row: InventoryRow) => {
    const name = String(row.values.itemName ?? "").trim() || "Untitled";
    const qty = Number(row.values.quantity ?? 0);
    const min = Number(row.values.minQuantity ?? 0);
    const qtyLabel = Number.isFinite(min) && min > 0 ? `${qty}/${min}` : String(qty);
    const loc = String(row.values.location ?? "").trim();
    const hasLink = String(row.values.reorderLink ?? "").trim() !== "";
    return { name, qtyLabel, loc, hasLink };
  };

  const handleResultClick = (row: InventoryRow) => {
    const hasLink = String(row.values.reorderLink ?? "").trim() !== "";
    if (hasLink) {
      onPick(row.id);
      return;
    }
    // No link — open the inline link prompt before adding.
    setLinkPromptRow(row);
    setLinkDraft("");
  };

  const handleSkipLink = () => {
    if (!linkPromptRow) return;
    onPick(linkPromptRow.id);
    setLinkPromptRow(null);
    setLinkDraft("");
  };

  const handleSaveLinkAndAdd = async () => {
    if (!linkPromptRow) return;
    const trimmed = linkDraft.trim();
    if (!trimmed) {
      // Empty = same as skip.
      handleSkipLink();
      return;
    }
    if (onSaveReorderLink) {
      setSavingLink(true);
      try {
        await onSaveReorderLink([linkPromptRow.id], normalizeLinkValue(trimmed));
      } finally {
        setSavingLink(false);
      }
    }
    onPick(linkPromptRow.id);
    setLinkPromptRow(null);
    setLinkDraft("");
  };

  return (
    <div className="order-builder-panel app-card">
      <div className="order-builder-header">
        <div>
          <h4>Add items to this reorder</h4>
          <p className="order-builder-hint">
            Search your inventory and tap an item to add it to the reorder
            list. Items stay unchecked — you'll check them when you're ready
            to Mark as Ordered.
          </p>
        </div>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
      <div className="order-builder-controls">
        <label className="order-builder-field">
          <span>Location</span>
          <select
            className="field"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          >
            <option value="">All / Unassigned</option>
            {availableLocations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>
        <label className="order-builder-field order-builder-field--search">
          <span>Search inventory</span>
          <input
            className="field"
            type="search"
            placeholder="Type an item name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </label>
      </div>
      {linkPromptRow ? (
        <div className="order-builder-link-prompt">
          <div className="order-builder-link-prompt-head">
            <Link2Off size={16} />
            <span>
              <strong>{String(linkPromptRow.values.itemName ?? "").trim() || "This item"}</strong>{" "}
              has no vendor link. Add one now so it's ready next time, or skip
              to add it to the list anyway.
            </span>
          </div>
          <div className="order-builder-link-prompt-row">
            <input
              className="field"
              type="url"
              placeholder="https://vendor.com/product..."
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveLinkAndAdd();
              }}
              autoFocus
              disabled={savingLink}
            />
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={handleSaveLinkAndAdd}
              disabled={savingLink}
            >
              <Save size={13} /> Save &amp; add
            </button>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={handleSkipLink}
              disabled={savingLink}
            >
              Skip
            </button>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => {
                setLinkPromptRow(null);
                setLinkDraft("");
              }}
              disabled={savingLink}
              aria-label="Cancel"
              title="Cancel"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ) : null}
      <div className="order-builder-results">
        {results.length === 0 ? (
          <p className="order-builder-empty">
            {search.trim()
              ? "No matching items in this location."
              : "Start typing to search inventory, or add a new item below."}
          </p>
        ) : (
          results.map((row) => {
            const { name, qtyLabel, loc, hasLink } = formatItem(row);
            return (
              <button
                key={row.id}
                type="button"
                className="order-builder-result"
                onClick={() => handleResultClick(row)}
              >
                <span className="order-builder-result-name">{name}</span>
                <span className="order-builder-result-meta">
                  qty {qtyLabel}
                  {loc && ` · ${loc}`}
                  {!hasLink && (
                    <span className="order-builder-result-nolink">
                      <Link2Off size={11} /> No link
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
      <div className="order-builder-footer">
        <span className="order-builder-footer-hint">Can't find it?</span>
        <button
          type="button"
          className="button button-secondary button-sm"
          onClick={onAddNew}
        >
          <Plus size={13} /> Add new item
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
  onRemoveExtra,
}: {
  group: VendorGroup;
  rawLines: RawLine[];
  onUpdateRawLine: (id: string, patch: Partial<RawLine>) => void;
  onRemoveRawLine: (id: string) => void;
  onMarkOrdered: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
  /** Called when the user removes an extra-picked item (non-low item they
   *  added via the OrderBuilderPanel) from the reorder list. */
  onRemoveExtra?: (rowId: string) => void;
}) {
  const [lines, setLines] = useState<LineState[]>(() =>
    group.items.map((item) => ({
      rowId: item.row.id,
      allRowIds: item.allRowIds,
      name: item.itemName,
      link: item.reorderLink,
      // All items start unchecked — including extras manually added via
      // OrderBuilderPanel. Extras live in the list as "reorder this" until
      // the user explicitly checks them to roll into Mark-as-Ordered.
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

  // Running subtotal across checked lines (inventory items with a known
  // unit cost). Raw/freeform lines don't have a price attached so they're
  // excluded — we surface a count of those separately so users know why
  // the subtotal might look light.
  const checkedSubtotal = lines.reduce((sum, line) => {
    if (!line.checked) return sum;
    const item = group.items.find((i) => i.row.id === line.rowId);
    if (!item || item.unitCost === null) return sum;
    const qty = Math.max(0, Number(line.qty) || 0);
    return sum + item.unitCost * qty;
  }, 0);
  const checkedMissingPrice = lines.filter((line) => {
    if (!line.checked) return false;
    const item = group.items.find((i) => i.row.id === line.rowId);
    return !item || item.unitCost === null;
  }).length;
  const freeformCheckedCount = rawLines.filter(
    (r) => r.name.trim() && Number(r.qty) > 0,
  ).length;
  const unpricedCount = checkedMissingPrice + freeformCheckedCount;

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
          const isExtra = itemData?.isExtra === true;
          return (
            <div key={line.rowId} className={`checklist-item checklist-item--form${line.checked ? " checked" : ""}${isExtra ? " checklist-item--extra" : ""}`}>
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
                    {isExtra ? (
                      onRemoveExtra ? (
                        <button
                          type="button"
                          className="reorder-item-status reorder-status-extra reorder-status-extra--removable"
                          onClick={() => onRemoveExtra(line.rowId)}
                          title="Remove from reorder list"
                          aria-label={`Remove ${line.name} from reorder`}
                        >
                          Added
                          <X size={11} />
                        </button>
                      ) : (
                        <span className="reorder-item-status reorder-status-extra">
                          Added
                        </span>
                      )
                    ) : (
                      <span className="reorder-item-status reorder-status-lowStock">
                        Low: {itemData.activeQty}/{itemData.minQuantity}
                      </span>
                    )}
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
            <div className="checklist-done-banner-summary">
              <span className="checklist-done-banner-count">
                {checkedCount} item{checkedCount !== 1 ? "s" : ""} selected
              </span>
              {checkedSubtotal > 0 && (
                <span className="checklist-done-banner-subtotal">
                  Subtotal: <strong>{formatCurrency(checkedSubtotal)}</strong>
                  {unpricedCount > 0 && (
                    <span className="checklist-done-banner-unpriced">
                      {" "}(+{unpricedCount} without price)
                    </span>
                  )}
                </span>
              )}
              {checkedSubtotal === 0 && unpricedCount > 0 && (
                <span className="checklist-done-banner-subtotal">
                  <span className="checklist-done-banner-unpriced">
                    No pricing on selected items
                  </span>
                </span>
              )}
            </div>
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
  onRemoveExtra,
}: {
  items: ReorderItem[];
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
  onRemoveExtra?: (rowId: string) => void;
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
            <div key={item.row.id} className={`reorder-nolink-row${item.isExtra ? " reorder-nolink-row--extra" : ""}`}>
              <div className="reorder-nolink-name">
                <span className="reorder-item-name">{item.itemName}</span>
                <span className="reorder-item-badges">
                  {item.isExtra ? (
                    onRemoveExtra ? (
                      <button
                        type="button"
                        className="reorder-item-status reorder-status-extra reorder-status-extra--removable"
                        onClick={() => onRemoveExtra(item.row.id)}
                        title="Remove from reorder list"
                        aria-label={`Remove ${item.itemName} from reorder`}
                      >
                        Added
                        <X size={11} />
                      </button>
                    ) : (
                      <span className="reorder-item-status reorder-status-extra">
                        Added
                      </span>
                    )
                  ) : (
                    <span className="reorder-item-status reorder-status-lowStock">
                      Low: {item.activeQty}/{item.minQuantity}
                    </span>
                  )}
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
  const [showOrderBuilder, setShowOrderBuilder] = useState(false);
  // Rows the user has explicitly picked for this reorder via the panel (not
  // low-stock). Stored as rowId — we look up the live row from inventoryRows
  // during rendering so stale pick state doesn't drift if the row changes.
  const [extraPickRowIds, setExtraPickRowIds] = useState<string[]>([]);

  // Build a ReorderItem for each extra-picked row, using the same shape and
  // unit-cost derivation as low-stock items. Items already represented in
  // vendorGroups/noLinkItems (user picked something that became low) are
  // skipped so we don't render duplicates.
  const extraPickedItems = useMemo<ReorderItem[]>(() => {
    if (extraPickRowIds.length === 0) return [];
    const alreadyCoveredRowIds = new Set<string>();
    for (const g of vendorGroups) {
      for (const item of g.items) {
        item.allRowIds.forEach((id) => alreadyCoveredRowIds.add(id));
      }
    }
    for (const item of noLinkItems) {
      item.allRowIds.forEach((id) => alreadyCoveredRowIds.add(id));
    }
    const out: ReorderItem[] = [];
    for (const rowId of extraPickRowIds) {
      if (alreadyCoveredRowIds.has(rowId)) continue;
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const itemName = String(row.values.itemName ?? "").trim() || `Item ${row.id.slice(0, 8)}`;
      const activeQty = Number.isFinite(Number(row.values.quantity)) ? Number(row.values.quantity) : 0;
      const minQuantity = Number(row.values.minQuantity);
      const hasMin = Number.isFinite(minQuantity) && minQuantity > 0;
      const reorderLink = normalizeLinkValue(String(row.values.reorderLink ?? "").trim());
      // Effective unit cost — same rules as low-stock items.
      const packCost = Number(row.values.packCost);
      const packSize = Number(row.values.packSize);
      const storedUnit = Number(row.values.unitCost);
      let unitCost: number | null = null;
      if (Number.isFinite(packCost) && Number.isFinite(packSize) && packSize > 0) {
        unitCost = packCost / packSize;
      } else if (Number.isFinite(storedUnit) && storedUnit >= 0) {
        unitCost = storedUnit;
      }
      out.push({
        row,
        allRowIds: [row.id],
        itemName,
        reorderLink,
        activeQty,
        expiredQty: 0,
        minQuantity: hasMin ? minQuantity : 0,
        suggestedQty: 1, // default 1 for proactive picks
        hasExpired: false,
        orderedAt: null,
        unitCost,
        isExtra: true,
      });
    }
    return out;
  }, [extraPickRowIds, vendorGroups, noLinkItems, rows]);

  // Merge extra picks into the same vendor-domain grouping as low-stock items.
  // Items with a reorderLink route to the matching vendor card; items without
  // one go to the No-Link card (treated just like low-stock unlinked items).
  const vendorGroupsWithExtras = useMemo<VendorGroup[]>(() => {
    if (extraPickedItems.length === 0) return vendorGroups;
    // Clone the groups so we don't mutate the original memo result.
    const cloned: VendorGroup[] = vendorGroups.map((g) => ({
      domain: g.domain,
      items: [...g.items],
    }));
    const domainIndex = new Map(cloned.map((g, i) => [g.domain, i]));
    for (const item of extraPickedItems) {
      if (!item.reorderLink) continue; // no-link extras handled below
      const domain = getVendorDomain(item.reorderLink);
      const idx = domainIndex.get(domain);
      if (idx === undefined) {
        domainIndex.set(domain, cloned.length);
        cloned.push({ domain, items: [item] });
      } else {
        cloned[idx].items.push(item);
      }
    }
    return cloned;
  }, [vendorGroups, extraPickedItems]);

  const noLinkItemsWithExtras = useMemo<ReorderItem[]>(() => {
    const extras = extraPickedItems.filter((i) => !i.reorderLink);
    if (extras.length === 0) return noLinkItems;
    return [...noLinkItems, ...extras];
  }, [noLinkItems, extraPickedItems]);

  // Set of row IDs already in the reorder list — used by OrderBuilderPanel to
  // hide already-covered items from search results.
  const alreadyPickedRowIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of vendorGroupsWithExtras) {
      for (const item of g.items) {
        item.allRowIds.forEach((id) => set.add(id));
      }
    }
    for (const item of noLinkItemsWithExtras) {
      item.allRowIds.forEach((id) => set.add(id));
    }
    return set;
  }, [vendorGroupsWithExtras, noLinkItemsWithExtras]);

  const handlePickExtra = (rowId: string) => {
    setExtraPickRowIds((prev) => (prev.includes(rowId) ? prev : [...prev, rowId]));
  };

  const handleRemoveExtra = (rowId: string) => {
    setExtraPickRowIds((prev) => prev.filter((id) => id !== rowId));
  };

  // Combine real vendor groups with synthetic groups for raw lines whose link
  // points to a domain that isn't already in the reorder list (or to a brand
  // new vendor).
  const allGroups = useMemo(() => {
    const existingDomains = new Set(vendorGroupsWithExtras.map((g) => g.domain));
    const syntheticDomains = new Set<string>();
    for (const raw of rawLines) {
      const domain = computeRawLineDomain(raw);
      if (!existingDomains.has(domain)) syntheticDomains.add(domain);
    }
    const synthetic: VendorGroup[] = Array.from(syntheticDomains)
      .sort()
      .map((domain) => ({ domain, items: [] }));
    return [...vendorGroupsWithExtras, ...synthetic];
  }, [vendorGroupsWithExtras, rawLines]);

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

  const totalReorderItems = vendorGroupsWithExtras.reduce((sum, g) => sum + g.items.length, 0);
  const isEmpty =
    totalReorderItems === 0 && noLinkItemsWithExtras.length === 0 && rawLines.length === 0;

  // Estimated total to reorder everything in the list at the suggested qty.
  // Raw-added items (Add Item Not Listed) and items without a known price are
  // skipped; we count those separately so the user sees what's missing.
  const priceableItems = [
    ...vendorGroupsWithExtras.flatMap((g) => g.items),
    ...noLinkItemsWithExtras,
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
              {noLinkItemsWithExtras.length > 0 && ` · ${noLinkItemsWithExtras.length} missing link${noLinkItemsWithExtras.length !== 1 ? "s" : ""}`}
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
        {!showOrderBuilder && !showAddForm && (
          <button
            type="button"
            className="button button-secondary reorder-add-item-btn"
            onClick={() => setShowOrderBuilder(true)}
          >
            <Plus size={15} /> Add Items
          </button>
        )}
      </div>

      {showOrderBuilder && (
        <OrderBuilderPanel
          inventoryRows={rows}
          availableLocations={availableLocations}
          defaultLocation={selectedLocation ?? ""}
          alreadyPickedRowIds={alreadyPickedRowIds}
          onPick={handlePickExtra}
          onAddNew={() => {
            setShowOrderBuilder(false);
            setShowAddForm(true);
          }}
          onClose={() => setShowOrderBuilder(false)}
          onSaveReorderLink={onSaveReorderLink}
        />
      )}

      {showAddForm && (
        <AddItemCard
          availableLocations={availableLocations}
          defaultLocation={selectedLocation ?? ""}
          onAdd={handleAddRawLine}
          onClose={() => setShowAddForm(false)}
          onBack={() => {
            setShowAddForm(false);
            setShowOrderBuilder(true);
          }}
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
            onRemoveExtra={handleRemoveExtra}
          />
        );
      })}

      {noLinkItemsWithExtras.length > 0 && (
        <NoLinkCard
          items={noLinkItemsWithExtras}
          onSaveReorderLink={onSaveReorderLink}
          onRemoveExtra={handleRemoveExtra}
        />
      )}
    </div>
  );
}
