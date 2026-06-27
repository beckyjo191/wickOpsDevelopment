import { useEffect, useMemo, useState } from "react";
import type {
  ActiveTab,
  ColumnVisibilityOverrides,
  InventoryColumn,
  InventoryFilter,
  InventoryRow,
  SortDirection,
} from "../inventoryTypes";
import type { InventoryLocation } from "../../../lib/inventoryApi";
import { ROWS_PER_PAGE } from "../inventoryTypes";

interface UseInventoryFiltersParams {
  rows: InventoryRow[];
  columns: InventoryColumn[];
  /** Structural locations from bootstrap. Replaces `registeredLocations: string[]`. */
  locations: InventoryLocation[];
  /** Currently-scoped location id. `null` means "All Locations". */
  selectedLocationId: string | null;
  initialFilter?: ActiveTab;
  initialSearch?: string;
  userColumnOverrides: ColumnVisibilityOverrides;
  /** Whether inventory is still loading (used to guard tab resets) */
  loading: boolean;
  /** The editing row ID ref — rows being edited always pass through filtering */
  editingRowIdRef: React.RefObject<string | null>;
  /** Recently-edited row ID ref — survives brief blur events (e.g. sort-induced unmount) */
  recentlyEditedRowIdRef: React.RefObject<string | null>;
  /** Anchor row ID that a newly-added row should stay adjacent to during sort */
  newRowAnchorIdRef: React.RefObject<string | null>;
  /** Whether the new row was added above or below the anchor */
  newRowPositionRef: React.RefObject<"above" | "below">;
  /** Pre-edit index of the row currently being edited. When set (and
   *  newRowAnchorIdRef is null), the filters hook pins the editing row at
   *  this index so it doesn't jump around as its sort key changes. */
  editingOriginalIndexRef: React.RefObject<number | null>;
  /** Bumped when editing ends to force filteredRows to re-sort */
  sortEpoch: number;
  /** Per-(item, vendor) pricing rows from the bootstrap (1g). Used to
   *  power the "Missing pricing" filter — items with no entry in this map
   *  have no recorded vendor history at all. */
  vendorPricing: Map<string, Map<string, unknown>>;
}

/** Sentinel id for the "All Locations" view. Empty string keeps it
 *  trivially distinguishable from any UUID. */
export const ALL_LOCATIONS = "" as const;

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

/** A lot's own Min Quantity is "tracked" only when it's a real number > 0.
 *  Blank / null / 0 means "no reorder threshold for this lot" — treated as 0.
 *  Used to keep untracked lots out of the Low Stock tab even when a min-bearing
 *  sibling lot makes the item group low. Mirrors the Reorder tab's per-lot
 *  hasMin check (min=0 is a valid "discontinuing this" signal). */
const rowHasMinQuantity = (row: InventoryRow): boolean => {
  const raw = row.values.minQuantity;
  if (raw === null || raw === undefined || String(raw).trim() === "") return false;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0;
};

function toDateInputValue(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

const normalizeDateForSearch = (
  value: string | number | boolean | null | undefined,
): string[] => {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const iso = toDateInputValue(raw);
  if (!iso) return [raw.toLowerCase()];
  const parsedLocal = new Date(`${iso}T00:00:00`);
  const us = parsedLocal.toLocaleDateString("en-US");
  const usPadded = `${String(parsedLocal.getMonth() + 1).padStart(2, "0")}/${String(parsedLocal.getDate()).padStart(2, "0")}/${parsedLocal.getFullYear()}`;
  const usCompact = us.replace(/\b0(\d)/g, "$1");
  return [
    raw.toLowerCase(),
    iso.toLowerCase(),
    us.toLowerCase(),
    usPadded.toLowerCase(),
    usCompact.toLowerCase(),
  ];
};

function getSortableValue(column: InventoryColumn, value: unknown): string | number | null {
  if (column.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (column.type === "date") {
    const iso = toDateInputValue(value);
    return iso || null;
  }
  return String(value ?? "").trim().toLowerCase();
}

function compareForSort(
  left: string | number | null,
  right: string | number | null,
  direction: SortDirection,
): number {
  const leftMissing = left === null || left === "";
  const rightMissing = right === null || right === "";
  if (leftMissing && rightMissing) return 0;
  // Respect sort direction for empty values so flipping the column header
  // actually moves blank rows between the top and the bottom of the list.
  if (leftMissing) return direction === "asc" ? 1 : -1;
  if (rightMissing) return direction === "asc" ? -1 : 1;

  const base =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));
  return direction === "asc" ? base : -base;
}

