import { useEffect, useMemo, useRef, useState } from "react";
import type { InventoryRow } from "../lib/inventoryApi";
import { formatCurrency, parseCurrency } from "../lib/currency";
import { Check, ExternalLink, Link2Off, Package, Plus, Save, X } from "lucide-react";

export type OrderItem = {
  rowId: string | null;
  name: string;
  qty: number;
  // Optional unit cost captured when the user added the item. Flows through
  // to createRestockOrder -> the order's unitCost field so subtotals render
  // on the Orders page and receive pre-fills the per-unit price.
  unitCost?: number;
  // Optional reorder threshold captured when the user added a freeform item.
  // Persisted onto the new inventory row on receive so future reorder logic
  // can flag the item as low when stock drops.
  minQuantity?: number;
  // Optional pack size (units per box). Persisted to the new inventory row
  // on receive so box-mode receiving + unit-cost derivation work next time.
  packSize?: number;
  // Optional pack cost (price per box).
  packCost?: number;
  // For freeform items only: vendor URL the user entered when adding the item.
  // Persisted onto the new inventory row when received with addToInventory.
  reorderLink?: string;
  // For freeform items only: location the user picked when adding the item.
  location?: string;
};

/** Input shape for creating a brand-new inventory item from the "Add Item Not
 *  Listed" form. Persisted to the backend so the entry survives reload, and
 *  the auto-check state knows about it before the save completes. */
export type AddItemInput = {
  name: string;
  link: string;
  qty: string;
  minQty: string;
  unitCost: string;
  packSize: string;
  packCost: string;
  location: string;
};

interface ReorderTabProps {
  rows: InventoryRow[];
  availableLocations?: string[];
  selectedLocation?: string | null;
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
  onMarkOrdered?: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
  /** Persist the newly-added item as an inventory row. Returns the saved row
   *  so ReorderTab can auto-check it by key immediately. Without this,
   *  Add-to-reorder-list only lives in memory and vanishes on reload. */
  onAddItem?: (input: AddItemInput) => Promise<{ rowId: string; itemName: string; location: string }>;
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
    minQty: string;
    unitCost: string;
    packSize: string;
    packCost: string;
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
  const [minQty, setMinQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [packSize, setPackSize] = useState("");
  const [packCost, setPackCost] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  const [error, setError] = useState("");

  // On blur, reformat freshly-typed currency as "$4,239.00". Matches the
  // receive form pattern so pricing input feels consistent.
  const normalizeCurrency = (
    value: string,
    setter: (next: string) => void,
  ) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const parsed = parseCurrency(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) setter(formatCurrency(parsed));
  };

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
    if (minQty.trim()) {
      const parsedMin = Number(minQty);
      if (!Number.isFinite(parsedMin) || parsedMin < 0) {
        setError("Min quantity must be a non-negative number.");
        return;
      }
    }
    if (unitCost.trim()) {
      const parsed = parseCurrency(unitCost);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Unit cost must be a non-negative number.");
        return;
      }
    }
    if (packSize.trim()) {
      const parsed = Number(packSize);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("Pack size must be greater than 0.");
        return;
      }
    }
    if (packCost.trim()) {
      const parsed = parseCurrency(packCost);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Pack cost must be a non-negative number.");
        return;
      }
    }
    onAdd({ name, link, qty, minQty, unitCost, packSize, packCost, location });
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
          <span>Qty to order</span>
          <input
            className="field"
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label className="reorder-add-item-field">
          <span>Min quantity (optional)</span>
          <input
            className="field"
            type="number"
            min="0"
            placeholder="Reorder threshold"
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
          />
        </label>
        <label className="reorder-add-item-field">
          <span>Unit cost (optional)</span>
          <input
            className="field"
            type="text"
            inputMode="decimal"
            placeholder="$0.00"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            onBlur={(e) => normalizeCurrency(e.target.value, setUnitCost)}
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
        <label className="reorder-add-item-field">
          <span>Pack size (optional)</span>
          <input
            className="field"
            type="number"
            min="1"
            placeholder="Units per box"
            value={packSize}
            onChange={(e) => setPackSize(e.target.value)}
          />
        </label>
        <label className="reorder-add-item-field">
          <span>Pack cost (optional)</span>
          <input
            className="field"
            type="text"
            inputMode="decimal"
            placeholder="$0.00"
            value={packCost}
            onChange={(e) => setPackCost(e.target.value)}
            onBlur={(e) => normalizeCurrency(e.target.value, setPackCost)}
          />
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

