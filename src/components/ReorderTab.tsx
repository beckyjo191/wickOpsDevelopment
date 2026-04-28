import { useEffect, useMemo, useRef, useState } from "react";
import type { InventoryRow } from "../lib/inventoryApi";
import { formatCurrency, parseCurrency } from "../lib/currency";
import { Check, ExternalLink, Link2Off, Minus, Package, Plus, Save, X } from "lucide-react";

// ── Reorder-selection persistence ───────────────────────────────────────
// Stored in localStorage so a reload mid-cart doesn't wipe the user's
// checkboxes, qty overrides, or extra picks. Keys are itemName+location
// (already stable across lot churn), plus rowIds for extra picks. We don't
// scope by org: mismatched keys after an org switch simply don't match any
// rendered item, so they're inert — the Mark-as-Ordered path prunes the
// ones that get used.

type PersistedReorderState = {
  checked: string[];
  qty: Record<string, string>;
  extras: string[];
};

const REORDER_STATE_STORAGE_KEY = "wickops.reorder.state.v1";

const EMPTY_REORDER_STATE: PersistedReorderState = {
  checked: [],
  qty: {},
  extras: [],
};

function readPersistedReorderState(): PersistedReorderState {
  if (typeof window === "undefined") return EMPTY_REORDER_STATE;
  try {
    const raw = window.localStorage.getItem(REORDER_STATE_STORAGE_KEY);
    if (!raw) return EMPTY_REORDER_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedReorderState>;
    return {
      checked: Array.isArray(parsed.checked) ? parsed.checked.filter((k): k is string => typeof k === "string") : [],
      qty: parsed.qty && typeof parsed.qty === "object"
        ? Object.fromEntries(
            Object.entries(parsed.qty).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>
        : {},
      extras: Array.isArray(parsed.extras) ? parsed.extras.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return EMPTY_REORDER_STATE;
  }
}

function writePersistedReorderState(state: PersistedReorderState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REORDER_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled — degrade silently.
  }
}

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
  vendor: string;
};

interface ReorderTabProps {
  rows: InventoryRow[];
  availableLocations?: string[];
  availableVendors?: string[];
  /** Add a vendor to the org registry from inside the Reorder UI (Missing
   *  Info dropdown / bulk toolbar). Parent is responsible for refreshing
   *  `availableVendors` so the new entry appears in the dropdown. */
  onAddVendor?: (name: string) => Promise<void>;
  selectedLocation?: string | null;
  /** Patch values on one or more inventory rows. Used by the Missing
   *  Information card to fill in `vendor` / `unitCost` / `packCost` /
   *  `packSize`. Same patch is applied to every rowId. */
  onSaveItemFields?: (rowIds: string[], patch: Record<string, string | number | boolean | null>) => Promise<void> | void;
  /** Surface the current reorder-list size to the parent so the Orders tab
   *  bar can render a count badge consistent with Pending Receipt / Closed
   *  Orders. Fires whenever the count changes (including → 0). */
  onCountChange?: (count: number) => void;
  /** Per-vendor "Mark as Ordered" handoff — the user has reviewed the
   *  suggested items and qtys inside a vendor card and wants to commit.
   *  Stamps orderedAt on the rows AND creates a RestockOrder in pending
   *  state. The New Order tab covers the freeform + cross-vendor cases. */
  onMarkOrdered?: (rowIds: string[], vendor: string, orderItems: OrderItem[]) => void;
}

type ReorderItem = {
  row: InventoryRow;        // representative row (lowest active qty)
  allRowIds: string[];      // all row IDs in this name+location group
  itemName: string;
  reorderLink: string;
  /** Vendor name from item.values.vendor (empty when unassigned). When set,
   *  this is the primary grouping key; reorderLink domain is the fallback. */
  vendor: string;
  activeQty: number;        // non-expired qty summed across all rows
  expiredQty: number;       // expired qty summed across all rows
  minQuantity: number;
  // Suggested order quantity. Denominated in BOXES when packSize > 0, else
  // units. Input qty (user-edited on the checklist) follows the same denom.
  suggestedQty: number;
  hasExpired: boolean;
  orderedAt: string | null; // most recent orderedAt across all rows
  // Per-unit price: prefers packCost / packSize when both are set, falls back
  // to the row's stored unitCost. Null when we have no price data at all.
  unitCost: number | null;
  // Units per box. 0 means the item is not pack-based — qty/display stays in
  // units. >0 flips the UI into box-denominated mode for suggest, input,
  // subtotal, and order submission (where we multiply back to units).
  packSize: number;
  // True when the user added this item via the "Add Items" panel (not flagged
  // as low by the auto-reorder logic). Pre-checked in the vendor card so it
  // rolls into Mark-as-Ordered alongside low-stock items.
  isExtra?: boolean;
};

type VendorGroup = {
  /** Vendor name — also serves as the display label and React key. */
  label: string;
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
  // Parse bare YYYY-MM-DD as local date components — `new Date("2026-04-28")`
  // would otherwise be UTC midnight, which reads back as the prior day in any
  // timezone west of UTC and skews the day-difference by one.
  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = isoDateOnly
    ? new Date(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]))
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.floor((targetStart - todayStart) / (1000 * 60 * 60 * 24));
};

// ── Top-level "Add Item Not Listed" form ───────────────────────────────────

