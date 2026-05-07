// ── Shop tab (1d) ───────────────────────────────────────────────────────────
// New shopping-list view that replaces vendor-grouped Reorder cards with a
// "Shop at" picker. Built as a parallel tab so the legacy Reorder stays
// available for parity comparison until 1e retires it.
//
// Two modes:
// - Vendor mode ("Shop at: Costco") — orderable. Low items × prices at the
//   selected vendor, plus a best-price comparison vs other vendors. Items
//   without history at this vendor get an inline "Set price" input that's
//   captured onto the order line so the next price-history pull sees it.
// - Anywhere mode — read-only. Low items with their cheapest vendor +
//   $/canonical. The user picks a vendor on a follow-up trip; we don't try
//   to auto-split a multi-vendor order.
//
// Aggregation: low-stock detection groups by lowercased itemName so a multi-
// lot item (3 ct + 5 ct lots, min=6) sees its TOTAL on-hand of 8 and stays
// out of the list. Mark-as-ordered stamps `orderedAt` on every lot of a
// matching name so all rows leave the list together.

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Info, Plus, ShoppingCart } from "lucide-react";
import { LoadingState } from "./shared/LoadingState";
import { EmptyState } from "./shared/EmptyState";
import {
  loadPriceHistory,
  type InventoryRow,
  type ItemVendorPricingEntry,
  type PriceHistoryEntry,
} from "../lib/inventoryApi";
import type { OrderItem } from "./ReorderTab";
import { formatCurrency, parseCurrency } from "../lib/currency";
import {
  dimensionForUnit,
  pricePerCanonical,
} from "../lib/uom";

interface ShoppingListTabProps {
  rows: InventoryRow[];
  availableVendors: string[];
  /** 1g.6/1h.0: per-(item, vendor) pricing rows. Drives the vendor-aware
   *  URL render — vendor mode pulls the active vendor's URL only.
   *  Anywhere mode shows no URL so a name doesn't accidentally link to a
   *  vendor the user hasn't committed to. */
  vendorPricing: Map<string, Map<string, ItemVendorPricingEntry>>;
  onMarkOrdered: (rowIds: string[], vendor: string, items: OrderItem[]) => Promise<void>;
  /** Per-row "edit pricing" callback. Opens the parent's i modal scoped
   *  to this item so users can adjust pack count, amount, cost, and URL
   *  without inline edits crowding the Reorder row. Used in both
   *  All-Vendors mode (item name click) and vendor mode (i button). */
  onOpenItemDetails?: (itemId: string) => void;
}

/** Lowercase + trim a vendor name for comparison. The endpoint already lowers
 *  the grouping key, but the picker shows canonical casing — every lookup
 *  has to normalize on the way in. */
const normVendor = (v: string): string => v.trim().toLowerCase();

const URL_REGEX = /^https?:\/\//i;
const normalizeLink = (link: string): string =>
  link && !URL_REGEX.test(link) ? `https://${link}` : link;

type ShopItem = {
  /** Lowercased itemName — joins inventory + price-history. */
  itemKey: string;
  itemName: string;
  /** Every inventory row that matches this itemKey. Mark-as-ordered stamps
   *  orderedAt on every one so a multi-lot item leaves the list as a unit. */
  rowIds: string[];
  /** Representative row — used to pull unit, reorderLink defaults. The
   *  cross-lot aggregation otherwise has no stable single id. */
  representativeRowId: string;
  /** UoM string from the row's `unit` column (default "ct"). Dimension
   *  family is inferred at use-time via uom.ts. */
  unit: string;
  reorderLink: string;
  /** Sum of `quantity` across all lots. */
  activeQty: number;
  /** Max `minQuantity` across lots — mirrors the existing Reorder rule
   *  (a single low-min lot doesn't drag the whole item under threshold). */
  minQty: number;
  /** Suggested order qty in user's unit. Defaults to (minQty - activeQty)
   *  rounded up for count, or minQty - activeQty for weight/volume. */
  suggestedQty: number;
  /** Per-vendor history pulled from the endpoint, keyed by lowercased vendor. */
  byVendor: Map<string, PriceHistoryEntry>;
};

