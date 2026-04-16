import { useEffect, useMemo, useState } from "react";
import type {
  ActiveTab,
  ColumnVisibilityOverrides,
  InventoryColumn,
  InventoryFilter,
  InventoryRow,
  SortDirection,
} from "../inventoryTypes";
import { ROWS_PER_PAGE } from "../inventoryTypes";

interface UseInventoryFiltersParams {
  rows: InventoryRow[];
  columns: InventoryColumn[];
  registeredLocations: string[];
  selectedLocation: string | null;
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
  /** Bumped when editing ends to force filteredRows to re-sort */
  sortEpoch: number;
}

const UNASSIGNED_LOCATION = "Unassigned";

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
  registeredLocations,
  selectedLocation,
  initialFilter,
  initialSearch,
  userColumnOverrides,
  loading,
  editingRowIdRef,
  recentlyEditedRowIdRef,
  newRowAnchorIdRef,
  newRowPositionRef,
  sortEpoch,
}: UseInventoryFiltersParams) {
  // ── Tab state ──
  // "retired" and "pendingSubmissions" were previously stored here.
  // Retired items are now only visible via the Activity page.
  // Pending submissions moved to the Activity page too.
  const VALID_TABS: ActiveTab[] = ["all", "expired", "exp30", "exp60", "lowStock", "quickAdd", "logUsage"];
  const [activeTab, setActiveTabInternal] = useState<ActiveTab>(() => {
    if (initialFilter) return initialFilter;
    try {
      const saved = localStorage.getItem("wickops.inventory.activeTab");
      if (saved === "retired" || saved === "pendingSubmissions") return "all";
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
    activeTab === "quickAdd" || activeTab === "logUsage" ? "all" : activeTab;
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

  // ── Category filter ──
  const [categoryFilter, setCategoryFilter] = useState("All Categories");

  // ── Selection state (needed here for setActiveTabRaw clearing) ──
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  // ── Debounce search ──
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // ── Derived column values ──
  const locationColumn = useMemo(
    () => columns.find((column) => column.key === "location"),
    [columns],
  );

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

  const locationOptions = useMemo(() => {
    const fromItems = locationColumn
      ? rows.map((row) => String(row.values[locationColumn.key] ?? "").trim()).filter((v) => v.length > 0)
      : [];
    const named = Array.from(new Set([...fromItems, ...registeredLocations])).sort((a, b) => a.localeCompare(b));
    // Only show "Unassigned" when there are rows with real data that lack a location.
    // A row counts as "has data" if any non-location field has a non-empty, non-zero value.
    const hasUnassigned = locationColumn
      ? rows.some((row) => {
          const loc = String(row.values[locationColumn.key] ?? "").trim();
          if (loc !== "") return false;
          // Check if row has any meaningful content
          return Object.entries(row.values).some(([key, val]) => {
            if (key === locationColumn.key) return false;
            if (val === null || val === undefined || val === "" || val === 0) return false;
            return true;
          });
        })
      : false;
    if (hasUnassigned && named.length > 0) named.push(UNASSIGNED_LOCATION);
    return named;
  }, [rows, locationColumn, registeredLocations]);

  const showLocationPills = locationOptions.length >= 1;

  // Hide location column from table when location pills are active (redundant info)
  const visibleColumns = useMemo(
    () => {
      const base = [...columns]
        .filter((column) => {
          const override = userColumnOverrides[column.id];
          return override !== undefined ? override : column.isVisible;
        })
        .sort((a, b) => a.sortOrder - b.sortOrder);
      return showLocationPills ? base.filter((c) => c.key !== "location") : base;
    },
    [columns, userColumnOverrides, showLocationPills],
  );

  const categoryColumn = useMemo(
    () => visibleColumns.find((column) => column.key === "category"),
    [visibleColumns],
  );

  const effectiveLocationFilter = selectedLocation !== null && locationOptions.includes(selectedLocation)
    ? selectedLocation
    : locationOptions.length > 0 ? locationOptions[0] : "All Locations";

  const categoryOptions = useMemo(() => {
    if (!categoryColumn) return ["All Categories"];
    const options = Array.from(
      new Set(
        rows
          .map((row) => String(row.values[categoryColumn.key] ?? "").trim())
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return ["All Categories", ...options];
  }, [rows, categoryColumn]);

  const effectiveCategoryFilter = categoryOptions.includes(categoryFilter)
    ? categoryFilter
    : "All Categories";

  const tabCounts = useMemo(() => {
    let expired = 0;
    let exp30 = 0;
    let exp60 = 0;
    let lowStock = 0;
    let retired = 0;
    for (const row of rows) {
      if (locationColumn && effectiveLocationFilter !== "All Locations") {
        const rowLocation = String(row.values[locationColumn.key] ?? "").trim();
        const matchesLocation = effectiveLocationFilter === UNASSIGNED_LOCATION
          ? rowLocation === ""
          : rowLocation === effectiveLocationFilter;
        if (!matchesLocation) continue;
      }
      const isRetired = Boolean(row.values.retiredAt);
      if (isRetired) retired++;
      const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
      // Retired rows don't count as expired — they've already been handled, even
      // though their expirationDate is still in the past for history.
      const isExpired = !isRetired && daysUntil !== null && daysUntil < 0;
      if (isExpired) expired++;
      if (!isRetired && daysUntil !== null && daysUntil >= 0 && daysUntil <= 30) exp30++;
      if (!isRetired && daysUntil !== null && daysUntil >= 0 && daysUntil <= 60) exp60++;
      const quantityRaw = row.values.quantity;
      const minQuantityRaw = row.values.minQuantity;
      const quantity = Number(quantityRaw);
      const minQuantity = Number(minQuantityRaw);
      const hasMin =
        minQuantityRaw !== null &&
        minQuantityRaw !== undefined &&
        String(minQuantityRaw).trim() !== "" &&
        Number.isFinite(minQuantity) &&
        minQuantity > 0;
      // Retired rows are skeleton rows — they participate in reorder logic so the
      // system treats "retired" the same as "depleted". Both need restocking.
      const isLowStock = hasMin && Number.isFinite(quantity) && quantity < minQuantity;
      if (isLowStock) lowStock++;
    }
    return { expired, exp30, exp60, lowStock, retired };
  }, [rows, locationColumn, effectiveLocationFilter]);

  // ── THE BIG filteredRows memo ──
  const filteredRows = useMemo(() => {
    const normalizedSearch = debouncedSearchTerm.trim().toLowerCase();

    const filtered = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (editingRowIdRef.current && row.id === editingRowIdRef.current) return true;
        if (recentlyEditedRowIdRef.current && row.id === recentlyEditedRowIdRef.current) return true;
        const quantityRaw = row.values.quantity;
        const minQuantityRaw = row.values.minQuantity;
        const quantity = Number(quantityRaw);
        const minQuantity = Number(minQuantityRaw);
        const hasMinQuantity =
          minQuantityRaw !== null &&
          minQuantityRaw !== undefined &&
          String(minQuantityRaw).trim() !== "" &&
          Number.isFinite(minQuantity) &&
          minQuantity > 0;
        const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
        const rowLocation = String(row.values.location ?? "").trim();
        const rowCategory = String(row.values.category ?? "").trim();

        // Retired rows stay as zero-qty skeleton rows so reorder logic still
        // sees them (qty < min → flagged for reorder). They're only suppressed
        // from expiration-based tabs where they'd be noise.
        const isRetired = Boolean(row.values.retiredAt);

        let passesTab = true;
        if (activeFilter === "lowStock") {
          passesTab = hasMinQuantity && Number.isFinite(quantity) && quantity < minQuantity;
        }
        if (activeFilter === "expired") passesTab = !isRetired && daysUntil !== null && daysUntil < 0;
        if (activeFilter === "exp30") passesTab = !isRetired && daysUntil !== null && daysUntil >= 0 && daysUntil <= 30;
        if (activeFilter === "exp60") passesTab = !isRetired && daysUntil !== null && daysUntil >= 0 && daysUntil <= 60;
        if (!passesTab) return false;

        if (locationColumn && effectiveLocationFilter !== "All Locations") {
          const matchesLocation = effectiveLocationFilter === UNASSIGNED_LOCATION
            ? rowLocation === ""
            : rowLocation === effectiveLocationFilter;
          if (!matchesLocation) return false;
        }
        if (categoryColumn && effectiveCategoryFilter !== "All Categories" && rowCategory !== "" && rowCategory !== effectiveCategoryFilter) {
          return false;
        }

        if (!normalizedSearch) return true;
        return visibleColumns.some((column) => {
          if (column.type === "date" || column.key === "expirationDate") {
            return normalizeDateForSearch(row.values[column.key]).some((value) =>
              value.includes(normalizedSearch),
            );
          }
          return String(row.values[column.key] ?? "")
            .toLowerCase()
            .includes(normalizedSearch);
        });
      });

    // If a new row has an anchor, pull it out before sorting so it doesn't
    // get pushed to the end (blank values sort last). After sorting we
    // reinsert it next to its anchor row.
    const anchorId = newRowAnchorIdRef.current;
    const editingId = editingRowIdRef.current;
    let newRowEntry: (typeof filtered)[number] | null = null;
    let toSort = filtered;
    if (editingId) {
      const idx = filtered.findIndex(({ row }) => row.id === editingId);
      if (idx >= 0) {
        newRowEntry = filtered[idx];
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

    // Reinsert new row next to its anchor, or at the top if no anchor
    if (newRowEntry) {
      sorted = [...sorted];
      if (anchorId) {
        const anchorIdx = sorted.findIndex(({ row }) => row.id === anchorId);
        if (anchorIdx >= 0) {
          const insertAt = newRowPositionRef.current === "above" ? anchorIdx : anchorIdx + 1;
          sorted.splice(insertAt, 0, newRowEntry);
        } else {
          sorted.push(newRowEntry);
        }
      } else {
        // No anchor — place at top so user sees it immediately
        sorted.unshift(newRowEntry);
      }
    }

    return sorted;
  }, [
    rows,
    activeFilter,
    activeTab,
    visibleColumns,
    debouncedSearchTerm,
    locationColumn,
    effectiveLocationFilter,
    categoryColumn,
    effectiveCategoryFilter,
    sortStateByTab,
    sortEpoch,
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
  }, [debouncedSearchTerm, activeFilter, effectiveLocationFilter, effectiveCategoryFilter, sortStateByTab]);

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
    // Category
    categoryFilter,
    setCategoryFilter,
    categoryOptions,
    effectiveCategoryFilter,
    // Columns
    locationColumn,
    allColumns,
    hasExpirationColumn,
    hasMinQuantityColumn,
    visibleColumns,
    categoryColumn,
    // Locations
    locationOptions,
    showLocationPills,
    effectiveLocationFilter,
    UNASSIGNED_LOCATION,
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