/** One aggregated search result — collapses per-lot rows that share name +
 *  location into a single entry so items with multiple expiring lots (e.g.
 *  sodium chloride) don't show up repeatedly. When picked, every lot's rowId
 *  is added to the reorder so all lots get stamped as ordered. */
type SearchResult = {
  key: string;
  itemName: string;
  location: string;
  allRowIds: string[];
  representativeRow: InventoryRow;
  totalQty: number;
  minQuantity: number;
  hasLink: boolean;
  reorderLink: string;
};

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
  /** Receives every rowId belonging to the picked item group (all lots), not
   *  just a representative row. Ensures multi-lot items flow through the
   *  existing aggregation path downstream. */
  onPick: (rowIds: string[]) => void;
  onAddNew: () => void;
  onClose: () => void;
  /** When provided, picking an item that has no reorderLink triggers an inline
   *  prompt to add one before the item goes onto the reorder list. The user
   *  can also skip, in which case the item lands in the No-Link card. */
  onSaveReorderLink?: (rowIds: string[], link: string) => Promise<void> | void;
}) {
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState(defaultLocation);
  // When the user picks an unlinked item group, we hold the aggregated result
  // here and show an inline link-prompt form instead of adding immediately.
  const [linkPromptResult, setLinkPromptResult] = useState<SearchResult | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  // Dropdown state — mirrors the ItemAutocomplete pattern used by Log Usage
  // and Fast Restock so the search doesn't hog vertical space.
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = search.trim().toLowerCase();
    // Aggregate rows by itemName + location so multi-lot items (e.g. a reagent
    // with one row per expiration lot) show up once in search. When picked,
    // every lot's rowId gets added to the reorder so all lots stamp as ordered.
    const grouped = new Map<string, SearchResult>();
    for (const row of inventoryRows) {
      if (alreadyPickedRowIds.has(row.id)) continue;
      if (row.values.retiredAt) continue;
      const rowLocation = String(row.values.location ?? "").trim();
      if (location && rowLocation !== location) continue;
      const itemName = String(row.values.itemName ?? "").trim();
      if (!itemName) continue;
      if (q && !itemName.toLowerCase().includes(q)) continue;
      const key = `${itemName}\x00${rowLocation}`;
      const qty = Number.isFinite(Number(row.values.quantity)) ? Number(row.values.quantity) : 0;
      const rowLink = normalizeLinkValue(String(row.values.reorderLink ?? "").trim());
      const minQ = Number(row.values.minQuantity);
      const hasMin = Number.isFinite(minQ) && minQ > 0;
      const existing = grouped.get(key);
      if (existing) {
        existing.allRowIds.push(row.id);
        existing.totalQty += qty;
        // Prefer a row that has a link for the "hasLink" signal / pre-fill.
        if (!existing.reorderLink && rowLink) {
          existing.reorderLink = rowLink;
          existing.hasLink = true;
          existing.representativeRow = row;
        }
        if (hasMin && minQ > existing.minQuantity) existing.minQuantity = minQ;
      } else {
        grouped.set(key, {
          key,
          itemName,
          location: rowLocation,
          allRowIds: [row.id],
          representativeRow: row,
          totalQty: qty,
          minQuantity: hasMin ? minQ : 0,
          hasLink: rowLink !== "",
          reorderLink: rowLink,
        });
      }
    }
    // Limit to first 20 so the panel doesn't explode for huge inventories.
    return Array.from(grouped.values()).slice(0, 20);
  }, [inventoryRows, alreadyPickedRowIds, search, location]);

  // Reset highlight whenever result set or open state changes.
  useEffect(() => {
    setHighlightIndex(-1);
  }, [results.length, open, search]);

  // Keep highlighted option scrolled into view.
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const formatResult = (result: SearchResult) => {
    const qtyLabel = result.minQuantity > 0
      ? `${result.totalQty}/${result.minQuantity}`
      : String(result.totalQty);
    return {
      name: result.itemName,
      qtyLabel,
      loc: result.location,
      hasLink: result.hasLink,
    };
  };

  const handleResultClick = (result: SearchResult) => {
    if (result.hasLink) {
      onPick(result.allRowIds);
      // Clear search so the user can pick the next item without having to
      // manually delete the previous query — mirrors the Log Usage pattern.
      setSearch("");
      setOpen(false);
      inputRef.current?.focus();
      return;
    }
    // No link — open the inline link prompt before adding.
    setLinkPromptResult(result);
    setLinkDraft("");
    setOpen(false);
  };

  const handleSkipLink = () => {
    if (!linkPromptResult) return;
    onPick(linkPromptResult.allRowIds);
    setLinkPromptResult(null);
    setLinkDraft("");
    setSearch("");
    inputRef.current?.focus();
  };

  const handleSaveLinkAndAdd = async () => {
    if (!linkPromptResult) return;
    const trimmed = linkDraft.trim();
    if (!trimmed) {
      // Empty = same as skip.
      handleSkipLink();
      return;
    }
    if (onSaveReorderLink) {
      setSavingLink(true);
      try {
        // Save the link across every lot so future aggregation keeps them
        // together under the same vendor card.
        await onSaveReorderLink(linkPromptResult.allRowIds, normalizeLinkValue(trimmed));
      } finally {
        setSavingLink(false);
      }
    }
    onPick(linkPromptResult.allRowIds);
    setLinkPromptResult(null);
    setLinkDraft("");
    setSearch("");
    inputRef.current?.focus();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && results[highlightIndex]) {
        handleResultClick(results[highlightIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showDropdown = open && !linkPromptResult && results.length > 0;

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
        <div className="order-builder-field order-builder-field--search">
          <span>Search inventory</span>
          {/* Autocomplete-style search: dropdown only appears while focused,
           *  matches the Log Usage / Fast Restock pattern so the panel
           *  doesn't consume a ton of vertical space when idle. */}
          <div className="order-builder-autocomplete" ref={wrapRef}>
            <input
              ref={inputRef}
              className="field order-builder-autocomplete-input"
              type="text"
              placeholder="Search items…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
              /* Match Log Usage: clicking the input opens the dropdown,
               * showing the user the available items immediately. We
               * deliberately don't autoFocus on mount so it only opens
               * when the user clicks in. */
              onFocus={() => setOpen(true)}
              onKeyDown={onInputKeyDown}
              role="combobox"
              aria-expanded={showDropdown}
              aria-autocomplete="list"
              autoComplete="off"
            />
            {search && (
              <button
                type="button"
                className="order-builder-autocomplete-clear"
                onClick={() => {
                  setSearch("");
                  setOpen(false);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            )}
            {showDropdown && (
              <ul
                className="order-builder-autocomplete-list"
                ref={listRef}
                role="listbox"
              >
                {results.map((result, i) => {
                  const { name, qtyLabel, loc, hasLink } = formatResult(result);
                  return (
                    <li
                      key={result.key}
                      className={`order-builder-autocomplete-option${i === highlightIndex ? " order-builder-autocomplete-option--hl" : ""}`}
                      role="option"
                      aria-selected={i === highlightIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => handleResultClick(result)}
                    >
                      <span className="order-builder-autocomplete-option-name">
                        {name}
                      </span>
                      <span className="order-builder-autocomplete-option-meta">
                        qty {qtyLabel}
                        {loc && ` · ${loc}`}
                        {!hasLink && (
                          <span className="order-builder-result-nolink">
                            <Link2Off size={11} /> No link
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {open && !linkPromptResult && results.length === 0 && (
              <div className="order-builder-autocomplete-empty">
                {search.trim()
                  ? "No matching items in this location."
                  : "Start typing to search inventory…"}
              </div>
            )}
          </div>
        </div>
      </div>
      {linkPromptResult ? (
        <div className="order-builder-link-prompt">
          <div className="order-builder-link-prompt-head">
            <Link2Off size={16} />
            <span>
              <strong>{linkPromptResult.itemName || "This item"}</strong>{" "}
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
                setLinkPromptResult(null);
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

// ── VendorChecklistCard ──────────────────────────────────────────────────────

type LineState = {
  rowId: string;
  allRowIds: string[];
  name: string;
  link: string;
  checked: boolean;
  qty: string;
};

/** Stable identity key for an item across renders — matches the aggregation
 *  key used when building vendor groups so checked/qty state survives filter
 *  changes and any in-place row churn. */
const itemStateKey = (item: ReorderItem): string => {
  const location = String(item.row.values.location ?? "").trim();
  return `${item.itemName}\x00${location}`;
};

function VendorChecklistCard({
  group,
  checkedKeys,
  qtyDrafts,
  onToggleChecked,
  onSetQty,
  onMarkOrdered,
  onRemoveExtra,
}: {
  group: VendorGroup;
  /** Set of item-state keys the user has checked. Lifted to ReorderTab so the
   *  state persists across list-filter renders (previously held locally, which
   *  reset the moment a search narrowed this card's items). */
  checkedKeys: Set<string>;
  /** Per-item qty overrides keyed by item-state key. Falls back to each item's
   *  suggestedQty when absent. */
  qtyDrafts: Record<string, string>;
  onToggleChecked: (key: string) => void;
  onSetQty: (key: string, qty: string) => void;
  onMarkOrdered: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
  /** Called when the user removes an extra-picked item (non-low item they
   *  added via the OrderBuilderPanel) from the reorder list. */
  onRemoveExtra?: (rowId: string) => void;
}) {
  const lines: LineState[] = group.items.map((item) => {
    const key = itemStateKey(item);
    return {
      rowId: item.row.id,
      allRowIds: item.allRowIds,
      name: item.itemName,
      link: item.reorderLink,
      checked: checkedKeys.has(key),
      qty: qtyDrafts[key] ?? String(item.suggestedQty),
    };
  });

  const keyForRowId = (rowId: string): string | null => {
    const item = group.items.find((i) => i.row.id === rowId);
    return item ? itemStateKey(item) : null;
  };

  const toggleLine = (rowId: string) => {
    const key = keyForRowId(rowId);
    if (key) onToggleChecked(key);
  };

  const updateLineQty = (rowId: string, qty: string) => {
    const key = keyForRowId(rowId);
    if (key) onSetQty(key, qty);
  };

  const markLineChecked = (rowId: string) => {
    const key = keyForRowId(rowId);
    if (key && !checkedKeys.has(key)) onToggleChecked(key);
  };

  const checkedCount = lines.filter((l) => l.checked).length;

  // Running subtotal across checked lines (inventory items with a known
  // unit cost). Items without a unit cost are counted separately so the
  // subtotal line can note "(+N without price)" for transparency.
  const checkedSubtotal = lines.reduce((sum, line) => {
    if (!line.checked) return sum;
    const item = group.items.find((i) => i.row.id === line.rowId);
    if (!item || item.unitCost === null) return sum;
    const qty = Math.max(0, Number(line.qty) || 0);
    return sum + item.unitCost * qty;
  }, 0);
  const unpricedCount = lines.filter((line) => {
    if (!line.checked) return false;
    const item = group.items.find((i) => i.row.id === line.rowId);
    return !item || item.unitCost === null;
  }).length;

  // Sort: checked items first, then unchecked, alphabetical within each.
  // Keeps the list coherent when the user narrows with the name filter —
  // previously their checks were scattered among unchecked items.
  const orderedLines = [...lines].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const handlePlaceOrder = () => {
    const inventoryItems = lines
      .filter((l) => l.checked)
      .map((l) => ({
        rowId: l.rowId,
        name: l.name,
        qty: Math.max(1, Number(l.qty) || 1),
      }));
    // Use allRowIds so every lot in the group gets stamped as ordered.
    const checkedRowIds = lines.filter((l) => l.checked).flatMap((l) => l.allRowIds);
    onMarkOrdered(checkedRowIds, group.domain, inventoryItems);
  };

  return (
    <div className="reorder-vendor-card app-card">
      <div className="reorder-vendor-header">
        <div className="reorder-vendor-info">
          <h4 className="reorder-vendor-name">{group.domain}</h4>
          <span className="reorder-vendor-count">
            {group.items.length} item{group.items.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="checklist-items checklist-items--inline">
        <div className="checklist-items-header">
          <div className="checklist-cell checklist-cell--checkbox" />
          <div className="checklist-cell">Item</div>
          <div className="checklist-cell">Qty</div>
        </div>

        {orderedLines.map((line) => {
          const itemData = group.items.find((i) => i.row.id === line.rowId);
          const isExtra = itemData?.isExtra === true;
          return (
            <div key={line.rowId} className={`checklist-item checklist-item--form${line.checked ? " checked" : ""}${isExtra ? " checklist-item--extra" : ""}`}>
              <div className="checklist-cell checklist-cell--checkbox">
                <button
                  type="button"
                  className={`checklist-checkbox${line.checked ? " checked" : ""}`}
                  onClick={() => toggleLine(line.rowId)}
                  aria-label={line.checked ? `Uncheck ${line.name}` : `Check ${line.name}`}
                >
                  {line.checked && <Check size={14} />}
                </button>
              </div>
              <div className="checklist-cell">
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
              </div>
              <div className="checklist-cell">
                <input
                  className="field checklist-qty-field"
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => updateLineQty(line.rowId, e.target.value)}
                />
              </div>
            </div>
          );
        })}
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
        <div className="reorder-nolink-header">
          <div className="checklist-cell">Item</div>
          <div className="checklist-cell">Vendor link</div>
          <div className="checklist-cell" />
        </div>
        {items.map((item) => {
          const value = linkInputs[item.row.id] ?? "";
          const saving = savingId === item.row.id;
          return (
            <div key={item.row.id} className={`reorder-nolink-row${item.isExtra ? " reorder-nolink-row--extra" : ""}`}>
              <div className="checklist-cell">
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
              </div>
              <div className="checklist-cell">
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
              </div>
              <div className="checklist-cell">
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

    // Alphabetize items within each vendor group so the reorder checklist has
    // a predictable order — otherwise rows come out in Map insertion order
    // which has no meaning to the user.
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });

    const groups: VendorGroup[] = Array.from(domainMap.entries())
      .map(([domain, items]) => ({ domain, items: [...items].sort(nameCompare) }))
      .sort((a, b) => b.items.length - a.items.length);

    noLink.sort(nameCompare);

    return { vendorGroups: groups, noLinkItems: noLink };
  }, [rows]);

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
    // Group picked rows by itemName + location so a multi-lot item (e.g. one
    // with an expiration date and multiple lots) renders as a single reorder
    // entry — same aggregation rule as low-stock items.
    type PickedAgg = {
      rows: InventoryRow[];
      itemName: string;
      location: string;
      reorderLink: string;
      minQuantity: number;
      unitCost: number | null;
    };
    const pickedMap = new Map<string, PickedAgg>();
    const pickedIdSet = new Set(extraPickRowIds);
    for (const row of rows) {
      if (!pickedIdSet.has(row.id)) continue;
      if (alreadyCoveredRowIds.has(row.id)) continue;
      const itemName = String(row.values.itemName ?? "").trim() || `Item ${row.id.slice(0, 8)}`;
      const rowLocation = String(row.values.location ?? "").trim();
      const key = `${itemName}\x00${rowLocation}`;
      const rowLink = normalizeLinkValue(String(row.values.reorderLink ?? "").trim());
      const minQuantity = Number(row.values.minQuantity);
      const hasMin = Number.isFinite(minQuantity) && minQuantity > 0;
      const packCost = Number(row.values.packCost);
      const packSize = Number(row.values.packSize);
      const storedUnit = Number(row.values.unitCost);
      let unitCost: number | null = null;
      if (Number.isFinite(packCost) && Number.isFinite(packSize) && packSize > 0) {
        unitCost = packCost / packSize;
      } else if (Number.isFinite(storedUnit) && storedUnit >= 0) {
        unitCost = storedUnit;
      }
      const existing = pickedMap.get(key);
      if (existing) {
        existing.rows.push(row);
        if (!existing.reorderLink && rowLink) existing.reorderLink = rowLink;
        if (hasMin && minQuantity > existing.minQuantity) existing.minQuantity = minQuantity;
        if (existing.unitCost === null && unitCost !== null) existing.unitCost = unitCost;
      } else {
        pickedMap.set(key, {
          rows: [row],
          itemName,
          location: rowLocation,
          reorderLink: rowLink,
          minQuantity: hasMin ? minQuantity : 0,
          unitCost,
        });
      }
    }
    const out: ReorderItem[] = [];
    for (const agg of pickedMap.values()) {
      // Representative row — prefer a non-expired row with the lowest qty.
      const activeRows = agg.rows.filter((r) => {
        const d = getDaysUntilExpiration(r.values.expirationDate);
        return d === null || d >= 0;
      });
      const candidateRows = activeRows.length > 0 ? activeRows : agg.rows;
      const repRow = candidateRows.reduce((best, r) =>
        Number(r.values.quantity ?? 0) < Number(best.values.quantity ?? 0) ? r : best,
      );
      const activeQty = agg.rows.reduce((sum, r) => {
        const qty = Number.isFinite(Number(r.values.quantity)) ? Number(r.values.quantity) : 0;
        const d = getDaysUntilExpiration(r.values.expirationDate);
        const isExpired = d !== null && d < 0;
        return isExpired ? sum : sum + qty;
      }, 0);
      out.push({
        row: repRow,
        allRowIds: agg.rows.map((r) => r.id),
        itemName: agg.itemName,
        reorderLink: agg.reorderLink,
        activeQty,
        expiredQty: 0,
        minQuantity: agg.minQuantity,
        suggestedQty: 1, // default 1 for proactive picks
        hasExpired: false,
        orderedAt: null,
        unitCost: agg.unitCost,
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
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });
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
    // Re-sort each group so extras slot into alphabetical position instead of
    // appending at the end of the list.
    for (const g of cloned) g.items.sort(nameCompare);
    return cloned;
  }, [vendorGroups, extraPickedItems]);

  const noLinkItemsWithExtras = useMemo<ReorderItem[]>(() => {
    const extras = extraPickedItems.filter((i) => !i.reorderLink);
    if (extras.length === 0) return noLinkItems;
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });
    return [...noLinkItems, ...extras].sort(nameCompare);
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

  const handlePickExtra = (rowIds: string[]) => {
    setExtraPickRowIds((prev) => {
      const toAdd = rowIds.filter((id) => !prev.includes(id));
      return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
    });
  };

  const handleRemoveExtra = (rowId: string) => {
    setExtraPickRowIds((prev) => prev.filter((id) => id !== rowId));
  };

  // Checked state persists across list-filter renders (previously held inside
  // each VendorChecklistCard, which remounted when filter changed). Keyed by
  // the item-state key (itemName + location) so it survives lot churn too.
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});

  const toggleCheckedKey = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setQtyForKey = (key: string, qty: string) => {
    setQtyDrafts((prev) => ({ ...prev, [key]: qty }));
  };

  // Combine real vendor groups with synthetic groups for raw lines whose link
  // points to a domain that isn't already in the reorder list (or to a brand
  // Called from the top-level "Add Item Not Listed" form. Persists as a real
  // inventory row via the parent's onAddItem callback so the entry survives
  // reload; also seeds the checked/qty state so the newly-added row is
  // pre-selected in its vendor card.
  const handleAddItem = async (input: AddItemInput) => {
    const result = await onAddItem?.(input);
    if (!result) return;
    const locationKey = result.location.trim();
    const key = `${result.itemName.trim()}\x00${locationKey}`;
    setCheckedKeys((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    if (input.qty.trim()) {
      setQtyDrafts((prev) => ({ ...prev, [key]: input.qty.trim() }));
    }
  };

  // Wraps onMarkOrdered so we also clear checked / qty state for the items
  // that just went onto the order. If those items come back later (via
  // cancel or receive-and-close), they should start unchecked again.
  const handleMarkOrderedForVendor = (rowIds: string[], vendor: string, orderItems: OrderItem[]) => {
    onMarkOrdered?.(rowIds, vendor, orderItems);
    // Compute the item-state keys for rows just ordered so we can drop them
    // from checked/qty maps. We pull from the current vendorGroupsWithExtras
    // since that's what the card was rendering.
    const clearedKeys = new Set<string>();
    const orderedRowSet = new Set(rowIds);
    for (const g of vendorGroupsWithExtras) {
      for (const item of g.items) {
        if (item.allRowIds.some((id) => orderedRowSet.has(id))) {
          clearedKeys.add(itemStateKey(item));
        }
      }
    }
    if (clearedKeys.size > 0) {
      setCheckedKeys((prev) => {
        const next = new Set(prev);
        clearedKeys.forEach((k) => next.delete(k));
        return next;
      });
      setQtyDrafts((prev) => {
        const next = { ...prev };
        clearedKeys.forEach((k) => delete next[k]);
        return next;
      });
    }
    // Also drop extra-picked row IDs so those items don't linger in state after
    // being ordered (they'd otherwise reappear if a cancellation/receive put
    // them back on the list).
    setExtraPickRowIds((prev) => prev.filter((id) => !orderedRowSet.has(id)));
  };

  const totalReorderItems = vendorGroupsWithExtras.reduce((sum, g) => sum + g.items.length, 0);
  const isEmpty = totalReorderItems === 0 && noLinkItemsWithExtras.length === 0;

  // Filter the reorder list by item name. Vendor groups that end up with no
  // matching items are hidden entirely. Applies to extras + low-stock +
  // no-link so one input covers the whole page.
  const [listFilter, setListFilter] = useState("");
  const filterQ = listFilter.trim().toLowerCase();
  const matchesFilter = (name: string) =>
    !filterQ || name.toLowerCase().includes(filterQ);

  const filteredVendorGroups = useMemo<VendorGroup[]>(() => {
    if (!filterQ) return vendorGroupsWithExtras;
    return vendorGroupsWithExtras
      .map((g) => ({ domain: g.domain, items: g.items.filter((i) => matchesFilter(i.itemName)) }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorGroupsWithExtras, filterQ]);

  const filteredNoLinkItems = useMemo<ReorderItem[]>(() => {
    if (!filterQ) return noLinkItemsWithExtras;
    return noLinkItemsWithExtras.filter((i) => matchesFilter(i.itemName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noLinkItemsWithExtras, filterQ]);

  const filteredTotalItems = filteredVendorGroups.reduce((sum, g) => sum + g.items.length, 0)
    + filteredNoLinkItems.length;
  const hasFilterActive = filterQ.length > 0;

  // Estimated total to reorder everything in the list at the suggested qty.
  // Items without a known price are skipped; we count those separately so
  // the user sees what's missing.
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
          <div className="reorder-header-titlerow">
            <h3 className="reorder-title">
              Reorder
              {totalReorderItems > 0 && (
                <span className="reorder-count-badge">{totalReorderItems}</span>
              )}
            </h3>
            {!isEmpty && (
              <span className="reorder-subtitle">
                {vendorGroupsWithExtras.length} vendor{vendorGroupsWithExtras.length !== 1 ? "s" : ""}
                {noLinkItemsWithExtras.length > 0 && ` · ${noLinkItemsWithExtras.length} missing link${noLinkItemsWithExtras.length !== 1 ? "s" : ""}`}
              </span>
            )}
          </div>
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
        {(!isEmpty || (!showOrderBuilder && !showAddForm)) && (
          <div className="reorder-header-right">
            {!isEmpty && (
              <div className="reorder-list-filter inventory-search-wrap">
                <input
                  className="inventory-search-input"
                  type="search"
                  placeholder="Search items..."
                  value={listFilter}
                  onChange={(e) => setListFilter(e.target.value)}
                  aria-label="Search reorder list"
                />
                {listFilter && (
                  <button
                    type="button"
                    className="inventory-search-clear"
                    onClick={() => setListFilter("")}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            {!showOrderBuilder && !showAddForm && (
              <button
                type="button"
                className="button button-secondary button-sm reorder-add-item-btn"
                onClick={() => setShowOrderBuilder(true)}
              >
                <Plus size={13} /> Add Items
              </button>
            )}
          </div>
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
          onAdd={handleAddItem}
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

      {hasFilterActive && filteredTotalItems === 0 && !isEmpty && (
        <p className="reorder-filter-empty">
          No items in your reorder list match "{listFilter}".
        </p>
      )}

      {filteredVendorGroups.map((group) => (
        <VendorChecklistCard
          key={group.domain}
          group={group}
          checkedKeys={checkedKeys}
          qtyDrafts={qtyDrafts}
          onToggleChecked={toggleCheckedKey}
          onSetQty={setQtyForKey}
          onMarkOrdered={handleMarkOrderedForVendor}
          onRemoveExtra={handleRemoveExtra}
        />
      ))}

      {filteredNoLinkItems.length > 0 && (
        <NoLinkCard
          items={filteredNoLinkItems}
          onSaveReorderLink={onSaveReorderLink}
          onRemoveExtra={handleRemoveExtra}
        />
      )}
    </div>
  );
}