export function ShoppingListTab({ rows, availableVendors, vendorPricing, onMarkOrdered, onOpenItemDetails }: ShoppingListTabProps) {
  const [vendorMode, setVendorMode] = useState<string>("");
  const [history, setHistory] = useState<PriceHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Recency window is server-driven (price-history endpoint default).
  // We don't surface it in the UI anymore; the value just informs the
  // server how far back to walk receipts when computing best prices.
  const [, setRecencyDays] = useState(180);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});
  // 1h.7: filter the visible item rows by name. Case-insensitive substring
  // match. Trimmed value is what gates rendering.
  const [searchTerm, setSearchTerm] = useState<string>("");
  // 1h.8: order mode is now purely derived from the vendor pricing
  // row's shape (Pack when packCount > 0). The user-flippable mode
  // toggle was pulled — to override, edit the vendor row in the i
  // modal. Drafts state retired alongside the inline pack/price inputs.
  // priceDrafts is an empty placeholder kept so the submit code path
  // can stay shape-stable while the UI routes price overrides through
  // the i modal instead of inline. Submit falls through to the
  // computed-from-vendor default when the draft is absent (which is
  // always, post-1h.7). packSizeDrafts retired in 1h.8 alongside the
  // mode toggle — vendor row's packCount is the single source of truth.
  const priceDrafts: Record<string, string> = {};
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  // 1h.7: URL editing moved to the i modal. Inline URL state was
  // removed along with the inline price + pack-size overrides — one
  // canonical edit path through ItemDetailModal keeps the row tight.

  // Initial fetch + manual refresh after Mark-as-ordered.
  const refreshHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await loadPriceHistory();
      setHistory(result.history);
      setRecencyDays(result.recencyWindowDays);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load price history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Aggregate the inventory rows into one ShopItem per itemName (lowercased).
   *  An item enters the list when its TOTAL on-hand is below the max minQty
   *  across its lots. This matches the established Reorder rule — see
   *  feedback_reorder_min_aggregation memory for the reasoning. */
  const lowItems: ShopItem[] = useMemo(() => {
    type Agg = ShopItem & { repPriority: number };
    const aggMap = new Map<string, Agg>();

    // Group by itemKey.
    for (const row of rows) {
      const name = String(row.values.itemName ?? "").trim();
      if (!name) continue;
      // Skip rows already marked as ordered — they shouldn't reappear until
      // received or canceled. Mirrors the legacy Reorder filter.
      const orderedAt = String(row.values.orderedAt ?? "").trim();
      if (orderedAt) continue;
      const key = name.toLowerCase();

      const qty = Number(row.values.quantity);
      const min = Number(row.values.minQuantity);
      const safeQty = Number.isFinite(qty) ? qty : 0;
      const safeMin = Number.isFinite(min) ? min : 0;

      // Read the item's tracking unit (1f). Default "ct" for legacy items
      // that pre-date the unit column. Dimension family is inferred from
      // the unit string at use-time, never persisted as its own field.
      const storedUnit = String(row.values.unit ?? "").trim();
      const unit = storedUnit && dimensionForUnit(storedUnit) ? storedUnit : "ct";
      const reorderLink = String(row.values.reorderLink ?? "").trim();

      const existing = aggMap.get(key);
      // Representative row priority: prefer the row carrying a reorderLink
      // (so the link click-through has something to open) > non-zero qty >
      // first one we see. Tracked via repPriority so we replace consistently.
      const repPriority = (reorderLink ? 2 : 0) + (safeQty > 0 ? 1 : 0);

      if (!existing) {
        aggMap.set(key, {
          itemKey: key,
          itemName: name,
          rowIds: [row.id],
          representativeRowId: row.id,
          unit,
          reorderLink,
          activeQty: safeQty,
          minQty: safeMin,
          suggestedQty: 0, // computed below
          byVendor: new Map(),
          repPriority,
        });
      } else {
        existing.rowIds.push(row.id);
        existing.activeQty += safeQty;
        existing.minQty = Math.max(existing.minQty, safeMin);
        if (repPriority > existing.repPriority) {
          existing.representativeRowId = row.id;
          existing.unit = unit;
          existing.reorderLink = reorderLink;
          existing.repPriority = repPriority;
        }
      }
    }

    // Drop the priority field + filter to actually-low items.
    const out: ShopItem[] = [];
    for (const agg of aggMap.values()) {
      if (agg.minQty <= 0) continue;
      if (agg.activeQty >= agg.minQty) continue;
      const shortfall = Math.max(0, agg.minQty - agg.activeQty);
      // Round up for count-family units (no fractional eggs); preserve
      // decimals for weight/volume.
      const isCount = dimensionForUnit(agg.unit) === "count";
      const suggestedQty = isCount ? Math.ceil(shortfall) : shortfall;
      // Strip the internal repPriority and bind the final suggestedQty.
      const { repPriority: _drop, ...keep } = agg;
      out.push({ ...keep, suggestedQty: suggestedQty > 0 ? suggestedQty : 1 });
    }
    out.sort((a, b) => a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" }));
    return out;
  }, [rows]);

  // Attach per-vendor history once both inputs are ready. Done in a separate
  // memo so the (history) update doesn't recompute the row aggregation.
  const lowItemsWithHistory: ShopItem[] = useMemo(() => {
    if (history.length === 0) return lowItems;
    const byKey = new Map<string, Map<string, PriceHistoryEntry>>();
    for (const entry of history) {
      const m = byKey.get(entry.itemKey) ?? new Map<string, PriceHistoryEntry>();
      m.set(normVendor(entry.vendor), entry);
      byKey.set(entry.itemKey, m);
    }
    return lowItems.map((item) => ({
      ...item,
      byVendor: byKey.get(item.itemKey) ?? new Map(),
    }));
  }, [lowItems, history]);

  /** Cheapest known vendor for an item across all observations in the
   *  recency window. Returns null when there's no priced history. */
  const bestEntryFor = (item: ShopItem): PriceHistoryEntry | null => {
    let best: PriceHistoryEntry | null = null;
    for (const entry of item.byVendor.values()) {
      if (!best || entry.pricePerCanonical < best.pricePerCanonical) {
        best = entry;
      }
    }
    return best;
  };

  // 1h.7: filtered low-item list. Search is a case-insensitive substring
  // match against the item name. Empty / whitespace-only term passes
  // everything through. Memoized so re-renders triggered by qty/price
  // drafts don't redo string matching.
  const filteredLowItems: ShopItem[] = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return lowItemsWithHistory;
    return lowItemsWithHistory.filter((item) =>
      item.itemName.toLowerCase().includes(q),
    );
  }, [lowItemsWithHistory, searchTerm]);

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Select / deselect every row currently visible (after the search
  // filter). Useful when the user has narrowed to a specific vendor or
  // category and wants to add/remove the whole subset at once.
  const visibleAllSelected = filteredLowItems.length > 0
    && filteredLowItems.every((i) => selectedKeys.has(i.itemKey));
  const visibleSomeSelected = filteredLowItems.some((i) => selectedKeys.has(i.itemKey));
  const toggleSelectAllVisible = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (visibleAllSelected) {
        // Deselect just the currently-visible subset; preserve any
        // selections on rows hidden by the search.
        for (const item of filteredLowItems) next.delete(item.itemKey);
      } else {
        for (const item of filteredLowItems) next.add(item.itemKey);
      }
      return next;
    });
  };

  const setQty = (key: string, value: string) => {
    setQtyDrafts((prev) => ({ ...prev, [key]: value }));
  };

  /** Look up the active vendor's pricing entry for an item, if any. Returns
   *  undefined when not in vendor mode OR no entry exists. Single-call
   *  helper used by both the row render (to decide whether the pack toggle
   *  shows) and the submit logic (to compute the pack-mode multiplier). */
  const activeVendorPricingFor = (itemId: string): ItemVendorPricingEntry | undefined => {
    if (!vendorMode) return undefined;
    return vendorPricing.get(itemId)?.get(normVendor(vendorMode));
  };

  // 1h.7: full-list estimated spend. Always-on summary at the top of
  // the list — separate from the selection-driven subtotal in the
  // footer. Two flavors:
  //   - vendor mode → cost of the visible low items at THIS vendor's
  //     prices (items not stocked at this vendor count as unpriced).
  //   - All Vendors mode → cost of the visible low items at each item's
  //     BEST price across all vendors. Useful "if I shopped optimally"
  //     preview for the all-tab.
  //
  // Pack-rounding parity: vendor mode rounds shortfall UP to whole packs
  // (you can't buy half a pack). All Vendors used to use the raw
  // shortfall, which made the totals diverge for items where the best
  // vendor's pack is bigger than the shortfall. We resolve the best
  // vendor's pricing row (entry.vendor → vendorPricing.get(itemId).get)
  // and apply the same pack-rounding so both totals reflect a realistic
  // order spend.
  const visibleEstimate = useMemo(() => {
    let total = 0;
    let priced = 0;
    let unpriced = 0;
    for (const item of filteredLowItems) {
      // Pick the price entry: vendor mode → that vendor's; All Vendors → best.
      const entry = vendorMode
        ? item.byVendor.get(normVendor(vendorMode))
        : bestEntryFor(item);
      if (!entry) {
        unpriced += 1;
        continue;
      }

      // Resolve the pricing row for the chosen entry's vendor — this is
      // the source of `packCount` for the pack-rounding calc. In vendor
      // mode the vendor matches the user's selection; in All Vendors
      // mode we follow the best entry's vendor.
      const targetVendorLower = normVendor(entry.vendor);
      const vp = vendorPricing.get(item.representativeRowId)?.get(targetVendorLower);
      const submitPackSize = Number(vp?.packCount ?? vp?.packSize ?? 0);
      // 1h.8: mode derives from the vendor row's shape — Pack iff
      // packCount > 0. Inline override removed.
      const isPackMode = submitPackSize > 0;
      const qtyDefault = isPackMode
        ? Math.max(1, Math.ceil(item.suggestedQty / submitPackSize))
        : item.suggestedQty;
      const qty = Number(qtyDrafts[item.itemKey] ?? qtyDefault);
      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
      const qtyInPrimaryUnits = isPackMode ? safeQty * submitPackSize : safeQty;

      const canon = pricePerCanonical(1, qtyInPrimaryUnits, item.unit);
      if (canon) {
        const canonAmount = 1 / canon.pricePerCanonical;
        total += entry.pricePerCanonical * canonAmount;
        priced += 1;
      }
    }
    return { total, priced, unpriced };
  }, [vendorMode, filteredLowItems, qtyDrafts, vendorPricing]);

  // Subtotal for the current vendor-mode selection. Only items with either a
  // known vendor price OR a typed inline price contribute.
  const checkedSubtotal = useMemo(() => {
    if (!vendorMode) return null;
    let total = 0;
    let priced = 0;
    let unpriced = 0;
    for (const item of lowItemsWithHistory) {
      if (!selectedKeys.has(item.itemKey)) continue;
      // 1h.8: resolve mode + qty default the SAME way the row renders
      // them so checkedSubtotal agrees with what's on screen. Pack mode
      // = packCount > 0; qty default = ceil(shortfall / packCount).
      // Without this, the bare fallback `item.suggestedQty` would be
      // treated as the number of PACKS in Pack mode, multiplying the
      // total by packCount² (the 10× / 100× discrepancy). Inline-typed
      // qty (qtyDrafts) is already in the correct unit because the
      // input takes its value from the pack-aware default.
      const vp = activeVendorPricingFor(item.representativeRowId);
      const submitPackSize = Number(vp?.packCount ?? vp?.packSize ?? 0);
      const isPackMode = submitPackSize > 0;
      const qtyDefault = isPackMode
        ? Math.max(1, Math.ceil(item.suggestedQty / submitPackSize))
        : item.suggestedQty;
      const qty = Number(qtyDrafts[item.itemKey] ?? qtyDefault);
      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
      // Inline-typed price wins over the historical vendor price (the user
      // is correcting what we know).
      const typed = priceDrafts[item.itemKey]?.trim();
      if (typed) {
        const parsed = parseCurrency(typed);
        if (Number.isFinite(parsed) && parsed >= 0) {
          total += parsed;
          priced += 1;
          continue;
        }
      }
      const vendorEntry = item.byVendor.get(normVendor(vendorMode));
      if (vendorEntry) {
        // Subtotal is in primary units → multiply qty × packCount in
        // Pack mode to get the actual count contributed.
        const qtyInPrimaryUnits = isPackMode ? safeQty * submitPackSize : safeQty;
        // Convert qty (in item's `unit`) to canonical units, then multiply
        // by the vendor's $/canonical to get the line total.
        const canon = pricePerCanonical(1, qtyInPrimaryUnits, item.unit);
        if (canon) {
          const canonAmount = 1 / canon.pricePerCanonical;
          total += vendorEntry.pricePerCanonical * canonAmount;
          priced += 1;
        }
      } else {
        unpriced += 1;
      }
    }
    return { total, priced, unpriced };
  }, [vendorMode, lowItemsWithHistory, selectedKeys, qtyDrafts, priceDrafts, vendorPricing]);

  const handleMarkOrdered = async () => {
    if (!vendorMode) return;
    setMarking(true);
    setMarkError(null);
    try {
      const rowIds: string[] = [];
      const items: OrderItem[] = [];
      for (const item of lowItemsWithHistory) {
        if (!selectedKeys.has(item.itemKey)) continue;
        // 1h.8: pack-mode multiplier derives purely from the vendor row.
        // Pack mode iff packCount > 0; qty input is in packs in that
        // case, raw count otherwise. Pack-size + mode overrides moved
        // to the i modal as vendor row config.
        const vp = activeVendorPricingFor(item.representativeRowId);
        const submitPackSize = Number(vp?.packCount ?? vp?.packSize ?? 0);
        const isPackMode = submitPackSize > 0;
        // Resolve qty default the same way the row renders it so submit
        // math matches what the user saw on screen.
        const qtyDefault = isPackMode
          ? Math.max(1, Math.ceil(item.suggestedQty / submitPackSize))
          : item.suggestedQty;
        const qtyRaw = Number(qtyDrafts[item.itemKey] ?? qtyDefault);
        if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
          throw new Error(`${item.itemName}: enter a quantity > 0.`);
        }
        const effectivePackSize = isPackMode ? submitPackSize : 1;
        const qtyInPrimaryUnits = qtyRaw * effectivePackSize;
        rowIds.push(...item.rowIds);
        // 1h.7: resolve the recorded price the same way the row renders
        // it. Order of preference:
        //   1. user-typed draft (manual override)
        //   2. computed default from vendor entry (qty × $/canonical)
        //   3. nothing → no inline price (qty-only line; receive enters
        //      the price)
        const submitVendorEntry = item.byVendor.get(normVendor(vendorMode));
        const typed = priceDrafts[item.itemKey]?.trim();
        let purchasePrice = typed ? parseCurrency(typed) : NaN;
        if (!Number.isFinite(purchasePrice) && submitVendorEntry) {
          const canon = pricePerCanonical(1, qtyInPrimaryUnits, item.unit);
          if (canon) {
            const canonAmount = 1 / canon.pricePerCanonical;
            const computed = submitVendorEntry.pricePerCanonical * canonAmount;
            if (Number.isFinite(computed) && computed >= 0) {
              purchasePrice = computed;
            }
          }
        }
        const hasInlinePrice = Number.isFinite(purchasePrice) && purchasePrice >= 0;
        items.push({
          rowId: item.representativeRowId,
          name: item.itemName,
          qty: qtyInPrimaryUnits,
          ...(hasInlinePrice
            ? {
                // Pack-mode shape collapse: the user typed "2 boxes for $X"
                // but pricing analytics needs $/canonical. Multiply through
                // to primary units before recording. Pack metadata
                // (packSize, packCost) is captured separately so analytics
                // knows this came from a pack purchase.
                purchaseAmount: qtyInPrimaryUnits,
                purchaseUnit: item.unit,
                purchasePrice,
                ...(isPackMode ? {
                  packSize: effectivePackSize,
                  packCost: purchasePrice / Math.max(1, qtyRaw),
                } : {}),
              }
            : {}),
        });
      }
      if (items.length === 0) {
        throw new Error("Select at least one item to order.");
      }
      await onMarkOrdered(rowIds, vendorMode, items);
      // Clear selection + drafts after a successful order; refresh history.
      setSelectedKeys(new Set());
      setQtyDrafts({});
      void refreshHistory();
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : "Failed to mark items as ordered.");
    } finally {
      setMarking(false);
    }
  };

  const isAnywhere = !vendorMode;
  const checkedCount = lowItemsWithHistory.filter((i) => selectedKeys.has(i.itemKey)).length;

  return (
    <section className="app-card shop-tab" aria-label="Reorder">
      <header className="app-header shop-tab-header">
        <div>
          <h2 className="app-title">Reorder</h2>
          <p className="app-subtitle">Reorder low stock items.</p>
        </div>
        <div className="shop-tab-controls">
          <label className="field-label" htmlFor="shop-vendor-select">Shop at</label>
          <select
            id="shop-vendor-select"
            className="field shop-vendor-select"
            value={vendorMode}
            onChange={(e) => {
              setVendorMode(e.target.value);
              setSelectedKeys(new Set());
              setMarkError(null);
            }}
            disabled={historyLoading || marking}
          >
            <option value="">All Vendors</option>
            {availableVendors.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      </header>

      {historyError ? <p className="field-error" role="alert">{historyError}</p> : null}
      {markError ? <p className="field-error" role="alert">{markError}</p> : null}

      {historyLoading && lowItemsWithHistory.length === 0 ? (
        <LoadingState message="Loading prices..." />
      ) : lowItemsWithHistory.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="Nothing low right now"
          hint="Set min-on-hand on items in Inventory to drive this list."
        />
      ) : (
        <div className="shop-rows">
          {/* 1h.7: search + select-all toolbar above the row list. The
           *  select-all checkbox only renders in vendor mode (selection
           *  drives "Mark ordered" which needs a vendor). */}
          <div className="shop-rows-toolbar">
            {!isAnywhere ? (
              <label className="shop-rows-select-all" title="Select all visible items">
                <input
                  type="checkbox"
                  checked={visibleAllSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !visibleAllSelected && visibleSomeSelected;
                  }}
                  onChange={toggleSelectAllVisible}
                  disabled={marking || filteredLowItems.length === 0}
                  aria-label="Select all visible items"
                />
                <span className="shop-rows-select-all-label">All</span>
              </label>
            ) : null}
            <div className="shop-rows-search">
              <input
                type="search"
                className="field shop-rows-search-input"
                placeholder="Search by item name…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                aria-label="Search shop items"
              />
            </div>
            {/* Item count chip — distinct low items visible in the
             *  current list (after the search filter). Counts each item
             *  once regardless of how many of it you'd order. Always
             *  shown so the user has a quick "how big is this list?"
             *  read at a glance. The narrowed-by-search count is folded
             *  into the same chip when filtering. */}
            <span className="shop-rows-count-chip" title={
              searchTerm.trim() && filteredLowItems.length !== lowItemsWithHistory.length
                ? `${filteredLowItems.length} of ${lowItemsWithHistory.length} low items match your search`
                : `${filteredLowItems.length} distinct low item${filteredLowItems.length === 1 ? "" : "s"}`
            }>
              <strong>{filteredLowItems.length}</strong>
              {searchTerm.trim() && filteredLowItems.length !== lowItemsWithHistory.length
                ? <> of {lowItemsWithHistory.length} items</>
                : <> item{filteredLowItems.length === 1 ? "" : "s"}</>}
            </span>
            {visibleEstimate.total > 0 ? (
              <span
                className="shop-rows-estimate"
                title={isAnywhere
                  ? "Total if you bought every visible low item at its best vendor price"
                  : `Total at ${vendorMode}'s prices`}
              >
                Est. <strong>{formatCurrency(visibleEstimate.total)}</strong>
                {visibleEstimate.unpriced > 0 ? (
                  <span className="shop-rows-estimate-hint">
                    {" "}(+{visibleEstimate.unpriced} no price)
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {filteredLowItems.length === 0 ? (
            <p className="shop-rows-empty">No items match your search.</p>
          ) : null}
          {filteredLowItems.map((item) => {
            const vendorEntry = vendorMode
              ? item.byVendor.get(normVendor(vendorMode))
              : null;
            const best = bestEntryFor(item);
            const checked = selectedKeys.has(item.itemKey);

            // 1h.0: vendor-aware URL. Vendor mode = the active vendor's
            // URL only (no fallback — leaking a different vendor's URL
            // into another vendor's session was a real bug).
            // Anywhere mode = no URL at all. The user is browsing a
            // shopping summary; they should pick a vendor first to actually
            // shop. Showing a "best-vendor" URL in Anywhere mode was
            // confusing — clicking opened one specific vendor's page when
            // the user hadn't committed to that vendor.
            const itemPricing = vendorPricing.get(item.representativeRowId);
            const displayUrl = vendorMode
              ? (itemPricing?.get(normVendor(vendorMode))?.reorderUrl ?? "")
              : "";

            return (
              <div className="shop-row" key={item.itemKey}>
                <div className="shop-row-main">
                  {!isAnywhere && (
                    <input
                      type="checkbox"
                      className="shop-row-check"
                      checked={checked}
                      onChange={() => toggleSelected(item.itemKey)}
                      disabled={marking}
                      aria-label={`Select ${item.itemName}`}
                    />
                  )}
                  {/* 1h.8: edit-pricing button moved to the left, next
                   *  to the checkbox — mirrors the inventory-table info
                   *  column convention. Single canonical entry into the
                   *  vendor-pricing modal. */}
                  {onOpenItemDetails ? (
                    <button
                      type="button"
                      className="shop-row-edit-btn"
                      onClick={() => onOpenItemDetails(item.representativeRowId)}
                      disabled={marking}
                      aria-label={`Edit pricing for ${item.itemName}`}
                      title="Edit pricing & URL"
                    >
                      <Info size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  <div className="shop-row-info">
                    {displayUrl ? (
                      <span className="shop-row-name shop-row-name-with-link">
                        <a
                          href={normalizeLink(displayUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open ${item.itemName} at ${vendorMode} (also checks the row)`}
                          className="shop-row-name-link"
                          onClick={() => {
                            // 1h.7: clicking the vendor link also ticks
                            // the row's checkbox. The user is going to
                            // the vendor's page intending to add it to
                            // their cart there — pre-checking the row
                            // here means by the time they come back to
                            // confirm "Mark Ordered," the checklist
                            // already reflects what they're buying. Only
                            // selects (never deselects) — re-clicking
                            // the link doesn't undo their decision.
                            if (!checked) toggleSelected(item.itemKey);
                          }}
                        >
                          {item.itemName} <ExternalLink size={12} />
                        </a>
                      </span>
                    ) : isAnywhere && onOpenItemDetails ? (
                      // All-Vendors mode: name is a button that opens the
                      // item detail modal. Lets the user jump from
                      // "browsing what to buy" to "edit this item's
                      // vendor pricing" without leaving Shop.
                      <button
                        type="button"
                        className="shop-row-name shop-row-name-button"
                        onClick={() => onOpenItemDetails(item.representativeRowId)}
                        title={`Edit vendor pricing for ${item.itemName}`}
                      >
                        {item.itemName}
                      </button>
                    ) : (
                      // Vendor mode with no URL on file — name is plain
                      // text. The "+ URL" affordance moved into the
                      // price-info column below so it doesn't crowd the
                      // item name when names are long.
                      <span className="shop-row-name">{item.itemName}</span>
                    )}
                    <span className="shop-row-stock">
                      {item.activeQty}/{item.minQty} {item.unit} on hand
                    </span>
                  </div>
                </div>

                <div className="shop-row-pricing">
                  {isAnywhere ? (
                    best ? (
                      <span className="shop-row-best">
                        {`Best: ${formatCurrency(best.pricePerCanonical)}/${best.canonicalUnit} at ${best.vendor}`}
                        <span className="shop-row-samples"> · {best.sampleCount} {best.sampleCount === 1 ? "receipt" : "receipts"}</span>
                      </span>
                    ) : (
                      <span className="shop-row-best shop-row-best--empty">No price history yet</span>
                    )
                  ) : vendorEntry ? (
                    <span className="shop-row-best">
                      {`${formatCurrency(vendorEntry.pricePerCanonical)}/${vendorEntry.canonicalUnit}`}
                      <span className="shop-row-samples"> · {vendorEntry.sampleCount} {vendorEntry.sampleCount === 1 ? "receipt" : "receipts"}</span>
                      {best && best.vendor.toLowerCase() !== vendorEntry.vendor.toLowerCase() &&
                        best.pricePerCanonical < vendorEntry.pricePerCanonical && (
                          <span className="shop-row-vs-best">
                            {` · ${formatCurrency(vendorEntry.pricePerCanonical - best.pricePerCanonical)}/${best.canonicalUnit} more than ${best.vendor}`}
                          </span>
                        )}
                    </span>
                  ) : (
                    // 1h.7: "+ URL" affordance moved to the i modal
                    // (the edit-pricing button on the row opens it).
                    // Keeps the empty-history state minimal here.
                    <span className="shop-row-best shop-row-best--empty">No history</span>
                  )}
                </div>

                {!isAnywhere && (() => {
                  // 1h.7 → 1h.8: order mode is now purely derived from
                  // the vendor pricing row's shape — Pack mode iff the
                  // vendor row carries a packCount. The user-flippable
                  // Single|Pack toggle was pulled because flipping it
                  // for a one-off override is rare and the same edit
                  // can be made in the i modal (vendor row config).
                  const activePricing = activeVendorPricingFor(item.representativeRowId);
                  const effectivePackSize = Number(activePricing?.packCount ?? activePricing?.packSize ?? 0);
                  const isPackMode = effectivePackSize > 0;
                  const labelSingular = activePricing?.packLabel || "pack";
                  const labelPlural = activePricing?.packLabel
                    ? activePricing.packLabel + "s"
                    : "packs";
                  // Default qty: in Pack mode, divide the shortfall by the
                  // pack count so "need 100 gauze, vendor sells in 100-ct
                  // boxes" reads as "1 pack" instead of "100 packs." Falls
                  // back to raw suggestedQty when no pack shape is on file.
                  const qtyDefault = isPackMode
                    ? String(Math.max(1, Math.ceil(item.suggestedQty / effectivePackSize)))
                    : String(item.suggestedQty);
                  const qtyValueResolved = qtyDrafts[item.itemKey] ?? qtyDefault;
                  // Placeholder doubles as the unit hint inside the empty
                  // qty input ("packs" / "ct" / "lb").
                  const qtyPlaceholder = isPackMode ? labelPlural : item.unit;
                  // Static mode chip beside the qty input. Replaces the
                  // tab-style toggle — read-only "Pack (100)" / "Single"
                  // glyph that mirrors the vendor row's shape.
                  const modeLabel = isPackMode
                    ? `${labelSingular} (${effectivePackSize})`
                    : "Single";
                  return (
                    <div className="shop-row-inputs">
                      <div className="shop-row-qty-stack">
                        <span
                          className="shop-row-mode-label"
                          title={isPackMode
                            ? `1 ${labelSingular} = ${effectivePackSize} ${item.unit}. Edit in the pricing modal.`
                            : "Sold individually. Edit in the pricing modal."}
                        >
                          {modeLabel}
                        </span>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className="field shop-row-qty-input"
                          placeholder={qtyPlaceholder}
                          aria-label={`Quantity to order for ${item.itemName} (${qtyPlaceholder})`}
                          value={qtyValueResolved}
                          onChange={(e) => setQty(item.itemKey, e.target.value)}
                          onFocus={(e) => e.currentTarget.select()}
                          disabled={marking}
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {!isAnywhere && checkedCount > 0 && (
        <div className="shop-tab-footer">
          <div className="shop-tab-summary">
            <strong>{checkedCount}</strong>{" "}
            item{checkedCount === 1 ? "" : "s"} selected
            {checkedSubtotal && checkedSubtotal.total > 0 ? (
              <>
                {" · est. "}
                <strong>{formatCurrency(checkedSubtotal.total)}</strong>
                {checkedSubtotal.unpriced > 0 ? (
                  <span className="shop-tab-summary-hint">
                    {" "}(+{checkedSubtotal.unpriced} without price)
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleMarkOrdered()}
            disabled={marking}
          >
            <Plus size={14} /> Mark as ordered
          </button>
        </div>
      )}
    </section>
  );
}
