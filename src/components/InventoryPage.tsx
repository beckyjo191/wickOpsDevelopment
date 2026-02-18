import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  importInventoryCsv,
  loadInventoryBootstrap,
  saveInventoryItems,
  updateInventoryColumnVisibility,
  type InventoryColumn,
  type InventoryRow,
} from "../lib/inventoryApi";

type InventoryFilter = "all" | "expired" | "exp30" | "exp60" | "lowStock";
type SortDirection = "asc" | "desc";

interface InventoryPageProps {
  canEditInventory: boolean;
  canManageInventoryColumns: boolean;
}

const NUMBER_COLUMN_KEYS = new Set(["quantity", "minQuantity"]);
const AUTOSAVE_DELAY_MS = 20000;
const COLUMN_WIDTHS_STORAGE_KEY_PREFIX = "wickops.inventory.columnWidths:";

const createBlankInventoryRow = (
  columns: InventoryColumn[],
  position: number,
): InventoryRow => {
  const values: Record<string, string | number | boolean | null> = {};
  for (const column of columns) {
    values[column.key] = column.type === "number" ? 0 : "";
  }
  return {
    id: crypto.randomUUID(),
    position,
    values,
  };
};

export function InventoryPage({
  canEditInventory,
  canManageInventoryColumns,
}: InventoryPageProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [importingCsv, setImportingCsv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeFilter, setActiveFilter] = useState<InventoryFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [locationFilter, setLocationFilter] = useState("All Locations");
  const [categoryFilter, setCategoryFilter] = useState("All Categories");
  const [sortState, setSortState] = useState<{ key: string; direction: SortDirection } | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());
  const [deletedRowIds, setDeletedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [editingLinkCell, setEditingLinkCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const resizeStateRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const canEditTable = canEditInventory && activeFilter === "all";

  const applyBootstrap = (bootstrap: Awaited<ReturnType<typeof loadInventoryBootstrap>>) => {
    const resolvedColumns = [...bootstrap.columns].sort(
      (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
    );
    const persistedRows = bootstrap.items;
    setOrganizationId(String(bootstrap.access?.organizationId ?? ""));
    setColumns(resolvedColumns);
    const nextRows =
      persistedRows.length > 0
        ? persistedRows
        : [createBlankInventoryRow(resolvedColumns, 0)];
    setRows(nextRows);
    setDirtyRowIds(new Set());
    setDeletedRowIds(new Set());
    setSelectedRowIds(new Set());
    setSelectedRowId(nextRows[0]?.id ?? null);
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError("");

      try {
        const bootstrap = await loadInventoryBootstrap();
        if (cancelled) return;
        applyBootstrap(bootstrap);
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err?.message ?? "Failed to load inventory");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleColumns = useMemo(
    () =>
      [...columns]
        .filter((column) => column.isVisible)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [columns],
  );
  const hasExpirationColumn = columns.some(
    (column) => column.key === "expirationDate" && column.isVisible,
  );
  const hasMinQuantityColumn = columns.some(
    (column) => column.key === "minQuantity" && column.isVisible,
  );

  const locationColumn = useMemo(
    () => visibleColumns.find((column) => column.key === "location"),
    [visibleColumns],
  );
  const categoryColumn = useMemo(
    () => visibleColumns.find((column) => column.key === "category"),
    [visibleColumns],
  );

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

  const normalizeDateForSearch = (
    value: string | number | boolean | null | undefined,
  ): string[] => {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return [raw.toLowerCase()];
    const iso = parsed.toISOString().slice(0, 10);
    const us = parsed.toLocaleDateString("en-US");
    return [raw.toLowerCase(), iso.toLowerCase(), us.toLowerCase()];
  };

  const locationOptions = useMemo(() => {
    if (!locationColumn) return ["All Locations"];
    const options = Array.from(
      new Set(
        rows
          .map((row) => String(row.values[locationColumn.key] ?? "").trim())
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return ["All Locations", ...options];
  }, [rows, locationColumn]);

  const effectiveLocationFilter = locationOptions.includes(locationFilter)
    ? locationFilter
    : "All Locations";
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

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    const filtered = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const quantityRaw = row.values.quantity;
        const minQuantityRaw = row.values.minQuantity;
        const quantity = Number(quantityRaw);
        const minQuantity = Number(minQuantityRaw);
        const hasMinQuantity =
          minQuantityRaw !== null &&
          minQuantityRaw !== undefined &&
          String(minQuantityRaw).trim() !== "" &&
          Number.isFinite(minQuantity);
        const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
        const rowLocation = String(row.values.location ?? "").trim();
        const rowCategory = String(row.values.category ?? "").trim();

        let passesTab = true;
        if (activeFilter === "lowStock") {
          passesTab = hasMinQuantity && Number.isFinite(quantity) && quantity < minQuantity;
        }
        if (activeFilter === "expired") passesTab = daysUntil !== null && daysUntil < 0;
        if (activeFilter === "exp30") passesTab = daysUntil !== null && daysUntil >= 0 && daysUntil <= 30;
        if (activeFilter === "exp60") passesTab = daysUntil !== null && daysUntil >= 0 && daysUntil <= 60;
        if (!passesTab) return false;

        if (locationColumn && effectiveLocationFilter !== "All Locations" && rowLocation !== effectiveLocationFilter) {
          return false;
        }
        if (categoryColumn && effectiveCategoryFilter !== "All Categories" && rowCategory !== effectiveCategoryFilter) {
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

    let sorted = filtered;
    if (activeFilter === "expired" || activeFilter === "exp30" || activeFilter === "exp60") {
      sorted = [...filtered].sort((a, b) => {
        const aDays = getDaysUntilExpiration(a.row.values.expirationDate);
        const bDays = getDaysUntilExpiration(b.row.values.expirationDate);
        if (aDays === null && bDays === null) return a.index - b.index;
        if (aDays === null) return 1;
        if (bDays === null) return -1;
        if (aDays !== bDays) return aDays - bDays;
        return a.index - b.index;
      });
    } else if (activeFilter === "lowStock") {
      sorted = [...filtered].sort((a, b) => {
        const aQty = Number(a.row.values.quantity);
        const bQty = Number(b.row.values.quantity);
        const safeA = Number.isFinite(aQty) ? aQty : Number.POSITIVE_INFINITY;
        const safeB = Number.isFinite(bQty) ? bQty : Number.POSITIVE_INFINITY;
        if (safeA !== safeB) return safeA - safeB;
        return a.index - b.index;
      });
    }

    if (sortState) {
      const sortColumn = visibleColumns.find((column) => column.key === sortState.key);
      if (sortColumn) {
        sorted = [...sorted].sort((a, b) => {
          const left = getSortableValue(sortColumn, a.row.values[sortColumn.key]);
          const right = getSortableValue(sortColumn, b.row.values[sortColumn.key]);
          const cmp = compareForSort(left, right, sortState.direction);
          return cmp !== 0 ? cmp : a.index - b.index;
        });
      }
    }

    return sorted;
  }, [
    rows,
    activeFilter,
    visibleColumns,
    searchTerm,
    locationColumn,
    effectiveLocationFilter,
    categoryColumn,
    effectiveCategoryFilter,
    sortState,
  ]);

  const filteredRowIds = useMemo(
    () => filteredRows.map(({ row }) => row.id),
    [filteredRows],
  );

  const selectedFilteredCount = useMemo(
    () => filteredRowIds.filter((rowId) => selectedRowIds.has(rowId)).length,
    [filteredRowIds, selectedRowIds],
  );

  const allFilteredSelected = filteredRowIds.length > 0 && selectedFilteredCount === filteredRowIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;

  useEffect(() => {
    if (!hasExpirationColumn && (activeFilter === "expired" || activeFilter === "exp30" || activeFilter === "exp60")) {
      setActiveFilter("all");
      return;
    }
    if (!hasMinQuantityColumn && activeFilter === "lowStock") {
      setActiveFilter("all");
    }
  }, [activeFilter, hasExpirationColumn, hasMinQuantityColumn]);

  useEffect(() => {
    if (!selectAllCheckboxRef.current) return;
    selectAllCheckboxRef.current.indeterminate = someFilteredSelected;
  }, [someFilteredSelected]);

  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedRowId(null);
      return;
    }
    if (!filteredRows.some(({ row }) => row.id === selectedRowId)) {
      setSelectedRowId(filteredRows[0].row.id);
    }
  }, [filteredRows, selectedRowId]);

  useEffect(() => {
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(rows.map((row) => row.id));
      const filtered = new Set(Array.from(prev).filter((rowId) => validIds.has(rowId)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [rows]);

  const onAddRow = () => {
    if (!canEditTable) return;
    setRows((prev) => {
      const created = createBlankInventoryRow(visibleColumns, prev.length);
      setSelectedRowId(created.id);
      setDirtyRowIds((ids) => {
        const next = new Set(ids);
        next.add(created.id);
        return next;
      });
      return [...prev, created];
    });
  };

  const onToggleQuickColumn = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns) return;
    const visibleCount = columns.filter((item) => item.isVisible).length;
    if (column.isVisible && visibleCount <= 1) return;
    try {
      await updateInventoryColumnVisibility(column.id, !column.isVisible);
      setColumns((prev) =>
        prev.map((item) =>
          item.id === column.id ? { ...item, isVisible: !item.isVisible } : item,
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update column visibility";
      alert(message);
    }
  };

  const onToggleRowSelection = (rowId: string) => {
    if (!canEditTable) return;
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  const onToggleSelectAllFiltered = () => {
    if (!canEditTable || filteredRowIds.length === 0) return;
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const rowId of filteredRowIds) next.delete(rowId);
      } else {
        for (const rowId of filteredRowIds) next.add(rowId);
      }
      return next;
    });
  };

  const onRemoveSelectedRows = () => {
    if (!canEditTable) return;
    if (selectedRowIds.size === 0) return;
    const idsToDelete = new Set(selectedRowIds);
    const persistedIdsToDelete = rows
      .filter((row) => idsToDelete.has(row.id) && Boolean(row.createdAt))
      .map((row) => row.id);
    setDeletedRowIds((prev) => {
      const next = new Set(prev);
      for (const id of persistedIdsToDelete) next.add(id);
      return next;
    });
    setDirtyRowIds((prev) => {
      const next = new Set(prev);
      for (const id of idsToDelete) next.delete(id);
      return next;
    });
    setRows((prev) => {
      if (prev.length <= 1) {
        const created = createBlankInventoryRow(visibleColumns, 0);
        setDirtyRowIds((ids) => {
          const next = new Set(ids);
          next.add(created.id);
          return next;
        });
        setSelectedRowId(created.id);
        return [created];
      }
      const nextRows = prev.filter((row) => !idsToDelete.has(row.id));
      if (nextRows.length === 0) {
        const created = createBlankInventoryRow(visibleColumns, 0);
        setDirtyRowIds((ids) => {
          const next = new Set(ids);
          next.add(created.id);
          return next;
        });
        setSelectedRowId(created.id);
        return [created];
      }
      if (selectedRowId && idsToDelete.has(selectedRowId)) {
        setSelectedRowId(nextRows[0]?.id ?? null);
      }
      return nextRows;
    });
    setSelectedRowIds(new Set());
  };

  function toDateInputValue(value: unknown): string {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  }

  const normalizeLinkValue = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
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
    if (leftMissing) return 1;
    if (rightMissing) return -1;

    const base =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
    return direction === "asc" ? base : -base;
  }

  const onSortColumn = (column: InventoryColumn) => {
    setSortState((prev) => {
      if (!prev || prev.key !== column.key) {
        return { key: column.key, direction: "asc" };
      }
      return { key: column.key, direction: prev.direction === "asc" ? "desc" : "asc" };
    });
  };

  const getReadOnlyCellText = (column: InventoryColumn, value: unknown): string => {
    if (column.type === "date") {
      const iso = toDateInputValue(value);
      if (!iso) return "";
      const date = new Date(`${iso}T00:00:00`);
      return date.toLocaleDateString("en-US");
    }
    if (column.type === "number") {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? String(parsed) : raw;
    }
    return String(value ?? "");
  };

  const isEditingLinkCell = (rowId: string, columnKey: string) =>
    editingLinkCell?.rowId === rowId && editingLinkCell?.columnKey === columnKey;

  const getColumnMinWidth = (column: InventoryColumn): number => {
    if (column.key === "itemName") return 280;
    if (column.key === "notes") return 360;
    if (column.type === "text") return Math.max(column.label.length * 11 + 36, 220);
    return Math.max(column.label.length * 10 + 28, 120);
  };

  const getAppliedColumnWidth = (column: InventoryColumn): number =>
    Math.max(columnWidths[column.key] ?? getColumnMinWidth(column), getColumnMinWidth(column));

  const onResizeMouseDown = (event: ReactMouseEvent<HTMLSpanElement>, column: InventoryColumn) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      key: column.key,
      startX: event.clientX,
      startWidth: getAppliedColumnWidth(column),
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const current = resizeStateRef.current;
      if (!current) return;
      const deltaX = moveEvent.clientX - current.startX;
      const nextWidth = Math.max(getColumnMinWidth(column), current.startWidth + deltaX);
      setColumnWidths((prev) => ({
        ...prev,
        [current.key]: nextWidth,
      }));
    };

    const onMouseUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const onCellChange = (rowIndex: number, column: InventoryColumn, value: string) => {
    if (!canEditTable) return;
    let changedRowId: string | null = null;
    setRows((prev) =>
      prev.map((row, index) => {
        if (index !== rowIndex) return row;
        const currentValue = row.values[column.key];
        if (NUMBER_COLUMN_KEYS.has(column.key)) {
          const parsed = Number(value);
          const nextValue = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          if (currentValue === nextValue) return row;
          changedRowId = row.id;
          return {
            ...row,
            values: {
              ...row.values,
              [column.key]: nextValue,
            },
          };
        }
        if (column.type === "date") {
          const nextValue = toDateInputValue(value);
          if (String(currentValue ?? "") === nextValue) return row;
          changedRowId = row.id;
          return {
            ...row,
            values: {
              ...row.values,
              [column.key]: nextValue,
            },
          };
        }
        if (String(currentValue ?? "") === value) return row;
        changedRowId = row.id;
        return {
          ...row,
          values: {
            ...row.values,
            [column.key]: value,
          },
        };
      }),
    );
    if (changedRowId) {
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        next.add(changedRowId);
        return next;
      });
    }
  };

  const onSave = async (silent = false) => {
    if (!canEditInventory || saving || (dirtyRowIds.size === 0 && deletedRowIds.size === 0)) return;
    setSaving(true);
    try {
      const dirtyRows = rows
        .map((row, index) => ({ ...row, position: index }))
        .filter((row) => dirtyRowIds.has(row.id));
      await saveInventoryItems(
        dirtyRows,
        Array.from(deletedRowIds),
      );
      setDirtyRowIds(new Set());
      setDeletedRowIds(new Set());
    } catch (err: any) {
      if (!silent) {
        alert(err?.message ?? "Failed to save inventory");
      }
    } finally {
      setSaving(false);
    }
  };

  const onChooseCsvImport = () => {
    if (!canEditInventory || importingCsv) return;
    importInputRef.current?.click();
  };

  const onCsvSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!canEditInventory) return;

    setImportingCsv(true);
    try {
      const csvText = await file.text();
      const result = await importInventoryCsv(csvText);
      const bootstrap = await loadInventoryBootstrap();
      applyBootstrap(bootstrap);

      const createdColsText =
        result.createdColumns.length > 0
          ? ` New columns: ${result.createdColumns.map((column) => column.label).join(", ")}.`
          : "";
      alert(
        `Import complete. Added ${result.createdCount} rows and updated ${result.updatedCount} rows.${createdColsText}`,
      );
    } catch (err: any) {
      alert(err?.message ?? "Failed to import CSV");
    } finally {
      setImportingCsv(false);
    }
  };

  useEffect(() => {
    if (!canEditInventory || (dirtyRowIds.size === 0 && deletedRowIds.size === 0)) return;
    const timeout = window.setTimeout(() => {
      void onSave(true);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [rows, dirtyRowIds, deletedRowIds, canEditInventory]);

  useEffect(() => {
    if (!organizationId) return;
    try {
      const raw = window.localStorage.getItem(`${COLUMN_WIDTHS_STORAGE_KEY_PREFIX}${organizationId}`);
      if (!raw) {
        setColumnWidths({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, number>;
      const valid: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          valid[key] = value;
        }
      }
      setColumnWidths(valid);
    } catch {
      setColumnWidths({});
    }
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    try {
      window.localStorage.setItem(
        `${COLUMN_WIDTHS_STORAGE_KEY_PREFIX}${organizationId}`,
        JSON.stringify(columnWidths),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [organizationId, columnWidths]);

  if (loading) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory">Loading inventory...</div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory">{loadError}</div>
      </section>
    );
  }

  return (
    <section className="app-content">
      <div className="app-card app-card--inventory">
        <header className="app-header">
          <div>
            <h2 className="app-title">Inventory</h2>
          </div>
          <div className="app-actions">
            {canEditInventory ? (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    void onCsvSelected(event);
                  }}
                  style={{ display: "none" }}
                />
                {canEditTable ? (
                  <>
                    <button className="button button-secondary" onClick={onAddRow}>
                      Add Row
                    </button>
                    {rows.length > 1 && selectedRowIds.size > 0 ? (
                      <button className="button button-secondary" onClick={onRemoveSelectedRows}>
                        Delete Selected ({selectedRowIds.size})
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  className="button button-secondary"
                  onClick={onChooseCsvImport}
                  disabled={importingCsv || saving}
                >
                  {importingCsv ? "Importing..." : "Import CSV"}
                </button>
                <button
                  className="button button-primary"
                  onClick={() => void onSave()}
                  disabled={saving || (dirtyRowIds.size === 0 && deletedRowIds.size === 0)}
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="inventory-filter-bar">
          <div className="inventory-tabs" role="tablist" aria-label="Inventory filters">
            <button
              className={`inventory-tab-btn${activeFilter === "all" ? " active" : ""}`}
              onClick={() => setActiveFilter("all")}
              role="tab"
              aria-selected={activeFilter === "all"}
            >
              All Items
            </button>
            {hasExpirationColumn ? (
              <>
                <button
                  className={`inventory-tab-btn${activeFilter === "expired" ? " active" : ""}`}
                  onClick={() => setActiveFilter("expired")}
                  role="tab"
                  aria-selected={activeFilter === "expired"}
                >
                  Expired
                </button>
                <button
                  className={`inventory-tab-btn${activeFilter === "exp30" ? " active" : ""}`}
                  onClick={() => setActiveFilter("exp30")}
                  role="tab"
                  aria-selected={activeFilter === "exp30"}
                >
                  Expiring Within 30 Days
                </button>
                <button
                  className={`inventory-tab-btn${activeFilter === "exp60" ? " active" : ""}`}
                  onClick={() => setActiveFilter("exp60")}
                  role="tab"
                  aria-selected={activeFilter === "exp60"}
                >
                  Expiring Within 60 Days
                </button>
              </>
            ) : null}
            {hasMinQuantityColumn ? (
              <button
                className={`inventory-tab-btn${activeFilter === "lowStock" ? " active" : ""}`}
                onClick={() => setActiveFilter("lowStock")}
                role="tab"
                aria-selected={activeFilter === "lowStock"}
              >
                Low Stock
              </button>
            ) : null}
          </div>
          <input
            className="inventory-search-input"
            placeholder="Search inventory..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          <details className="inventory-columns-menu">
            <summary className="inventory-columns-trigger">Columns</summary>
            <div className="inventory-columns-panel">
              {columns
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((column) => {
                  const checked = column.isVisible;
                  return (
                    <label key={column.id} className="inventory-columns-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          void onToggleQuickColumn(column);
                        }}
                        disabled={!canManageInventoryColumns}
                      />
                      <span>{column.label}</span>
                    </label>
                  );
                })}
            </div>
          </details>
        </div>

        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                {canEditTable ? (
                  <th className="inventory-select-cell">
                    <input
                      ref={selectAllCheckboxRef}
                      type="checkbox"
                      className="inventory-select-checkbox"
                      checked={allFilteredSelected}
                      onChange={onToggleSelectAllFiltered}
                      disabled={!canEditTable || filteredRowIds.length === 0}
                      aria-label="Select all visible rows"
                    />
                  </th>
                ) : null}
                {visibleColumns.map((column) =>
                  column.key === "location" ? (
                    <th
                      key={column.id}
                      className={`inventory-col-${column.key}`}
                      style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                    >
                      <details className="inventory-location-menu">
                        <summary className="inventory-location-trigger">{column.label}</summary>
                        <div className="inventory-location-panel">
                          {locationOptions.map((option) => (
                            <button
                              key={option}
                              className={`inventory-location-item${effectiveLocationFilter === option ? " active" : ""}`}
                              onClick={(event) => {
                                setLocationFilter(option);
                                const details = event.currentTarget.closest("details");
                                details?.removeAttribute("open");
                              }}
                              type="button"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </details>
                      <span
                        className="inventory-col-resizer"
                        onMouseDown={(event) => onResizeMouseDown(event, column)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${column.label} column`}
                      />
                    </th>
                  ) : column.key === "category" ? (
                    <th
                      key={column.id}
                      className={`inventory-col-${column.key}`}
                      style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                    >
                      <details className="inventory-location-menu">
                        <summary className="inventory-location-trigger">{column.label}</summary>
                        <div className="inventory-location-panel">
                          {categoryOptions.map((option) => (
                            <button
                              key={option}
                              className={`inventory-location-item${effectiveCategoryFilter === option ? " active" : ""}`}
                              onClick={(event) => {
                                setCategoryFilter(option);
                                const details = event.currentTarget.closest("details");
                                details?.removeAttribute("open");
                              }}
                              type="button"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </details>
                      <span
                        className="inventory-col-resizer"
                        onMouseDown={(event) => onResizeMouseDown(event, column)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${column.label} column`}
                      />
                    </th>
                  ) : (
                    <th
                      key={column.id}
                      className={`inventory-col-${column.key}`}
                      style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                    >
                      <button
                        type="button"
                        className="inventory-sort-trigger"
                        onClick={() => onSortColumn(column)}
                      >
                        <span>{column.label}</span>
                        <span className="inventory-sort-arrow" aria-hidden="true">
                          {sortState?.key === column.key
                            ? sortState.direction === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </button>
                      <span
                        className="inventory-col-resizer"
                        onMouseDown={(event) => onResizeMouseDown(event, column)}
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${column.label} column`}
                      />
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ row, index: rowIndex }) => (
                <tr
                  key={row.id}
                  className={row.id === selectedRowId ? "inventory-row-selected" : undefined}
                  onClick={() => setSelectedRowId(row.id)}
                >
                  {canEditTable ? (
                    <td className="inventory-select-cell">
                      <input
                        type="checkbox"
                        className="inventory-select-checkbox"
                        checked={selectedRowIds.has(row.id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => onToggleRowSelection(row.id)}
                        disabled={!canEditTable}
                        aria-label={`Select row ${rowIndex + 1}`}
                      />
                    </td>
                  ) : null}
                  {visibleColumns.map((column) => (
                    <td
                      key={`${row.id}-${column.id}`}
                      className={`inventory-col-${column.key}`}
                      style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                    >
                      {!canEditTable ? (
                        column.type === "link" ? (
                          (() => {
                            const rawLink = String(row.values[column.key] ?? "");
                            const normalizedLink = normalizeLinkValue(rawLink);
                            if (!normalizedLink) return null;
                            return (
                              <a
                                className="inventory-link-field inventory-readonly-cell"
                                href={normalizedLink}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {String(row.values.itemName ?? "").trim() || normalizedLink}
                              </a>
                            );
                          })()
                        ) : (
                          <div className="inventory-readonly-cell">
                            {getReadOnlyCellText(column, row.values[column.key])}
                          </div>
                        )
                      ) : column.type === "link" ? (
                        (() => {
                          const rawLink = String(row.values[column.key] ?? "");
                          const normalizedLink = normalizeLinkValue(rawLink);
                          const hasLink = normalizedLink.length > 0;
                          const editing = canEditTable && (isEditingLinkCell(row.id, column.key) || !hasLink);

                          if (editing) {
                            return (
                              <input
                                type="url"
                                value={rawLink}
                                placeholder="Paste link"
                                onFocus={() => {
                                  setSelectedRowId(row.id);
                                  setEditingLinkCell({ rowId: row.id, columnKey: column.key });
                                }}
                                onChange={(event) => onCellChange(rowIndex, column, event.target.value)}
                                onBlur={(event) => {
                                  const normalized = normalizeLinkValue(event.target.value);
                                  if (normalized !== event.target.value) {
                                    onCellChange(rowIndex, column, normalized);
                                  }
                                  setEditingLinkCell(null);
                                }}
                                onPaste={(event) => {
                                  const pasted = event.clipboardData.getData("text");
                                  if (!pasted) return;
                                  event.preventDefault();
                                  onCellChange(rowIndex, column, normalizeLinkValue(pasted));
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    (event.currentTarget as HTMLInputElement).blur();
                                  }
                                }}
                                disabled={!canEditTable}
                              />
                            );
                          }

                          if (!hasLink) return null;

                          return (
                            <a
                              className="inventory-link-field"
                              href={normalizedLink}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => {
                                if (!canEditTable) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setSelectedRowId(row.id);
                                setEditingLinkCell({ rowId: row.id, columnKey: column.key });
                              }}
                              title={canEditTable ? "Double-click to edit link" : undefined}
                            >
                              {String(row.values.itemName ?? "").trim() || normalizedLink}
                            </a>
                          );
                        })()
                      ) : column.type === "text" ? (
                        <textarea
                          key={`${row.id}-${column.key}`}
                          defaultValue={String(row.values[column.key] ?? "")}
                          onBlur={(event) => {
                            onCellChange(rowIndex, column, event.currentTarget.value);
                          }}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                              (event.currentTarget as HTMLTextAreaElement).blur();
                            }
                          }}
                          disabled={!canEditTable}
                          rows={2}
                        />
                      ) : (
                        <input
                          key={`${row.id}-${column.key}`}
                          type={column.type === "number" ? "number" : column.type === "date" ? "date" : "text"}
                          min={column.type === "number" ? 0 : undefined}
                          defaultValue={
                            column.type === "date"
                              ? toDateInputValue(row.values[column.key])
                              : String(row.values[column.key] ?? "")
                          }
                          onBlur={(event) => onCellChange(rowIndex, column, event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              (event.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          disabled={!canEditTable}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