function AddItemCard({
  availableLocations,
  availableVendors,
  defaultLocation,
  defaultVendor,
  onAdd,
  onClose,
  onBack,
}: {
  availableLocations: string[];
  availableVendors: string[];
  defaultLocation: string;
  defaultVendor: string;
  onAdd: (input: {
    name: string;
    link: string;
    qty: string;
    minQty: string;
    unitCost: string;
    packSize: string;
    packCost: string;
    location: string;
    vendor: string;
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
  const [vendor, setVendor] = useState(defaultVendor);
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
    onAdd({ name, link, qty, minQty, unitCost, packSize, packCost, location, vendor });
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
          <span>Vendor (optional)</span>
          <select
            className="field"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          >
            <option value="">Unassigned</option>
            {availableVendors.map((v) => (
              <option key={v} value={v}>
                {v}
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
  onSaveItemFields,
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
   *  can also skip, in which case the item lands in the Missing Information
   *  card. Generic patch shape — link prompt sends `{ reorderLink }`. */
  onSaveItemFields?: (rowIds: string[], patch: Record<string, string | number | boolean | null>) => Promise<void> | void;
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
    if (onSaveItemFields) {
      setSavingLink(true);
      try {
        // Save the link across every lot so future aggregation keeps them
        // together under the same vendor card.
        await onSaveItemFields(linkPromptResult.allRowIds, {
          reorderLink: normalizeLinkValue(trimmed),
        });
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
  onSetManyChecked,
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
  /** Bulk-toggle for the "check all" checkbox at the top of the card. Single
   *  state update for N items so we don't queue N renders on click. */
  onSetManyChecked: (keys: string[], checked: boolean) => void;
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
  // For pack items, input qty is in boxes — convert to units before applying
  // the per-unit cost so the subtotal reflects actual spend.
  const checkedSubtotal = lines.reduce((sum, line) => {
    if (!line.checked) return sum;
    const item = group.items.find((i) => i.row.id === line.rowId);
    if (!item || item.unitCost === null) return sum;
    const qtyRaw = Math.max(0, Number(line.qty) || 0);
    const qtyUnits = item.packSize > 0 ? qtyRaw * item.packSize : qtyRaw;
    return sum + item.unitCost * qtyUnits;
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
    // Input qty is in boxes for pack items, units otherwise. The order is
    // always stored in units, so convert here before handing off.
    const inventoryItems = lines
      .filter((l) => l.checked)
      .map((l) => {
        const item = group.items.find((i) => i.row.id === l.rowId);
        const packSize = item?.packSize ?? 0;
        const qtyRaw = Math.max(1, Number(l.qty) || 1);
        const qtyUnits = packSize > 0 ? qtyRaw * packSize : qtyRaw;
        return { rowId: l.rowId, name: l.name, qty: qtyUnits };
      });
    // Use allRowIds so every lot in the group gets stamped as ordered.
    const checkedRowIds = lines.filter((l) => l.checked).flatMap((l) => l.allRowIds);
    onMarkOrdered(checkedRowIds, group.label, inventoryItems);
  };

  return (
    <div className="reorder-vendor-card app-card">
      <div className="reorder-vendor-header">
        <div className="reorder-vendor-info">
          <h4 className="reorder-vendor-name">{group.label}</h4>
          <span className="reorder-vendor-count">
            {group.items.length} item{group.items.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Selection summary + Mark as Ordered. Sits above the item list so
       *  the action button is visible without scrolling once the user has
       *  checked items in a long vendor group. */}
      {checkedCount > 0 && (
        <div className="checklist-done-banner checklist-done-banner--inline checklist-done-banner--top">
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

      <div className="checklist-items checklist-items--inline">
        {/* Column header. The first cell carries a check-all checkbox that
         *  toggles every item in this vendor at once. Three visual states:
         *  empty → indeterminate (some checked) → all-checked. Click cycles
         *  empty/partial → all-checked → cleared. */}
        <div className="checklist-items-header">
          <div className="checklist-cell checklist-cell--checkbox">
            {lines.length > 0 && (() => {
              const allKeys = lines
                .map((l) => keyForRowId(l.rowId))
                .filter((k): k is string => k !== null);
              const allChecked = checkedCount === lines.length;
              const someChecked = checkedCount > 0 && !allChecked;
              return (
                <button
                  type="button"
                  className={`checklist-checkbox checklist-checkbox--checkall${
                    allChecked ? " checked" : someChecked ? " indeterminate" : ""
                  }`}
                  onClick={() => onSetManyChecked(allKeys, !allChecked)}
                  aria-label={allChecked ? "Uncheck all items" : "Check all items"}
                  aria-pressed={allChecked}
                >
                  {allChecked ? <Check size={14} /> : someChecked ? <Minus size={14} /> : null}
                </button>
              );
            })()}
          </div>
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
                    target={`wickops-vendor-${group.label}`}
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      // iOS Safari ignores <a target="name"> reuse and opens
                      // a fresh tab per click, which means ordering 20 items
                      // from one vendor leaves 20 tabs to clean up. Taking
                      // over the click with window.open and the same target
                      // name reliably funnels every subsequent click in this
                      // vendor card into the already-open tab — works the
                      // same on desktop, so we do it unconditionally.
                      // Modifier keys (cmd/ctrl/middle-click) are left alone
                      // so power users can still fan out intentionally.
                      if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                        e.preventDefault();
                        window.open(
                          normalizeLinkValue(line.link),
                          `wickops-vendor-${group.label}`,
                          "noopener",
                        );
                      }
                      markLineChecked(line.rowId);
                    }}
                    title={`Open ${line.name} on ${group.label}`}
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
                          {itemData.packSize > 0
                            ? `${formatCurrency(itemData.unitCost * itemData.packSize)}/box`
                            : `${formatCurrency(itemData.unitCost)}/unit`}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
              <div className="checklist-cell">
                <div className="checklist-qty-wrap">
                  <input
                    className="field checklist-qty-field"
                    type="number"
                    min="1"
                    placeholder="Qty"
                    value={line.qty}
                    onChange={(e) => updateLineQty(line.rowId, e.target.value)}
                  />
                  {itemData && itemData.packSize > 0 && (
                    <span className="checklist-qty-unit">
                      box{Number(line.qty) === 1 ? "" : "es"}
                      <span className="checklist-qty-unit-detail">
                        {" "}({itemData.packSize} ea)
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── VendorSelect ─────────────────────────────────────────────────────────────

/** Domain → vendor-name suggestion. Strips "www." and the TLD, then
 *  TitleCases the first character. boundtree.com → BoundTree (the user can
 *  edit before saving; this is a soft suggestion only). */
const suggestVendorNameFromUrl = (url: string): string => {
  const domain = getVendorDomain(url);
  if (!domain) return "";
  const stem = domain.replace(/^www\./, "").split(".")[0] ?? "";
  if (!stem) return "";
  return stem.charAt(0).toUpperCase() + stem.slice(1);
};

/** Vendor picker used in the Missing Info card (per-row + bulk toolbar) and
 *  the compose panel. Same autocomplete pattern as the inventory item
 *  picker: type-ahead filter with a dropdown of existing vendors, plus a
 *  "+ Add 'X' as new vendor" sentinel when the typed text doesn't match.
 *  Selecting freeform calls onAddVendor (which the parent uses to call the
 *  vendor registry API) then onChange with the new name.
 *
 *  When `value` is set, the input renders as readonly showing the selected
 *  vendor with an × clear button — mirrors the Log Usage item autocomplete. */
export function VendorSelect({
  value,
  availableVendors,
  onChange,
  onAddVendor,
  disabled,
  className,
  ariaLabel,
  placeholder,
}: {
  value: string;
  availableVendors: string[];
  onChange: (next: string) => void;
  onAddVendor?: (name: string) => Promise<void>;
  /** No longer used — kept in the signature for back-compat with call sites
   *  that pass `suggestedName`. The autocomplete now lets users type any
   *  starting text directly. */
  suggestedName?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [adding, setAdding] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  type VendorOption =
    | { kind: "existing"; key: string; name: string }
    | { kind: "freeform"; key: string; text: string };

  const options = useMemo<VendorOption[]>(() => {
    const q = search.trim().toLowerCase();
    const matches = availableVendors
      .filter((v) => !q || v.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const out: VendorOption[] = matches.map((v) => ({ kind: "existing", key: `existing:${v}`, name: v }));
    if (q && onAddVendor) {
      const exact = availableVendors.some((v) => v.toLowerCase() === q);
      if (!exact) out.push({ kind: "freeform", key: `freeform:${q}`, text: search.trim() });
    }
    return out;
  }, [availableVendors, search, onAddVendor]);

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

  const selectExisting = (name: string) => {
    onChange(name);
    setSearch("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const selectFreeform = async (name: string) => {
    if (!onAddVendor) return;
    setAdding(true);
    try {
      await onAddVendor(name);
      onChange(name);
      setSearch("");
      setOpen(false);
      inputRef.current?.blur();
    } catch (err) {
      // Surface error inline by leaving the input populated; the user can
      // retry. We don't show an inline error message — keeps the UI tight.
      console.error("Failed to add vendor", err);
    } finally {
      setAdding(false);
    }
  };

  const selectOption = (opt: VendorOption) => {
    if (opt.kind === "existing") selectExisting(opt.name);
    else void selectFreeform(opt.text);
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

  const showDropdown = open && !value && options.length > 0;
  const isDisabled = disabled || adding;
  const wrapClass = `usage-autocomplete vendor-autocomplete${className ? ` ${className}` : ""}`;

  return (
    <div className={wrapClass} ref={wrapRef}>
      <div className="usage-autocomplete-input-wrap">
        <input
          ref={inputRef}
          type="text"
          className="usage-autocomplete-input"
          value={value || search}
          onChange={(e) => {
            if (value) {
              // Editing while a vendor is set clears the selection so the
              // user can pick (or add) a new one without an extra step.
              onChange("");
            }
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => { if (!value) setOpen(true); }}
          onKeyDown={onKeyDown}
          disabled={isDisabled}
          placeholder={placeholder ?? "Choose a vendor"}
          readOnly={!!value}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoComplete="off"
        />
        {(value || search) && (
          <button
            type="button"
            className="usage-autocomplete-clear"
            onClick={() => {
              onChange("");
              setSearch("");
              inputRef.current?.focus();
              setOpen(true);
            }}
            disabled={isDisabled}
            aria-label="Clear vendor"
          >
            ×
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
                <span className="usage-autocomplete-option-name">+ Add "{opt.text}" as new vendor</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── VendorSummaryCard ────────────────────────────────────────────────────────

/** Vendor card for the Reorder dashboard: a tight table of low/expired items
 *  with each name linked to the product URL (so users can open the vendor
 *  page in a click), plus a single "Order →" CTA in the header that hands
 *  off to the compose panel pre-filled. The card is read-only — quantity
 *  and price editing live in the compose panel. */
function VendorSummaryCard({
  group,
  onOrder,
}: {
  group: VendorGroup;
  onOrder: () => void;
}) {
  const itemCount = group.items.length;
  const estimatedTotal = group.items.reduce((sum, item) => {
    if (item.unitCost === null) return sum;
    const qtyUnits = item.packSize > 0 ? item.suggestedQty * item.packSize : item.suggestedQty;
    return sum + item.unitCost * qtyUnits;
  }, 0);

  // Stable target name so multiple link clicks within the same vendor
  // funnel into one tab (matches the prior VendorChecklistCard behavior).
  const tabTarget = `wickops-vendor-${group.label}`;

  return (
    <div className="vendor-summary-card reorder-vendor-card app-card">
      <div className="vendor-summary-header">
        <div className="vendor-summary-meta">
          <h4 className="vendor-summary-name">{group.label}</h4>
          <span className="vendor-summary-sub">
            {itemCount} item{itemCount !== 1 ? "s" : ""}
            {estimatedTotal > 0 ? (
              <>
                {" · "}
                <span className="vendor-summary-estimate">
                  Est. <strong>{formatCurrency(estimatedTotal)}</strong>
                </span>
              </>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className="button button-primary button-sm vendor-summary-order"
          onClick={onOrder}
        >
          Order →
        </button>
      </div>

      <div className="checklist-items checklist-items--inline vendor-summary-list">
        <div className="checklist-items-header vendor-summary-row">
          <div className="checklist-cell">Item</div>
          <div className="checklist-cell vendor-summary-cell--meta">Suggested</div>
        </div>
        {group.items.map((item) => {
          const lowLabel = item.minQuantity > 0
            ? `Low: ${item.activeQty}/${item.minQuantity}`
            : null;
          const isPack = item.packSize > 0;
          const qtyUnits = isPack ? item.suggestedQty * item.packSize : item.suggestedQty;
          const lineEst = item.unitCost !== null ? item.unitCost * qtyUnits : null;
          const qtyLabel = isPack
            ? `${item.suggestedQty} box${item.suggestedQty !== 1 ? "es" : ""} (${qtyUnits})`
            : `${item.suggestedQty}`;
          const linkHref = item.reorderLink ? normalizeLinkValue(item.reorderLink) : "";
          return (
            <div key={item.row.id} className="checklist-item vendor-summary-row">
              <div className="checklist-cell">
                <div className="checklist-item-info">
                  {linkHref ? (
                    <a
                      className="checklist-item-name"
                      href={linkHref}
                      target={tabTarget}
                      rel="noopener noreferrer"
                      onClick={(e) => {
                        // iOS Safari ignores <a target="name"> reuse and
                        // opens a fresh tab per click. Force-funnel into
                        // one tab via window.open with the same target —
                        // works on desktop too. Modifier keys / middle-
                        // click left alone for power users.
                        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                          e.preventDefault();
                          window.open(linkHref, tabTarget, "noopener");
                        }
                      }}
                      title={`Open ${item.itemName} on ${group.label}`}
                    >
                      {item.itemName}
                      <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="checklist-item-name checklist-item-name--static">
                      {item.itemName}
                    </span>
                  )}
                  {lowLabel ? (
                    <span className="reorder-item-status reorder-status-lowStock">
                      {lowLabel}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="checklist-cell vendor-summary-cell--meta">
                <span className="vendor-summary-qty">{qtyLabel}</span>
                {lineEst !== null ? (
                  <span className="vendor-summary-line-cost">
                    {formatCurrency(lineEst)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MissingInfoCard ──────────────────────────────────────────────────────────

/** Per-row pending price inputs. Vendor saves on selection (no draft needed
 *  — single click is intentional). Price fields (unit cost OR pack
 *  size + pack cost depending on the row's mode) are freeform, so we hold
 *  drafts for them. URL isn't collected here — it's not gating and lives on
 *  the inventory grid. */
type MissingInfoDrafts = {
  unitCost?: string;
  packSize?: string;
  packCost?: string;
};

/** Sticks together items that aren't ready to reorder yet — they're missing
 *  a vendor, a price, or both. Each row collects exactly those two gating
 *  fields; everything else (URL, pack size/cost) is editable from the
 *  inventory grid. Vendor auto-saves on selection; unit cost auto-saves on
 *  blur. Items leave the card as soon as vendor AND price are set. */
function MissingInfoCard({
  items,
  availableVendors,
  onAddVendor,
  onSaveItemFields,
  onRemoveExtra,
}: {
  items: ReorderItem[];
  availableVendors: string[];
  onAddVendor?: (name: string) => Promise<void>;
  onSaveItemFields?: (rowIds: string[], patch: Record<string, string | number | boolean | null>) => Promise<void> | void;
  onRemoveExtra?: (rowId: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, MissingInfoDrafts>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // Per-row pricing mode. Defaults derive from existing row data: any row
  // with a packSize or packCost stored opens in "box" mode so the user sees
  // the inputs they'll actually edit. Toggling here only affects the input
  // shown; saving is what writes the corresponding fields to the row.
  const [priceModeOverrides, setPriceModeOverrides] = useState<Record<string, "unit" | "box">>({});
  const priceModeFor = (item: ReorderItem): "unit" | "box" => {
    const override = priceModeOverrides[item.row.id];
    if (override) return override;
    const packSize = Number(item.row.values.packSize);
    const packCost = Number(item.row.values.packCost);
    if ((Number.isFinite(packSize) && packSize > 0) || (Number.isFinite(packCost) && packCost > 0)) {
      return "box";
    }
    return "unit";
  };
  const setPriceMode = (rowId: string, mode: "unit" | "box") => {
    setPriceModeOverrides((prev) => ({ ...prev, [rowId]: mode }));
  };
  // Multi-select state for bulk vendor assignment. Keyed by row.id so the
  // checkbox stays paired with the rendered row even as the list re-orders.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkVendor, setBulkVendor] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  const visibleIds = items.map((i) => i.row.id);
  // Trim selection set to currently visible rows so a row that left the card
  // (e.g. its vendor just got set, removing it from "missing") doesn't keep
  // its checkbox state in limbo. Also lets the master checkbox reflect what's
  // actually on screen.
  const effectiveSelectedIds = useMemo(
    () => new Set(visibleIds.filter((id) => selectedIds.has(id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, selectedIds],
  );
  const allSelected = visibleIds.length > 0 && effectiveSelectedIds.size === visibleIds.length;
  const someSelected = effectiveSelectedIds.size > 0 && !allSelected;

  const toggleOne = (rowId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) {
        // Deselecting "all" clears just the visible ids, not any stragglers.
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  };

  // Suggest a vendor name for the bulk-add input by looking at the most
  // common link domain across selected items. Falls back to whatever the
  // first selected item has when domains differ. Soft suggestion only.
  const bulkSuggestion = useMemo(() => {
    const selected = items.filter((i) => effectiveSelectedIds.has(i.row.id));
    if (selected.length === 0) return "";
    const counts = new Map<string, number>();
    for (const item of selected) {
      const name = suggestVendorNameFromUrl(item.reorderLink);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    let best = "";
    let bestCount = 0;
    for (const [name, count] of counts) {
      if (count > bestCount) { best = name; bestCount = count; }
    }
    return best;
  }, [items, effectiveSelectedIds]);

  const handleBulkApply = async () => {
    if (!onSaveItemFields || !bulkVendor.trim()) return;
    const selectedItems = items.filter((i) => effectiveSelectedIds.has(i.row.id));
    if (selectedItems.length === 0) return;
    const allRowIds = selectedItems.flatMap((i) => i.allRowIds);
    setBulkSaving(true);
    try {
      await onSaveItemFields(allRowIds, { vendor: bulkVendor.trim() });
      setSelectedIds(new Set());
      setBulkVendor("");
    } finally {
      setBulkSaving(false);
    }
  };

  const updateDraft = (rowId: string, patch: Partial<MissingInfoDrafts>) =>
    setDrafts((prev) => ({ ...prev, [rowId]: { ...(prev[rowId] ?? {}), ...patch } }));

  const rawCurrency = (raw: unknown): string => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? formatCurrency(n) : "";
  };
  const rawNumber = (raw: unknown): string => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? String(n) : "";
  };

  const markSaving = (rowId: string, on: boolean) => {
    setSavingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  };

  const savePatch = async (item: ReorderItem, patch: Record<string, string | number | boolean | null>) => {
    if (!onSaveItemFields || Object.keys(patch).length === 0) return;
    markSaving(item.row.id, true);
    try {
      await onSaveItemFields(item.allRowIds, patch);
    } finally {
      markSaving(item.row.id, false);
    }
  };

  // Vendor saves immediately when the user picks one — selection is a
  // deliberate one-click action, no draft needed.
  const handleVendorChange = async (item: ReorderItem, vendor: string) => {
    await savePatch(item, { vendor });
  };

  // Unit cost saves on blur. Empty input = no change (don't clobber existing
  // values). Non-numeric input is ignored.
  const handlePriceBlur = async (item: ReorderItem) => {
    const raw = (drafts[item.row.id]?.unitCost ?? "").trim();
    if (!raw) return;
    const parsed = parseCurrency(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    await savePatch(item, { unitCost: parsed });
    setDrafts((prev) => ({
      ...prev,
      [item.row.id]: { ...(prev[item.row.id] ?? {}), unitCost: formatCurrency(parsed) },
    }));
  };

  // Pack size / pack cost auto-save on blur (box mode). Each saves
  // independently so the user can fill them in any order; the row exits
  // Missing Info once both are present (derived unitCost > 0).
  const handlePackSizeBlur = async (item: ReorderItem) => {
    const raw = (drafts[item.row.id]?.packSize ?? "").trim();
    if (!raw) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const floored = Math.floor(parsed);
    await savePatch(item, { packSize: floored });
    setDrafts((prev) => ({
      ...prev,
      [item.row.id]: { ...(prev[item.row.id] ?? {}), packSize: String(floored) },
    }));
  };

  const handlePackCostBlur = async (item: ReorderItem) => {
    const raw = (drafts[item.row.id]?.packCost ?? "").trim();
    if (!raw) return;
    const parsed = parseCurrency(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    await savePatch(item, { packCost: parsed });
    setDrafts((prev) => ({
      ...prev,
      [item.row.id]: { ...(prev[item.row.id] ?? {}), packCost: formatCurrency(parsed) },
    }));
  };

  return (
    <div className="reorder-vendor-card reorder-missing-card app-card">
      <div className="reorder-vendor-header">
        <div className="reorder-vendor-info">
          <Link2Off size={18} />
          <h4 className="reorder-vendor-name">Missing Information</h4>
          <span className="reorder-vendor-count">
            {items.length} item{items.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <p className="reorder-nolink-hint">
        These items need a vendor before they can be reordered. Price is
        optional here — you'll set it when receiving the order. Use the
        checkboxes to bulk-assign a vendor, or fill fields per row.
      </p>

      {effectiveSelectedIds.size > 0 ? (
        <div className="reorder-bulk-toolbar">
          <span className="reorder-bulk-count">
            {effectiveSelectedIds.size} selected
          </span>
          <span className="reorder-bulk-label">Set vendor:</span>
          <VendorSelect
            value={bulkVendor}
            availableVendors={availableVendors}
            onChange={setBulkVendor}
            onAddVendor={onAddVendor}
            suggestedName={bulkSuggestion}
            disabled={bulkSaving}
            className="reorder-bulk-select"
            ariaLabel="Bulk vendor"
          />
          <button
            type="button"
            className="button button-primary button-sm"
            onClick={() => void handleBulkApply()}
            disabled={bulkSaving || !bulkVendor.trim()}
          >
            {bulkSaving ? "Applying…" : "Apply"}
          </button>
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkSaving}
          >
            Clear
          </button>
        </div>
      ) : null}

      <div className="checklist-items checklist-items--inline reorder-missing-grid">
        <div className="checklist-items-header reorder-missing-row">
          <div className="checklist-cell checklist-cell--checkbox">
            <input
              type="checkbox"
              className="reorder-missing-row-checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
              disabled={items.length === 0}
              aria-label="Select all missing-info items"
            />
          </div>
          <div className="checklist-cell">Item</div>
          <div className="checklist-cell">Vendor</div>
          <div className="checklist-cell">Price</div>
        </div>
        {items.map((item) => {
          const draft = drafts[item.row.id] ?? {};
          const vendorValue = item.vendor ?? "";
          const unitCostValue = draft.unitCost ?? rawCurrency(item.row.values.unitCost);
          const packSizeValue = draft.packSize ?? rawNumber(item.row.values.packSize);
          const packCostValue = draft.packCost ?? rawCurrency(item.row.values.packCost);
          const saving = savingIds.has(item.row.id);
          const missingVendor = !item.vendor;
          const mode = priceModeFor(item);
          return (
            <div
              key={item.row.id}
              className={`checklist-item checklist-item--form reorder-missing-row${item.isExtra ? " reorder-missing-row--extra" : ""}`}
            >
              <div className="checklist-cell checklist-cell--checkbox">
                <input
                  type="checkbox"
                  className="reorder-missing-row-checkbox"
                  checked={effectiveSelectedIds.has(item.row.id)}
                  onChange={() => toggleOne(item.row.id)}
                  aria-label={`Select ${item.itemName}`}
                />
              </div>
              <div className="checklist-cell">
                <div className="checklist-item-info">
                  <span className="checklist-item-name checklist-item-name--static">{item.itemName}</span>
                  <span className="checklist-item-detail">
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
                        <span className="reorder-item-status reorder-status-extra">Added</span>
                      )
                    ) : (
                      <span className="reorder-item-status reorder-status-lowStock">
                        Low: {item.activeQty}/{item.minQuantity}
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <div className="checklist-cell">
                <VendorSelect
                  value={vendorValue}
                  availableVendors={availableVendors}
                  onChange={(next) => void handleVendorChange(item, next)}
                  onAddVendor={onAddVendor}
                  suggestedName={suggestVendorNameFromUrl(item.reorderLink)}
                  disabled={!onSaveItemFields || saving}
                  className={missingVendor ? "field--missing" : ""}
                  ariaLabel="Vendor"
                />
              </div>
              <div className="checklist-cell reorder-missing-price-cell">
                <div
                  className="reorder-price-mode"
                  role="tablist"
                  aria-label="Pricing mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "unit"}
                    className={`reorder-price-mode-btn${mode === "unit" ? " active" : ""}`}
                    onClick={() => setPriceMode(item.row.id, "unit")}
                    disabled={saving}
                  >
                    Unit
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "box"}
                    className={`reorder-price-mode-btn${mode === "box" ? " active" : ""}`}
                    onClick={() => setPriceMode(item.row.id, "box")}
                    disabled={saving}
                  >
                    Box
                  </button>
                </div>
                {mode === "unit" ? (
                  <input
                    className="field reorder-missing-input"
                    type="text"
                    inputMode="decimal"
                    placeholder="$ / unit"
                    aria-label="Unit cost"
                    value={unitCostValue}
                    onChange={(e) => updateDraft(item.row.id, { unitCost: e.target.value })}
                    onBlur={() => void handlePriceBlur(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handlePriceBlur(item);
                      }
                    }}
                    disabled={!onSaveItemFields || saving}
                  />
                ) : (
                  <div className="reorder-missing-box-inputs">
                    <input
                      className="field reorder-missing-input"
                      type="number"
                      min="1"
                      placeholder="Pack size"
                      aria-label="Pack size (units per box)"
                      value={packSizeValue}
                      onChange={(e) => updateDraft(item.row.id, { packSize: e.target.value })}
                      onBlur={() => void handlePackSizeBlur(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handlePackSizeBlur(item);
                        }
                      }}
                      disabled={!onSaveItemFields || saving}
                    />
                    <input
                      className="field reorder-missing-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="$ / box"
                      aria-label="Pack cost"
                      value={packCostValue}
                      onChange={(e) => updateDraft(item.row.id, { packCost: e.target.value })}
                      onBlur={() => void handlePackCostBlur(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handlePackCostBlur(item);
                        }
                      }}
                      disabled={!onSaveItemFields || saving}
                    />
                  </div>
                )}
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
  availableVendors = [],
  onAddVendor,
  onSaveItemFields,
  onCountChange,
  onMarkOrdered,
}: ReorderTabProps) {
  const { vendorGroups, incompleteItems } = useMemo(() => {
    // Aggregate rows by itemName + location into one entry per item
    type ItemAgg = {
      rows: InventoryRow[];
      activeQty: number;
      expiredQty: number;
      minQuantity: number;
      hasMin: boolean;
      reorderLink: string;
      vendor: string;
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
      const isExpired = daysUntil !== null && daysUntil <= 0;
      const rowLink = normalizeLinkValue(String(row.values.reorderLink ?? "").trim());
      const rowVendor = String(row.values.vendor ?? "").trim();
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
          vendor: rowVendor,
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
        // Prefer any row with a vendor assigned
        if (!existing.vendor && rowVendor) {
          existing.vendor = rowVendor;
        }
        // Track most recent orderedAt across all rows
        if (rowOrderedAt && (!existing.latestOrderedAt || rowOrderedAt > existing.latestOrderedAt)) {
          existing.latestOrderedAt = rowOrderedAt;
        }
      }
    }

    const reorderItems: ReorderItem[] = [];
    const incomplete: ReorderItem[] = [];

    for (const [key, agg] of groupMap.entries()) {
      // Only show if actively low — expired qty doesn't count toward stock
      if (!agg.hasMin || agg.activeQty >= agg.minQuantity) continue;
      // Already-ordered items live in the Pending Receipt section; skip here.
      if (agg.latestOrderedAt) continue;

      const itemName = key.split("\x00")[0];

      // Representative row: prefer non-expired row with lowest active qty
      const activeRows = agg.rows.filter((r) => {
        const d = getDaysUntilExpiration(r.values.expirationDate);
        return d === null || d > 0;
      });
      const candidateRows = activeRows.length > 0 ? activeRows : agg.rows;
      const repRow = candidateRows.reduce((best, r) =>
        Number(r.values.quantity ?? 0) < Number(best.values.quantity ?? 0) ? r : best,
      );

      // Effective unit cost for estimating reorder spend: prefer the derived
      // price from packCost / packSize when both are set, else the row's
      // stored unitCost. Null when neither is available.
      const packCost = Number(repRow.values.packCost);
      const packSizeRaw = Number(repRow.values.packSize);
      const packSize = Number.isFinite(packSizeRaw) && packSizeRaw > 0 ? packSizeRaw : 0;
      const storedUnit = Number(repRow.values.unitCost);
      let unitCost: number | null = null;
      if (Number.isFinite(packCost) && packSize > 0) {
        unitCost = packCost / packSize;
      } else if (Number.isFinite(storedUnit) && storedUnit >= 0) {
        unitCost = storedUnit;
      }

      // Suggest in boxes when pack-based (round up shortfall to whole boxes),
      // else in units. Input + subtotal follow this denomination too.
      const shortfallUnits = agg.minQuantity - agg.activeQty;
      const suggestedQty = packSize > 0
        ? Math.max(1, Math.ceil(shortfallUnits / packSize))
        : Math.max(1, Math.ceil(shortfallUnits));

      const item: ReorderItem = {
        row: repRow,
        allRowIds: agg.rows.map((r) => r.id),
        itemName,
        reorderLink: agg.reorderLink,
        vendor: agg.vendor,
        activeQty: agg.activeQty,
        expiredQty: agg.expiredQty,
        minQuantity: agg.minQuantity,
        suggestedQty,
        hasExpired: agg.expiredQty > 0,
        orderedAt: agg.latestOrderedAt,
        unitCost,
        packSize,
      };

      // Vendor is the only hard requirement to land in a vendor card —
      // price is collected when the order is received (the receive flow
      // prompts for unit cost), so items without a price can still be
      // ordered. Items without a vendor go to the Missing Information card
      // because we can't group them.
      if (item.vendor) {
        reorderItems.push(item);
      } else {
        incomplete.push(item);
      }
    }

    // Group reorder items by vendor name. Items reach this point only when
    // vendor is set (the gate above sends unassigned items to Missing Info).
    const groupedByKey = new Map<string, { label: string; items: ReorderItem[] }>();
    for (const item of reorderItems) {
      const existing = groupedByKey.get(item.vendor);
      if (existing) existing.items.push(item);
      else groupedByKey.set(item.vendor, { label: item.vendor, items: [item] });
    }

    // Alphabetize items within each vendor group so the reorder checklist has
    // a predictable order — otherwise rows come out in Map insertion order
    // which has no meaning to the user.
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });

    const groups: VendorGroup[] = Array.from(groupedByKey.values())
      .map((g) => ({ label: g.label, items: [...g.items].sort(nameCompare) }))
      .sort((a, b) => b.items.length - a.items.length);

    incomplete.sort(nameCompare);

    return { vendorGroups: groups, incompleteItems: incomplete };
  }, [rows]);

  // Rows the user has explicitly picked for this reorder via the panel (not
  // low-stock). Stored as rowId — we look up the live row from inventoryRows
  // during rendering so stale pick state doesn't drift if the row changes.
  const [extraPickRowIds, setExtraPickRowIds] = useState<string[]>(
    () => readPersistedReorderState().extras,
  );

  // Build a ReorderItem for each extra-picked row, using the same shape and
  // unit-cost derivation as low-stock items. Items already represented in
  // vendorGroups / incompleteItems (user picked something that became low)
  // are skipped so we don't render duplicates.
  const extraPickedItems = useMemo<ReorderItem[]>(() => {
    if (extraPickRowIds.length === 0) return [];
    const alreadyCoveredRowIds = new Set<string>();
    for (const g of vendorGroups) {
      for (const item of g.items) {
        item.allRowIds.forEach((id) => alreadyCoveredRowIds.add(id));
      }
    }
    for (const item of incompleteItems) {
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
      vendor: string;
      minQuantity: number;
      unitCost: number | null;
      packSize: number;
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
      const rowVendor = String(row.values.vendor ?? "").trim();
      const minQuantity = Number(row.values.minQuantity);
      const hasMin = Number.isFinite(minQuantity) && minQuantity > 0;
      const packCost = Number(row.values.packCost);
      const packSizeRaw = Number(row.values.packSize);
      const packSize = Number.isFinite(packSizeRaw) && packSizeRaw > 0 ? packSizeRaw : 0;
      const storedUnit = Number(row.values.unitCost);
      let unitCost: number | null = null;
      if (Number.isFinite(packCost) && packSize > 0) {
        unitCost = packCost / packSize;
      } else if (Number.isFinite(storedUnit) && storedUnit >= 0) {
        unitCost = storedUnit;
      }
      const existing = pickedMap.get(key);
      if (existing) {
        existing.rows.push(row);
        if (!existing.reorderLink && rowLink) existing.reorderLink = rowLink;
        if (!existing.vendor && rowVendor) existing.vendor = rowVendor;
        if (hasMin && minQuantity > existing.minQuantity) existing.minQuantity = minQuantity;
        if (existing.unitCost === null && unitCost !== null) existing.unitCost = unitCost;
        if (existing.packSize === 0 && packSize > 0) existing.packSize = packSize;
      } else {
        pickedMap.set(key, {
          rows: [row],
          itemName,
          location: rowLocation,
          reorderLink: rowLink,
          vendor: rowVendor,
          minQuantity: hasMin ? minQuantity : 0,
          unitCost,
          packSize,
        });
      }
    }
    const out: ReorderItem[] = [];
    for (const agg of pickedMap.values()) {
      // Representative row — prefer a non-expired row with the lowest qty.
      const activeRows = agg.rows.filter((r) => {
        const d = getDaysUntilExpiration(r.values.expirationDate);
        return d === null || d > 0;
      });
      const candidateRows = activeRows.length > 0 ? activeRows : agg.rows;
      const repRow = candidateRows.reduce((best, r) =>
        Number(r.values.quantity ?? 0) < Number(best.values.quantity ?? 0) ? r : best,
      );
      const activeQty = agg.rows.reduce((sum, r) => {
        const qty = Number.isFinite(Number(r.values.quantity)) ? Number(r.values.quantity) : 0;
        const d = getDaysUntilExpiration(r.values.expirationDate);
        const isExpired = d !== null && d <= 0;
        return isExpired ? sum : sum + qty;
      }, 0);
      out.push({
        row: repRow,
        allRowIds: agg.rows.map((r) => r.id),
        itemName: agg.itemName,
        reorderLink: agg.reorderLink,
        vendor: agg.vendor,
        activeQty,
        expiredQty: 0,
        minQuantity: agg.minQuantity,
        // 1 in whichever unit the item uses — 1 box for pack items, 1 unit
        // otherwise. VendorChecklistCard renders this in the denominated form.
        suggestedQty: 1,
        hasExpired: false,
        orderedAt: null,
        unitCost: agg.unitCost,
        packSize: agg.packSize,
        isExtra: true,
      });
    }
    return out;
  }, [extraPickRowIds, vendorGroups, incompleteItems, rows]);

  // Merge extra picks into the same vendor grouping as low-stock items.
  // Items with vendor + price route to the matching vendor card; the rest go
  // to the Missing Information card so the user can fill in what's missing.
  const vendorGroupsWithExtras = useMemo<VendorGroup[]>(() => {
    if (extraPickedItems.length === 0) return vendorGroups;
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });
    const cloned: VendorGroup[] = vendorGroups.map((g) => ({
      label: g.label,
      items: [...g.items],
    }));
    const labelIndex = new Map(cloned.map((g, i) => [g.label, i]));
    for (const item of extraPickedItems) {
      if (!item.vendor || item.unitCost === null) continue;
      const idx = labelIndex.get(item.vendor);
      if (idx === undefined) {
        labelIndex.set(item.vendor, cloned.length);
        cloned.push({ label: item.vendor, items: [item] });
      } else {
        cloned[idx].items.push(item);
      }
    }
    for (const g of cloned) g.items.sort(nameCompare);
    return cloned;
  }, [vendorGroups, extraPickedItems]);

  const incompleteItemsWithExtras = useMemo<ReorderItem[]>(() => {
    const extras = extraPickedItems.filter((i) => !i.vendor);
    if (extras.length === 0) return incompleteItems;
    const nameCompare = (a: ReorderItem, b: ReorderItem) =>
      a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });
    return [...incompleteItems, ...extras].sort(nameCompare);
  }, [incompleteItems, extraPickedItems]);

  // Set of row IDs already in the reorder list — used by OrderBuilderPanel to
  // hide already-covered items from search results.
  const alreadyPickedRowIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of vendorGroupsWithExtras) {
      for (const item of g.items) {
        item.allRowIds.forEach((id) => set.add(id));
      }
    }
    for (const item of incompleteItemsWithExtras) {
      item.allRowIds.forEach((id) => set.add(id));
    }
    return set;
  }, [vendorGroupsWithExtras, incompleteItemsWithExtras]);

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
  // Also persisted to localStorage so a page reload mid-reorder doesn't wipe
  // the cart the user was building.
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(
    () => new Set(readPersistedReorderState().checked),
  );
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>(
    () => readPersistedReorderState().qty,
  );

  // Persist reorder selection to localStorage on every change. Saves as a
  // plain object because Set isn't JSON-serializable. Stored globally (not
  // keyed by org) since keys are itemName+location — unmatchable keys after
  // an org switch are harmless; MarkOrdered already prunes the ones that
  // actually get acted on.
  useEffect(() => {
    writePersistedReorderState({
      checked: Array.from(checkedKeys),
      qty: qtyDrafts,
      extras: extraPickRowIds,
    });
  }, [checkedKeys, qtyDrafts, extraPickRowIds]);

  const toggleCheckedKey = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Bulk-set check state across many keys at once. Powers the "check all"
  // checkbox at the top of each vendor card so we issue a single state
  // update instead of N toggleCheckedKey calls.
  const setManyChecked = (keys: string[], checked: boolean) => {
    if (keys.length === 0) return;
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (checked) for (const k of keys) next.add(k);
      else for (const k of keys) next.delete(k);
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

  // Items in vendor groups (have a reorder link, so domain is known).
  const linkedReorderItems = vendorGroupsWithExtras.reduce((sum, g) => sum + g.items.length, 0);
  // Total reorderable items = vendor-grouped + items still missing info.
  // Both are shown to the user, so the count badge reflects everything.
  const totalReorderItems = linkedReorderItems + incompleteItemsWithExtras.length;
  const isEmpty = totalReorderItems === 0;

  // Surface the count to the Orders page so the tab badge stays in sync.
  // Effect (rather than calling during render) avoids the "setState during
  // render of another component" warning when the count is forwarded into
  // OrdersPage state.
  useEffect(() => {
    onCountChange?.(totalReorderItems);
  }, [totalReorderItems, onCountChange]);

  // Filter the reorder list by item name. Vendor groups that end up with no
  // matching items are hidden entirely. Applies to extras + low-stock +
  // missing-info so one input covers the whole page.
  const [listFilter, setListFilter] = useState("");
  const filterQ = listFilter.trim().toLowerCase();
  const matchesFilter = (name: string) =>
    !filterQ || name.toLowerCase().includes(filterQ);

  const filteredVendorGroups = useMemo<VendorGroup[]>(() => {
    if (!filterQ) return vendorGroupsWithExtras;
    return vendorGroupsWithExtras
      .map((g) => ({
        label: g.label,
        items: g.items.filter((i) => matchesFilter(i.itemName)),
      }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorGroupsWithExtras, filterQ]);

  const filteredIncompleteItems = useMemo<ReorderItem[]>(() => {
    if (!filterQ) return incompleteItemsWithExtras;
    return incompleteItemsWithExtras.filter((i) => matchesFilter(i.itemName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incompleteItemsWithExtras, filterQ]);

  const filteredTotalItems = filteredVendorGroups.reduce((sum, g) => sum + g.items.length, 0)
    + filteredIncompleteItems.length;
  const hasFilterActive = filterQ.length > 0;

  // Vendor sub-tabs. Show whenever there are 2+ tab targets (vendors plus
  // an optional Missing Info tab) so the user can jump between them without
  // scrolling a tall stack of cards. With a single vendor and no missing
  // info, fall back to direct rendering — a tab bar of one is silly.
  const hasMissingTab = filteredIncompleteItems.length > 0;
  const useVendorTabs = filteredVendorGroups.length + (hasMissingTab ? 1 : 0) > 1;
  // Marker key used in place of a vendor domain when the user selects the
  // Missing Information tab.
  const MISSING_TAB_KEY = "__missing__";
  const [activeVendor, setActiveVendor] = useState<string | null>(null);
  // Derive the effective active tab each render so a stale value (e.g. the
  // vendor got filtered out by search) never produces an empty view.
  const validTabKeys = [
    ...filteredVendorGroups.map((g) => g.label),
    ...(hasMissingTab ? [MISSING_TAB_KEY] : []),
  ];
  const effectiveActiveVendor =
    activeVendor && validTabKeys.includes(activeVendor)
      ? activeVendor
      : (validTabKeys[0] ?? null);

  // Estimated total to reorder everything in the list at the suggested qty.
  // Items without a known price are skipped; we count those separately so
  // the user sees what's missing.
  const priceableItems = [
    ...vendorGroupsWithExtras.flatMap((g) => g.items),
    ...incompleteItemsWithExtras,
  ];
  const estimatedTotal = priceableItems.reduce((sum, item) => {
    if (item.unitCost === null) return sum;
    // suggestedQty is in boxes for pack items — convert to units before
    // applying the per-unit cost.
    const qtyUnits = item.packSize > 0
      ? item.suggestedQty * item.packSize
      : item.suggestedQty;
    return sum + item.unitCost * qtyUnits;
  }, 0);
  const missingPriceCount = priceableItems.filter((i) => i.unitCost === null).length;

  return (
    <div className="reorder-tab">
      <div className="reorder-header">
        <div className="reorder-header-left">
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
        {!isEmpty && (
          <div className="reorder-header-right">
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
          </div>
        )}
      </div>

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

      {/* Sub-tabs — one per vendor (with item count + estimated $) plus a
       *  Missing Info tab when applicable. Hidden when there's just one
       *  target since a single tab is noise. */}
      {useVendorTabs && (
        <div
          className="inventory-filter-chips reorder-vendor-tabs"
          role="tablist"
          aria-label="Reorder vendors"
        >
          {filteredVendorGroups.map((group) => {
            const groupEst = group.items.reduce((sum, item) => {
              if (item.unitCost === null) return sum;
              const qtyUnits = item.packSize > 0 ? item.suggestedQty * item.packSize : item.suggestedQty;
              return sum + item.unitCost * qtyUnits;
            }, 0);
            return (
              <button
                key={group.label}
                type="button"
                role="tab"
                aria-selected={effectiveActiveVendor === group.label}
                className={`inventory-chip${effectiveActiveVendor === group.label ? " active" : ""}`}
                onClick={() => setActiveVendor(group.label)}
              >
                <span className="inventory-chip-label">{group.label}</span>
                <span className="inventory-chip-badge">
                  {group.items.length}
                  {groupEst > 0 ? ` · ${formatCurrency(groupEst)}` : ""}
                </span>
              </button>
            );
          })}
          {hasMissingTab && (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveActiveVendor === MISSING_TAB_KEY}
              className={`inventory-chip reorder-vendor-tab--missing${effectiveActiveVendor === MISSING_TAB_KEY ? " active" : ""}`}
              onClick={() => setActiveVendor(MISSING_TAB_KEY)}
            >
              <span className="inventory-chip-label">Missing Info</span>
              <span className="inventory-chip-badge">{filteredIncompleteItems.length}</span>
            </button>
          )}
        </div>
      )}

      {useVendorTabs ? (
        effectiveActiveVendor === MISSING_TAB_KEY ? (
          <MissingInfoCard
            items={filteredIncompleteItems}
            availableVendors={availableVendors}
            onAddVendor={onAddVendor}
            onSaveItemFields={onSaveItemFields}
          />
        ) : (
          (() => {
            const activeGroup = filteredVendorGroups.find((g) => g.label === effectiveActiveVendor);
            if (!activeGroup) return null;
            return (
              <VendorChecklistCard
                key={activeGroup.label}
                group={activeGroup}
                checkedKeys={checkedKeys}
                qtyDrafts={qtyDrafts}
                onToggleChecked={toggleCheckedKey}
                onSetManyChecked={setManyChecked}
                onSetQty={setQtyForKey}
                onMarkOrdered={handleMarkOrderedForVendor}
                onRemoveExtra={handleRemoveExtra}
              />
            );
          })()
        )
      ) : (
        <>
          {filteredVendorGroups.map((group) => (
            <VendorChecklistCard
              key={group.label}
              group={group}
              checkedKeys={checkedKeys}
              qtyDrafts={qtyDrafts}
              onToggleChecked={toggleCheckedKey}
              onSetManyChecked={setManyChecked}
              onSetQty={setQtyForKey}
              onMarkOrdered={handleMarkOrderedForVendor}
              onRemoveExtra={handleRemoveExtra}
            />
          ))}
          {filteredIncompleteItems.length > 0 && (
            <MissingInfoCard
              items={filteredIncompleteItems}
              availableVendors={availableVendors}
              onAddVendor={onAddVendor}
              onSaveItemFields={onSaveItemFields}
            />
          )}
        </>
      )}
    </div>
  );
}