export function useInventoryFilters({
  rows,
  columns,
  locations,
  selectedLocationId,
  initialFilter,
  initialSearch,
  userColumnOverrides,
  loading,
  editingRowIdRef,
  recentlyEditedRowIdRef,
  newRowAnchorIdRef,
  newRowPositionRef,
  editingOriginalIndexRef,
  sortEpoch,
  vendorPricing,
}: UseInventoryFiltersParams) {
  // ── Tab state ──
  // "retired" and "pendingSubmissions" were previously stored here.
  // Retired items are now only visible via the Activity page.
  // Pending submissions moved to the Activity page too.
  const VALID_TABS: ActiveTab[] = ["all", "expired", "exp30", "exp60", "lowStock", "missingPricing", "logUsage"];
  const [activeTab, setActiveTabInternal] = useState<ActiveTab>(() => {
    if (initialFilter) return initialFilter;
    try {
      const saved = localStorage.getItem("wickops.inventory.activeTab");
      // "retired" / "pendingSubmissions" / "quickAdd" (Fast Restock, removed)
      // → fall back to "all" so users with stale localStorage land cleanly.
      if (saved === "retired" || saved === "pendingSubmissions" || saved === "quickAdd") return "all";
      if (saved && (VALID_TABS as string[]).includes(saved)) {
        return saved as ActiveTab;
      }
    } catch {}
    return "all";
  });

  const setActiveTabRaw = (tab: ActiveTab) => {
    setActiveTabInternal((prev) => {
      if (prev !== tab) {
        setSelectedRowIds(new Set());
      }
      try { localStorage.setItem("wickops.inventory.activeTab", tab); } catch {}
      return tab;
    });
  };

  const activeFilter: InventoryFilter =
    activeTab === "logUsage" ? "all" : activeTab;
  const setActiveFilter = (f: InventoryFilter) => setActiveTabRaw(f);

  // When navigating from dashboard with a filter, sync the tab
  useEffect(() => {
    if (initialFilter) setActiveTabRaw(initialFilter);
  }, [initialFilter]);

  // ── Sort state ──
  const [sortStateByTab, setSortStateByTab] = useState<Record<string, { key: string; direction: SortDirection } | null>>(() => {
    try {
      const saved = localStorage.getItem("wickops.inventory.sortStateByTab");
      if (saved) return JSON.parse(saved);
      // Migrate legacy single sort state to the "all" tab slot
      const legacy = localStorage.getItem("wickops.inventory.sortState");
      if (legacy) return { all: JSON.parse(legacy) };
    } catch {}
    return { all: { key: "itemName", direction: "asc" as SortDirection } };
  });

  // Derived sort for the current tab
  const sortState = sortStateByTab[activeTab] ?? (activeTab === "all" ? { key: "itemName", direction: "asc" as SortDirection } : null);

  // ── Search state ──
  const [searchTerm, setSearchTerm] = useState(initialSearch ?? "");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(initialSearch ?? "");

  // ── Pagination state ──
  const [currentPage, setCurrentPage] = useState(1);

  // ── Generic groupable-column filters ──
  // Replaces the previous hardcoded category-only state. Map<columnKey, "All" | <value>>.
  // "All" is the sentinel meaning "no filter applied for this groupable column."
  const ALL_GROUPABLE = "__all__" as const;
  const [groupableFilters, setGroupableFilters] = useState<Record<string, string>>({});
  const setGroupableFilter = (columnKey: string, value: string) => {
    setGroupableFilters((prev) => {
      if (value === ALL_GROUPABLE) {
        // Strip the entry instead of holding a sentinel — keeps the map small.
        if (!(columnKey in prev)) return prev;
        const next = { ...prev };
        delete next[columnKey];
        return next;
      }
      return { ...prev, [columnKey]: value };
    });
  };

  // ── Selection state (needed here for setActiveTabRaw clearing) ──
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  // ── Debounce search ──
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // ── Derived column values ──
  const allColumns = useMemo(
    () => [...columns].sort((a, b) => a.sortOrder - b.sortOrder),
    [columns],
  );

  const hasExpirationColumn = columns.some(
    (column) => column.key === "expirationDate" && column.isVisible,
  );
  const hasMinQuantityColumn = columns.some(
    (column) => column.key === "minQuantity" && column.isVisible,
  );

  // Resolve the effective scope. `selectedLocationId` is one of:
  //   - a real location id (filter to that location)
  //   - `null` (no preference set — pick the first location)
  //   - ALL_LOCATIONS (show every location's items)
  const locationById = useMemo(
    () => new Map(locations.map((l) => [l.id, l])),
    [locations],
  );
  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [locations],
  );

  const effectiveLocationId: string =
    selectedLocationId !== null && (selectedLocationId === ALL_LOCATIONS || locationById.has(selectedLocationId))
      ? selectedLocationId
      : sortedLocations.length > 0
      ? sortedLocations[0].id
      : ALL_LOCATIONS;

  const effectiveLocationName: string =
    effectiveLocationId === ALL_LOCATIONS
      ? "All Locations"
      : locationById.get(effectiveLocationId)?.name ?? "All Locations";

  const showLocationPills = sortedLocations.length >= 1;

  // visibleColumns post-restructure:
  //   - core columns always render
  //   - custom columns render only when their attachedLocationIds includes the
  //     current location id
  //   - "All Locations" view shows core columns only (custom cells would be
  //     ambiguous because attachment varies per location)
  const visibleColumns = useMemo(
    () => {
      const base = [...columns]
        .filter((column) => {
          const override = userColumnOverrides[column.id];
          return override !== undefined ? override : column.isVisible;
        })
        .filter((column) => {
          if (column.isCore) return true;
          if (effectiveLocationId === ALL_LOCATIONS) return false;
          const attached = column.attachedLocationIds ?? [];
          return attached.includes(effectiveLocationId);
        })
        .sort((a, b) => a.sortOrder - b.sortOrder);
      return base;
    },
    [columns, userColumnOverrides, effectiveLocationId],
  );

  // Per-groupable-column option lists. Built dynamically for every visible
  // column with isGroupable: true. Replaces the previous category-only path.
  const groupableColumnOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of visibleColumns) {
      if (!col.isGroupable) continue;
      const values = Array.from(
        new Set(
          rows
            .map((row) => String(row.values[col.key] ?? "").trim())
            .filter((v) => v.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b));
      out[col.key] = values;
    }
    return out;
  }, [rows, visibleColumns]);

  // Low stock is an ITEM-level signal, not a per-lot one: a single lot hitting
  // 0 doesn't mean the item needs reordering if its other lots still cover the
  // minimum. Mirror the Reorder/Shop aggregation rule (see ShoppingListTab.tsx)
  // — group lots by (location, lowercased itemName), SUM quantity across lots,
  // take the MAX minQuantity, and flag the whole group low only when the total
  // on-hand is below that threshold. Keyed by location so each location's stock
  // is its own pool (a different cabinet's overstock can't mask a low one).
  const lowStockItemKeys = useMemo(() => {
    const lowStockKeyForRow = (row: InventoryRow): string => {
      const name = String(row.values.itemName ?? "").trim().toLowerCase();
      // Blank-name rows can't be grouped meaningfully — key by id so each one
      // stands alone (falls back to the old per-row behavior for that row).
      return name ? `${row.locationId}::${name}` : `id:${row.id}`;
    };
    const agg = new Map<string, { totalQty: number; maxMin: number }>();
    for (const row of rows) {
      if (row.values.retiredAt) continue;
      // NOTE: already-ordered lots are NOT skipped here. A pending order hasn't
      // arrived, so you're still physically below par — the item stays in Low
      // Stock (and the dashboard) until the order is received. Only the Reorder
      // list hides ordered items, since there's nothing left to buy. So Low
      // Stock = dashboard, and Reorder = that set minus what's already on order.
      const key = lowStockKeyForRow(row);
      const qty = Number(row.values.quantity);
      const min = Number(row.values.minQuantity);
      const entry = agg.get(key) ?? { totalQty: 0, maxMin: 0 };
      // Expired-but-not-retired stock STILL counts toward on-hand — it's
      // physically on the shelf. Expiry is its own workflow (the Expired tab);
      // retiring an expired lot zeroes its quantity, and THAT is what can drop
      // an item below par into Low Stock. Matches the Shop reorder list. The min
      // is the item's threshold, not a per-lot value ("highest min wins").
      if (Number.isFinite(qty)) entry.totalQty += qty;
      if (Number.isFinite(min) && min > entry.maxMin) entry.maxMin = min;
      agg.set(key, entry);
    }
    const lowKeys = new Set<string>();
    for (const [key, { totalQty, maxMin }] of agg) {
      if (maxMin > 0 && totalQty < maxMin) lowKeys.add(key);
    }
    return lowKeys;
  }, [rows]);

  // Same keying as the aggregation above — used to test a row against the
  // precomputed set of low item-groups.
  const lowStockKeyForRow = (row: InventoryRow): string => {
    const name = String(row.values.itemName ?? "").trim().toLowerCase();
    return name ? `${row.locationId}::${name}` : `id:${row.id}`;
  };

  const tabCounts = useMemo(() => {
    let expired = 0;
    let exp30 = 0;
    let exp60 = 0;
    let retired = 0;
    let missingPricing = 0;
    // Low stock counts distinct ITEMS, not lots — so the badge matches the
    // dashboard's "N items low" and the Reorder list. A multi-lot low item is
    // one entry here even though the tab still lists each of its lots.
    const lowItemKeys = new Set<string>();
    for (const row of rows) {
      if (effectiveLocationId !== ALL_LOCATIONS && row.locationId !== effectiveLocationId) continue;
      const isRetired = Boolean(row.values.retiredAt);
      if (isRetired) retired++;
      const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
      // Retired rows don't count as expired — they've already been handled, even
      // though their expirationDate is still in the past for history.
      // Today (daysUntil === 0) counts as expired: by end-of-day the item is past.
      const isExpired = !isRetired && daysUntil !== null && daysUntil <= 0;
      if (isExpired) expired++;
      if (!isRetired && daysUntil !== null && daysUntil > 0 && daysUntil <= 30) exp30++;
      if (!isRetired && daysUntil !== null && daysUntil > 0 && daysUntil <= 60) exp60++;
      // Retired rows are hidden from the inventory grid (see filteredRows), so
      // they shouldn't inflate the Low Stock badge count either — the Reorder
      // tab reads them directly for reorder surfacing. Low stock is aggregated
      // across all lots of the item (see lowStockItemKeys above), so an
      // overstocked item with one zeroed lot no longer counts.
      // ...and the lot itself must carry a min — a blank-min lot is untracked,
      // so it neither counts nor shows in Low Stock even if a sibling lot of
      // the same item triggers the group.
      const isLowStock =
        !isRetired && rowHasMinQuantity(row) && lowStockItemKeys.has(lowStockKeyForRow(row));
      if (isLowStock) lowItemKeys.add(lowStockKeyForRow(row));
      // Missing pricing: a non-retired item with no vendorPricing entries.
      // After 1g.7's migration, items that had vendor + pricing already
      // carry a row, so anything still missing is genuinely uncovered.
      const hasAnyPricing = (vendorPricing.get(row.id)?.size ?? 0) > 0;
      if (!isRetired && !hasAnyPricing) missingPricing++;
    }
    return { expired, exp30, exp60, lowStock: lowItemKeys.size, retired, missingPricing };
  }, [rows, effectiveLocationId, vendorPricing, lowStockItemKeys]);

  // ── THE BIG filteredRows memo ──
  const filteredRows = useMemo(() => {
    const normalizedSearch = debouncedSearchTerm.trim().toLowerCase();

    const filtered = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        // Search always applies — a user-initiated query shouldn't keep stale
        // selections (editing/recently-edited) pinned in the results.
        if (normalizedSearch) {
          const matchesSearch = visibleColumns.some((column) => {
            if (column.type === "date" || column.key === "expirationDate") {
              return normalizeDateForSearch(row.values[column.key]).some((value) =>
                value.includes(normalizedSearch),
              );
            }
            return String(row.values[column.key] ?? "")
              .toLowerCase()
              .includes(normalizedSearch);
          });
          if (!matchesSearch) return false;
        }

        // Tab + groupable filters are bypassed for the row being edited (and
        // briefly after) so its values can change mid-edit without the row
        // disappearing. Location is NOT bypassed — it's structural now and
        // doesn't mutate while editing, so leaving it bypassed caused the
        // edit-pinned row to flicker into the wrong location's view when
        // the user switched scope.
        const isPinnedRow =
          (editingRowIdRef.current && row.id === editingRowIdRef.current)
          || (recentlyEditedRowIdRef.current && row.id === recentlyEditedRowIdRef.current);
        if (isPinnedRow && effectiveLocationId !== ALL_LOCATIONS && row.locationId !== effectiveLocationId) {
          // Pinned but in a different location → hide. Editing continues in
          // the original scope; switching back will surface it again.
          return false;
        }
        if (isPinnedRow) return true;
        const daysUntil = getDaysUntilExpiration(row.values.expirationDate);

        // Retired rows are preserved in storage so retirement history survives
        // for loss analytics and the Activity page audit trail. They are NOT
        // surfaced in the inventory grid or the Reorder tab (see ReorderTab.tsx
        // which filters retiredAt explicitly). Leaving them in the main grid
        // just creates noise.
        const isRetired = Boolean(row.values.retiredAt);
        if (isRetired) return false;

        let passesTab = true;
        if (activeFilter === "lowStock") {
          // Item-level: a lot only shows here when its item-group's TOTAL
          // on-hand is below the (max) minimum. An overstocked item with one
          // zeroed lot drops out entirely — no placeholder row (unlike the
          // expiry tabs, which keep the lot to surface the date). The lot must
          // also carry its own min — blank-min ("untracked") lots stay out
          // even when a min-bearing sibling makes the item group low.
          passesTab = rowHasMinQuantity(row) && lowStockItemKeys.has(lowStockKeyForRow(row));
        }
        if (activeFilter === "expired") passesTab = daysUntil !== null && daysUntil <= 0;
        if (activeFilter === "exp30") passesTab = daysUntil !== null && daysUntil > 0 && daysUntil <= 30;
        if (activeFilter === "exp60") passesTab = daysUntil !== null && daysUntil > 0 && daysUntil <= 60;
        if (activeFilter === "missingPricing") {
          passesTab = (vendorPricing.get(row.id)?.size ?? 0) === 0;
        }
        if (!passesTab) return false;

        // Structural location filter (replaces the old values.location compare).
        if (effectiveLocationId !== ALL_LOCATIONS && row.locationId !== effectiveLocationId) {
          return false;
        }

        // Generic groupable-column filters. Empty cell values bypass the
        // filter (so a row with no category isn't hidden when filtering by
        // a specific category — matches the prior behavior exactly).
        for (const [columnKey, selectedValue] of Object.entries(groupableFilters)) {
          if (!selectedValue) continue;
          const cellValue = String(row.values[columnKey] ?? "").trim();
          if (cellValue === "" || cellValue === selectedValue) continue;
          return false;
        }

        return true;
      });

    // If a *newly added* row has an anchor, pull it out before sorting so it
    // doesn't get pushed to the end (blank values sort last). After sorting we
    // reinsert it next to its anchor row.
    //
    // For an *edit on an existing row*, we pull the row out too and pin it at
    // its pre-edit filteredRows index (editingOriginalIndexRef) so it doesn't
    // jump around as its sort key (e.g. item name) changes per keystroke. The
    // row re-sorts normally after blur (endCellEditSession clears the ref).
    const anchorId = newRowAnchorIdRef.current;
    // Fall back to recentlyEditedRowIdRef so the row stays pinned through the
    // blur→focus gap when tabbing between cells of the same row — the pin is
    // only fully released on row switch or when the grace timer expires.
    const editingId = editingRowIdRef.current ?? recentlyEditedRowIdRef.current;
    const editingOriginalIdx = editingOriginalIndexRef.current;
    let newRowEntry: (typeof filtered)[number] | null = null;
    let toSort = filtered;
    let editEntry: (typeof filtered)[number] | null = null;
    if (editingId && anchorId) {
      // Newly added row — uses the existing anchor-based reinsertion path.
      const idx = filtered.findIndex(({ row }) => row.id === editingId);
      if (idx >= 0) {
        newRowEntry = filtered[idx];
        toSort = filtered.filter(({ row }) => row.id !== editingId);
      }
    } else if (editingId && editingOriginalIdx !== null) {
      // Existing row being edited — pin to its pre-edit index.
      const idx = filtered.findIndex(({ row }) => row.id === editingId);
      if (idx >= 0) {
        editEntry = filtered[idx];
        toSort = filtered.filter(({ row }) => row.id !== editingId);
      }
    }

    let sorted = toSort;
    if (activeFilter === "expired" || activeFilter === "exp30" || activeFilter === "exp60") {
      sorted = [...toSort].sort((a, b) => {
        const aDays = getDaysUntilExpiration(a.row.values.expirationDate);
        const bDays = getDaysUntilExpiration(b.row.values.expirationDate);
        if (aDays === null && bDays === null) return a.index - b.index;
        if (aDays === null) return 1;
        if (bDays === null) return -1;
        if (aDays !== bDays) return aDays - bDays;
        return a.index - b.index;
      });
    } else if (activeFilter === "lowStock") {
      sorted = [...toSort].sort((a, b) => {
        const aQty = Number(a.row.values.quantity);
        const bQty = Number(b.row.values.quantity);
        const safeA = Number.isFinite(aQty) ? aQty : Number.POSITIVE_INFINITY;
        const safeB = Number.isFinite(bQty) ? bQty : Number.POSITIVE_INFINITY;
        if (safeA !== safeB) return safeA - safeB;
        return a.index - b.index;
      });
    }

    const tabSort = sortStateByTab[activeTab] ?? (activeTab === "all" ? { key: "itemName", direction: "asc" as SortDirection } : null);
    if (tabSort) {
      const sortColumn = visibleColumns.find((column) => column.key === tabSort.key);
      if (sortColumn) {
        sorted = [...sorted].sort((a, b) => {
          const left = getSortableValue(sortColumn, a.row.values[sortColumn.key]);
          const right = getSortableValue(sortColumn, b.row.values[sortColumn.key]);
          const cmp = compareForSort(left, right, tabSort.direction);
          return cmp !== 0 ? cmp : a.index - b.index;
        });
      }
    }

    // Reinsert the newly-added row next to its anchor. (Only possible when
    // both `newRowEntry` and `anchorId` are set — the extraction above is
    // gated on that, so this branch is the only reinsertion path.)
    if (newRowEntry && anchorId) {
      sorted = [...sorted];
      const anchorIdx = sorted.findIndex(({ row }) => row.id === anchorId);
      if (anchorIdx >= 0) {
        const insertAt = newRowPositionRef.current === "above" ? anchorIdx : anchorIdx + 1;
        sorted.splice(insertAt, 0, newRowEntry);
      } else {
        sorted.push(newRowEntry);
      }
    }

    // Reinsert the currently-edited existing row at its pre-edit index so
    // it stays put while the user is typing. Clamped to the sorted array
    // bounds in case other rows were added/removed.
    if (editEntry && editingOriginalIdx !== null) {
      sorted = [...sorted];
      const insertAt = Math.max(0, Math.min(editingOriginalIdx, sorted.length));
      sorted.splice(insertAt, 0, editEntry);
    }

    // Low Stock shows ONE row per item. A depleted item with several lots
    // (e.g. 5× "0/2 Sodium Chloride" at different dates) collapses to a single
    // representative — after the qty-asc sort that's the lowest/representative
    // lot. The badge already counts distinct items, so this makes the visible
    // row count match the badge, the dashboard, and the Reorder list. A row
    // pinned for editing is never collapsed away.
    if (activeFilter === "lowStock") {
      const seenKeys = new Set<string>();
      sorted = sorted.filter(({ row }) => {
        if (editingId && row.id === editingId) return true;
        const key = lowStockKeyForRow(row);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
    }

    return sorted;
  }, [
    rows,
    activeFilter,
    activeTab,
    visibleColumns,
    debouncedSearchTerm,
    effectiveLocationId,
    groupableFilters,
    sortStateByTab,
    sortEpoch,
    vendorPricing,
    lowStockItemKeys,
  ]);

  const filteredRowIds = useMemo(
    () => filteredRows.map(({ row }) => row.id),
    [filteredRows],
  );

  // ── Pagination ──
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * ROWS_PER_PAGE;
  const paginatedRows = filteredRows.slice(pageStart, pageStart + ROWS_PER_PAGE);

  // Reset page on filter or sort change
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm, activeFilter, effectiveLocationId, groupableFilters, sortStateByTab]);

  // Reset invalid filter tabs when columns change
  useEffect(() => {
    // Don't reset tabs while inventory is still loading -- columns aren't available yet
    if (loading) return;
    if (!hasExpirationColumn && (activeFilter === "expired" || activeFilter === "exp30" || activeFilter === "exp60")) {
      setActiveFilter("all");
      return;
    }
    if (!hasMinQuantityColumn && activeFilter === "lowStock") {
      setActiveFilter("all");
    }
  }, [activeFilter, hasExpirationColumn, hasMinQuantityColumn, loading]);

  // ── Sort handler ──
  const onSortColumn = (column: InventoryColumn) => {
    const prev = sortStateByTab[activeTab] ?? null;
    const next = (!prev || prev.key !== column.key)
      ? { key: column.key, direction: "asc" as SortDirection }
      : { key: column.key, direction: prev.direction === "asc" ? "desc" as SortDirection : "asc" as SortDirection };
    setSortStateByTab((prevMap) => {
      const nextMap = { ...prevMap, [activeTab]: next };
      try { localStorage.setItem("wickops.inventory.sortStateByTab", JSON.stringify(nextMap)); } catch {}
      return nextMap;
    });
  };

  return {
    // Tab
    activeTab,
    setActiveTabRaw,
    activeFilter,
    setActiveFilter,
    // Sort
    sortState,
    sortStateByTab,
    setSortStateByTab,
    onSortColumn,
    // Search
    searchTerm,
    setSearchTerm,
    debouncedSearchTerm,
    // Pagination
    currentPage,
    setCurrentPage,
    totalPages,
    safePage,
    pageStart,
    paginatedRows,
    // Generic groupable filters (replaces category-specific state)
    groupableFilters,
    setGroupableFilter,
    groupableColumnOptions,
    ALL_GROUPABLE,
    // Columns
    allColumns,
    hasExpirationColumn,
    hasMinQuantityColumn,
    visibleColumns,
    // Locations
    sortedLocations,
    locationById,
    showLocationPills,
    effectiveLocationId,
    effectiveLocationName,
    ALL_LOCATIONS,
    // Rows
    filteredRows,
    filteredRowIds,
    tabCounts,
    // Selection (filter-level)
    selectedRowIds,
    setSelectedRowIds,
    // Helpers exported for use in data hook / components
    getDaysUntilExpiration,
    toDateInputValue,
    normalizeDateForSearch,
  };
}
