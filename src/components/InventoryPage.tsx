import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  convertImportFileToCsv,
  extractCsvHeaders,
  importInventoryCsv,
  isInventoryProvisioningError,
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
const UNDO_HISTORY_LIMIT = 80;
const COLUMN_WIDTHS_STORAGE_KEY_PREFIX = "wickops.inventory.columnWidths:";
const DEFAULT_PROVISIONING_RETRY_MS = 2000;
const LOADING_LINES = [
  "Counting bolts and pretending it's fun...",
  "Teaching the forklift to whisper...",
  "Dusting shelves for dramatic effect...",
  "Arguing with barcodes...",
  "Rehearsing the inventory roll call...",
];
const PROVISIONING_LINES = [
  "Building table legs for your table...",
  "Aligning columns with the moon phase...",
  "Applying premium spreadsheet vibes...",
  "Installing tiny seats for your rows...",
];

const pickRandom = (items: string[]): string =>
  items[Math.floor(Math.random() * items.length)] ?? "Loading inventory...";

const normalizeHeaderKey = (value: string): string => value.trim().toLowerCase();

type CsvImportDialogState = {
  csvText: string;
  headers: string[];
  selectedHeaders: string[];
};

type PasteImportDialogState = {
  rawText: string;
};

type InventorySnapshot = {
  rows: InventoryRow[];
  dirtyRowIds: Set<string>;
  deletedRowIds: Set<string>;
  selectedRowIds: Set<string>;
  selectedRowId: string | null;
};

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
  const [copiedRowValues, setCopiedRowValues] = useState<Record<string, string | number | boolean | null> | null>(null);
  const [undoStack, setUndoStack] = useState<InventorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<InventorySnapshot[]>([]);
  const [editingLinkCell, setEditingLinkCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [editingDateCell, setEditingDateCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loadingMessage, setLoadingMessage] = useState(() => pickRandom(LOADING_LINES));
  const [csvImportDialog, setCsvImportDialog] = useState<CsvImportDialogState | null>(null);
  const [pasteImportDialog, setPasteImportDialog] = useState<PasteImportDialogState | null>(null);
  const resizeStateRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const rowsRef = useRef(rows);
  const dirtyRowIdsRef = useRef(dirtyRowIds);
  const deletedRowIdsRef = useRef(deletedRowIds);
  const selectedRowIdsRef = useRef(selectedRowIds);
  const selectedRowIdRef = useRef(selectedRowId);
  const restoringSnapshotRef = useRef(false);
  const editSessionCellRef = useRef<string | null>(null);
  const canEditTable = canEditInventory && activeFilter === "all";

  useEffect(() => {
    rowsRef.current = rows;
    dirtyRowIdsRef.current = dirtyRowIds;
    deletedRowIdsRef.current = deletedRowIds;
    selectedRowIdsRef.current = selectedRowIds;
    selectedRowIdRef.current = selectedRowId;
  }, [rows, dirtyRowIds, deletedRowIds, selectedRowIds, selectedRowId]);

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
    setCopiedRowValues(null);
    setUndoStack([]);
    setRedoStack([]);
    editSessionCellRef.current = null;
  };

  const snapshotFromRefs = (): InventorySnapshot => ({
    rows: rowsRef.current.map((row) => ({
      ...row,
      values: { ...row.values },
    })),
    dirtyRowIds: new Set(dirtyRowIdsRef.current),
    deletedRowIds: new Set(deletedRowIdsRef.current),
    selectedRowIds: new Set(selectedRowIdsRef.current),
    selectedRowId: selectedRowIdRef.current,
  });

  const applySnapshot = (snapshot: InventorySnapshot) => {
    restoringSnapshotRef.current = true;
    setRows(snapshot.rows.map((row) => ({ ...row, values: { ...row.values } })));
    setDirtyRowIds(new Set(snapshot.dirtyRowIds));
    setDeletedRowIds(new Set(snapshot.deletedRowIds));
    setSelectedRowIds(new Set(snapshot.selectedRowIds));
    setSelectedRowId(snapshot.selectedRowId);
    setTimeout(() => {
      restoringSnapshotRef.current = false;
    }, 0);
  };

  const pushUndoSnapshot = () => {
    if (restoringSnapshotRef.current) return;
    const snapshot = snapshotFromRefs();
    setUndoStack((prev) => [...prev.slice(-(UNDO_HISTORY_LIMIT - 1)), snapshot]);
    setRedoStack([]);
  };

  const undoLastChange = () => {
    if (undoStack.length === 0) return;
    const current = snapshotFromRefs();
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev.slice(-(UNDO_HISTORY_LIMIT - 1)), current]);
    applySnapshot(previous);
  };

  const redoLastChange = () => {
    if (redoStack.length === 0) return;
    const current = snapshotFromRefs();
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev.slice(-(UNDO_HISTORY_LIMIT - 1)), current]);
    applySnapshot(next);
  };

  const beginCellEditSession = (rowId: string, columnKey: string) => {
    const cellKey = `${rowId}:${columnKey}`;
    if (editSessionCellRef.current === cellKey) return;
    pushUndoSnapshot();
    editSessionCellRef.current = cellKey;
  };

  const endCellEditSession = () => {
    editSessionCellRef.current = null;
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError("");
      setLoadingMessage(pickRandom(LOADING_LINES));

      while (!cancelled) {
        try {
          const bootstrap = await loadInventoryBootstrap();
          if (cancelled) return;
          applyBootstrap(bootstrap);
          setLoading(false);
          return;
        } catch (err: any) {
          if (cancelled) return;
          if (isInventoryProvisioningError(err)) {
            setLoadingMessage(pickRandom(PROVISIONING_LINES));
            const retryAfterMs =
              Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) : DEFAULT_PROVISIONING_RETRY_MS;
            await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
            continue;
          }
          setLoadError(err?.message ?? "Failed to load inventory");
          setLoading(false);
          return;
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => {
      setLoadingMessage((current) => {
        const source = PROVISIONING_LINES.includes(current) ? PROVISIONING_LINES : LOADING_LINES;
        return pickRandom(source);
      });
    }, 2200);
    return () => window.clearInterval(interval);
  }, [loading]);

  const visibleColumns = useMemo(
    () =>
      [...columns]
        .filter((column) => column.isVisible)
        .sort((a, b) => a.sortOrder - b.sortOrder),
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

  const closeParentDetails = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    element?.closest("details")?.removeAttribute("open");
  };

  const onAddRow = (position: "above" | "below", event?: ReactMouseEvent<HTMLElement>) => {
    if (!canEditTable) return;
    pushUndoSnapshot();
    if (event) {
      closeParentDetails(event.target);
    }
    const anchorFromFiltered =
      filteredRows.find(({ row }) => row.id === selectedRowId)?.row;
    const anchorRowId = anchorFromFiltered?.id ?? null;
    setRows((prev) => {
      const selectedIndex =
        anchorRowId ? prev.findIndex((row) => row.id === anchorRowId) : -1;
      const insertIndex =
        selectedIndex >= 0
          ? position === "above"
            ? selectedIndex
            : selectedIndex + 1
          : position === "above"
            ? 0
            : prev.length;
      const created = createBlankInventoryRow(allColumns, insertIndex);
      const anchorRow = selectedIndex >= 0 ? prev[selectedIndex] : null;
      if (anchorRow && sortState && sortState.key in created.values) {
        created.values[sortState.key] = anchorRow.values?.[sortState.key] ?? created.values[sortState.key];
      }
      if (anchorRow && locationColumn && effectiveLocationFilter !== "All Locations") {
        created.values[locationColumn.key] =
          anchorRow.values?.[locationColumn.key] ?? created.values[locationColumn.key];
      }
      if (anchorRow && categoryColumn && effectiveCategoryFilter !== "All Categories") {
        created.values[categoryColumn.key] =
          anchorRow.values?.[categoryColumn.key] ?? created.values[categoryColumn.key];
      }
      const nextRows = [
        ...prev.slice(0, insertIndex),
        created,
        ...prev.slice(insertIndex),
      ];
      setSelectedRowId(created.id);
      setDirtyRowIds((ids) => {
        const next = new Set(ids);
        next.add(created.id);
        return next;
      });
      return nextRows;
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

  const onCopySelectedRow = () => {
    if (!canEditTable || !selectedRowId) return;
    const sourceRow = rows.find((row) => row.id === selectedRowId);
    if (!sourceRow) return;
    const copied: Record<string, string | number | boolean | null> = {};
    for (const column of allColumns) {
      const value = sourceRow.values[column.key];
      copied[column.key] = value === undefined ? (column.type === "number" ? 0 : "") : value;
    }
    setCopiedRowValues(copied);
  };

  const onPasteToSelectedRow = () => {
    if (!canEditTable || !selectedRowId || !copiedRowValues) return;
    pushUndoSnapshot();
    let changedRowId: string | null = null;
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== selectedRowId) return row;
        const nextValues = { ...row.values };
        let changed = false;

        for (const column of allColumns) {
          const copiedValue = copiedRowValues[column.key];
          let normalizedValue: string | number | boolean | null;

          if (column.type === "number") {
            const parsed = Number(copiedValue);
            normalizedValue = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          } else if (column.type === "date") {
            normalizedValue = toDateInputValue(String(copiedValue ?? ""));
          } else if (column.type === "link") {
            normalizedValue = normalizeLinkValue(String(copiedValue ?? ""));
          } else if (column.type === "boolean") {
            const raw = String(copiedValue ?? "").trim().toLowerCase();
            if (typeof copiedValue === "boolean") {
              normalizedValue = copiedValue;
            } else if (!raw) {
              normalizedValue = "";
            } else {
              normalizedValue = raw === "true";
            }
          } else {
            normalizedValue = String(copiedValue ?? "");
          }

          if (row.values[column.key] !== normalizedValue) {
            nextValues[column.key] = normalizedValue;
            changed = true;
          }
        }

        if (!changed) return row;
        changedRowId = row.id;
        return { ...row, values: nextValues };
      }),
    );

    if (changedRowId) {
      const resolvedRowId = changedRowId;
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        next.add(resolvedRowId);
        return next;
      });
    }
  };

  const onRemoveSelectedRows = () => {
    if (!canEditTable) return;
    if (selectedRowIds.size === 0) return;
    const count = selectedRowIds.size;
    const confirmed = window.confirm(
      `Delete ${count} selected ${count === 1 ? "row" : "rows"}?`,
    );
    if (!confirmed) return;
    pushUndoSnapshot();
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
        const created = createBlankInventoryRow(allColumns, 0);
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
        const created = createBlankInventoryRow(allColumns, 0);
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
  const isEditingDateCell = (rowId: string, columnKey: string) =>
    editingDateCell?.rowId === rowId && editingDateCell?.columnKey === columnKey;

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

  const onCellChange = (rowId: string, column: InventoryColumn, value: string) => {
    if (!canEditTable) return;
    let changedRowId: string | null = null;
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== rowId) return row;
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
      const resolvedRowId = changedRowId;
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        next.add(resolvedRowId);
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
      setUndoStack([]);
      setRedoStack([]);
      editSessionCellRef.current = null;
    } catch (err: any) {
      if (!silent) {
        alert(err?.message ?? "Failed to save inventory");
      }
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!canEditTable) return;
      if (!(event.metaKey || event.ctrlKey)) return;

      const target = event.target as HTMLElement | null;
      const isEditableTarget = !!target && (
        target.tagName.toLowerCase() === "input" ||
        target.tagName.toLowerCase() === "textarea" ||
        target.isContentEditable
      );
      const key = event.key.toLowerCase();

      if (isEditableTarget && (key === "z" || key === "y")) {
        return;
      }

      if (isEditableTarget) {
        const active = target as HTMLInputElement | HTMLTextAreaElement;
        const hasSelectionRange =
          typeof active.selectionStart === "number" &&
          typeof active.selectionEnd === "number" &&
          active.selectionEnd > active.selectionStart;
        const hasDocumentSelection = (window.getSelection()?.toString() ?? "").length > 0;
        if (hasSelectionRange || hasDocumentSelection) {
          return;
        }
      }

      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoLastChange();
        } else {
          undoLastChange();
        }
        return;
      }

      if (key === "y") {
        event.preventDefault();
        redoLastChange();
        return;
      }

      if (key === "c") {
        if (!selectedRowId) return;
        event.preventDefault();
        onCopySelectedRow();
        return;
      }
      if (key === "v") {
        if (!selectedRowId || !copiedRowValues) return;
        event.preventDefault();
        onPasteToSelectedRow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canEditTable, selectedRowId, copiedRowValues, undoStack, redoStack, rows, allColumns]);

  useEffect(() => {
    const trySavePending = () => {
      if (!canEditInventory) return;
      if (saving) return;
      if (dirtyRowIds.size === 0 && deletedRowIds.size === 0) return;
      void onSave(true);
    };

    const onPageHide = () => {
      trySavePending();
    };

    const onBeforeUnload = () => {
      trySavePending();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        trySavePending();
      }
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [canEditInventory, saving, dirtyRowIds, deletedRowIds, onSave]);

  const onChooseCsvImport = () => {
    if (!canEditInventory || importingCsv) return;
    importInputRef.current?.click();
  };

  const onOpenPasteImport = () => {
    if (!canEditInventory || importingCsv) return;
    setPasteImportDialog({ rawText: "" });
  };

  const onCsvSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!canEditInventory) return;
    try {
      const csvText = await convertImportFileToCsv(file);
      const headers = extractCsvHeaders(csvText);
      if (headers.length === 0) {
        throw new Error("Could not detect CSV headers.");
      }
      setCsvImportDialog({
        csvText,
        headers,
        selectedHeaders: [...headers],
      });
    } catch (err: any) {
      alert(err?.message ?? "Failed to import file");
    }
  };

  const onToggleImportHeader = (header: string) => {
    setCsvImportDialog((prev) => {
      if (!prev) return prev;
      const key = normalizeHeaderKey(header);
      const selected = prev.selectedHeaders.some((item) => normalizeHeaderKey(item) === key);
      const nextSelected = selected
        ? prev.selectedHeaders.filter((item) => normalizeHeaderKey(item) !== key)
        : [...prev.selectedHeaders, header];
      return {
        ...prev,
        selectedHeaders: nextSelected,
      };
    });
  };

  const onCancelCsvImport = () => {
    if (importingCsv) return;
    setCsvImportDialog(null);
  };

  const onCancelPasteImport = () => {
    if (importingCsv) return;
    setPasteImportDialog(null);
  };

  const onConfirmPasteImport = () => {
    if (!pasteImportDialog) return;
    const rawText = pasteImportDialog.rawText.trim();
    if (!rawText) {
      alert("Paste your CSV or tab-delimited data first.");
      return;
    }
    const headers = extractCsvHeaders(rawText);
    if (headers.length === 0) {
      alert("Could not detect headers from pasted data.");
      return;
    }
    setCsvImportDialog({
      csvText: rawText,
      headers,
      selectedHeaders: [...headers],
    });
    setPasteImportDialog(null);
  };

  const onConfirmCsvImport = async () => {
    if (!csvImportDialog) return;
    const selectedHeaders = csvImportDialog.selectedHeaders;
    if (selectedHeaders.length === 0) {
      alert("Select at least one column to import.");
      return;
    }

    setImportingCsv(true);
    try {
      const result = await importInventoryCsv(csvImportDialog.csvText, selectedHeaders);
      if (result.createdCount === 0 && result.updatedCount === 0) {
        if (result.duplicateSkippedCount > 0) {
          throw new Error(
            result.duplicateSkippedCount === 1
              ? "Import canceled: that row is already in inventory."
              : `Import canceled: all ${result.duplicateSkippedCount} rows are already in inventory.`,
          );
        }
        throw new Error("Import canceled: no new data was imported.");
      }
      const bootstrap = await loadInventoryBootstrap();
      applyBootstrap(bootstrap);
      setCsvImportDialog(null);
      alert("Import complete.");
    } catch (err: any) {
      alert(err?.message ?? "Import failed. Please verify your file headers and row values.");
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
        <div className="app-card app-card--inventory app-loading-card">
          <span className="app-spinner" aria-hidden="true" />
          <span>{loadingMessage}</span>
        </div>
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
            {canEditInventory ? (
              <div className="inventory-header-actions">
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,.CSV,.tsv,.TSV,.xlsx,.XLSX,.xls,.XLS,text/csv,text/tab-separated-values,application/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream"
                  onChange={(event) => {
                    void onCsvSelected(event);
                  }}
                  style={{ display: "none" }}
                />
                {canEditTable ? (
                  <>
                    <details className="inventory-import-menu">
                      <summary className="inventory-import-trigger">Add Row</summary>
                      <div className="inventory-import-panel">
                        <button
                          type="button"
                          className="inventory-import-option"
                          onClick={(event) => onAddRow("above", event)}
                        >
                          Add Above Selected
                        </button>
                        <button
                          type="button"
                          className="inventory-import-option"
                          onClick={(event) => onAddRow("below", event)}
                        >
                          Add Below Selected
                        </button>
                      </div>
                    </details>
                    {rows.length > 1 && selectedRowIds.size > 0 ? (
                      <button className="button button-secondary" onClick={onRemoveSelectedRows}>
                        Delete Selected ({selectedRowIds.size})
                      </button>
                    ) : null}
                  </>
                ) : null}
                <details className="inventory-import-menu">
                  <summary className="inventory-import-trigger">
                    {importingCsv ? "Importing..." : "Import"}
                  </summary>
                  <div className="inventory-import-panel">
                    <button
                      type="button"
                      className="inventory-import-option"
                      onClick={onChooseCsvImport}
                      disabled={importingCsv || saving}
                    >
                      Upload CSV/XLSX
                    </button>
                    <button
                      type="button"
                      className="inventory-import-option"
                      onClick={onOpenPasteImport}
                      disabled={importingCsv || saving}
                    >
                      Paste Data
                    </button>
                  </div>
                </details>
                <button
                  className="button button-primary"
                  onClick={() => void onSave()}
                  disabled={saving || (dirtyRowIds.size === 0 && deletedRowIds.size === 0)}
                >
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
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
          <div className="inventory-search-wrap">
            <input
              className="inventory-search-input"
              placeholder="Search inventory..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            {searchTerm ? (
              <button
                type="button"
                className="inventory-search-clear"
                onClick={() => setSearchTerm("")}
                aria-label="Clear search"
                title="Clear search"
              >
                ×
              </button>
            ) : null}
          </div>
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
                      onMouseDown={() => setSelectedRowId(row.id)}
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
                                  beginCellEditSession(row.id, column.key);
                                  setEditingLinkCell({ rowId: row.id, columnKey: column.key });
                                }}
                                onChange={(event) => onCellChange(row.id, column, event.target.value)}
                                onBlur={(event) => {
                                  const normalized = normalizeLinkValue(event.target.value);
                                  if (normalized !== event.target.value) {
                                    onCellChange(row.id, column, normalized);
                                  }
                                  setEditingLinkCell(null);
                                  endCellEditSession();
                                }}
                                onPaste={(event) => {
                                  const pasted = event.clipboardData.getData("text");
                                  if (!pasted) return;
                                  event.preventDefault();
                                  onCellChange(row.id, column, normalizeLinkValue(pasted));
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
                          value={String(row.values[column.key] ?? "")}
                          onFocus={() => {
                            setSelectedRowId(row.id);
                            beginCellEditSession(row.id, column.key);
                          }}
                          onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
                          onBlur={endCellEditSession}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                              (event.currentTarget as HTMLTextAreaElement).blur();
                            }
                          }}
                          disabled={!canEditTable}
                          rows={2}
                        />
                      ) : column.type === "date" ? (
                        (() => {
                          const isoValue = toDateInputValue(row.values[column.key]);
                          const editing = isEditingDateCell(row.id, column.key);
                          if (!isoValue && !editing) {
                            return (
                              <button
                                type="button"
                                className="inventory-date-add"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedRowId(row.id);
                                  setEditingDateCell({ rowId: row.id, columnKey: column.key });
                                }}
                                disabled={!canEditTable}
                              >
                                Add date
                              </button>
                            );
                          }

                          return (
                            <div className="inventory-date-edit-wrap">
                              <input
                                type="date"
                                value={isoValue}
                                autoFocus={editing}
                                onFocus={() => {
                                  setSelectedRowId(row.id);
                                  beginCellEditSession(row.id, column.key);
                                  setEditingDateCell({ rowId: row.id, columnKey: column.key });
                                }}
                                onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
                                onBlur={() => {
                                  endCellEditSession();
                                  setEditingDateCell((prev) =>
                                    prev?.rowId === row.id && prev?.columnKey === column.key ? null : prev,
                                  );
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    (event.currentTarget as HTMLInputElement).blur();
                                  }
                                }}
                                disabled={!canEditTable}
                              />
                              {isoValue ? (
                                <button
                                  type="button"
                                  className="inventory-date-clear"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onCellChange(row.id, column, "");
                                    setEditingDateCell({ rowId: row.id, columnKey: column.key });
                                  }}
                                  disabled={!canEditTable}
                                  aria-label="Clear date"
                                  title="Clear date"
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          );
                        })()
                      ) : (
                        <input
                          type={column.type === "number" ? "number" : "text"}
                          min={column.type === "number" ? 0 : undefined}
                          value={String(row.values[column.key] ?? "")}
                          onFocus={() => {
                            setSelectedRowId(row.id);
                            beginCellEditSession(row.id, column.key);
                          }}
                          onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
                          onBlur={endCellEditSession}
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
      {csvImportDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Choose import columns">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Check which columns you want to import.</h3>
            <p className="inventory-import-subtitle">
              Columns will be auto created if they do not exist.
            </p>
            <div className="inventory-import-list">
              {csvImportDialog.headers.map((header, index) => {
                const checked = csvImportDialog.selectedHeaders.some(
                  (item) => normalizeHeaderKey(item) === normalizeHeaderKey(header),
                );
                return (
                  <label key={`${header}-${index}`} className="inventory-import-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleImportHeader(header)}
                      disabled={importingCsv}
                    />
                    <span>{header}</span>
                  </label>
                );
              })}
            </div>
            <div className="inventory-import-actions">
              <button className="button button-secondary" onClick={onCancelCsvImport} disabled={importingCsv}>
                Cancel
              </button>
              <button className="button button-primary" onClick={() => void onConfirmCsvImport()} disabled={importingCsv}>
                {importingCsv ? "Importing..." : "Import Selected Columns"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pasteImportDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Paste import data">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Paste CSV or tab-delimited data.</h3>
            <p className="inventory-import-subtitle">
              Include a header row in the first line.
            </p>
            <textarea
              className="inventory-import-textarea"
              value={pasteImportDialog.rawText}
              onChange={(event) =>
                setPasteImportDialog((prev) => (prev ? { ...prev, rawText: event.target.value } : prev))
              }
              placeholder={"itemName,quantity,minQuantity\nWrench,12,4"}
              rows={10}
            />
            <div className="inventory-import-actions">
              <button className="button button-secondary" onClick={onCancelPasteImport} disabled={importingCsv}>
                Cancel
              </button>
              <button className="button button-primary" onClick={onConfirmPasteImport} disabled={importingCsv}>
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
