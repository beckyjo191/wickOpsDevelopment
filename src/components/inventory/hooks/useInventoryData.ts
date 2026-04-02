import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  addInventoryLocation,
  approveUsageSubmission,
  convertImportFileToCsv,
  deleteUsageSubmission,
  extractCsvHeaders,
  generateAndDownloadInventoryTemplate,
  importInventoryCsv,
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  saveInventoryItems,
  saveInventoryItemsSync,
  type ColumnVisibilityOverrides,
  type InventoryColumn,
  type InventoryRow,
  type PendingEntry,
  type PendingSubmission,
} from "../../../lib/inventoryApi";
import { pickLoadingLine } from "../../../lib/loadingLines";
import type {
  ActiveTab,
  CsvImportDialogState,
  InventoryFilter,
  InventorySnapshot,
  PasteImportDialogState,
  SortDirection,
} from "../inventoryTypes";
import {
  AUTOSAVE_DELAY_MS,
  DEFAULT_PROVISIONING_RETRY_MS,
  NUMBER_COLUMN_KEYS,
  UNDO_HISTORY_LIMIT,
} from "../inventoryTypes";
import { buildRowsSignature, createBlankInventoryRow, normalizeHeaderKey } from "../inventoryUtils";

interface UseInventoryDataParams {
  canEditInventory: boolean;
  initialEditCell?: { rowId: string; columnKey: string };
  selectedLocation: string | null;
  onLocationChange: (location: string | null) => void;
  onSaveFnChange?: (fn: (() => Promise<void>) | null) => void;
  /** From the filters hook */
  effectiveLocationFilter: string;
  /** From the filters hook */
  allColumns: InventoryColumn[];
  /** From the filters hook */
  locationColumn: InventoryColumn | undefined;
  /** From the filters hook */
  filteredRows: { row: InventoryRow; index: number }[];
  /** From the filters hook */
  filteredRowIds: string[];
  /** From the filters hook */
  visibleColumns: InventoryColumn[];
  /** From the filters hook — the "Unassigned" sentinel */
  UNASSIGNED_LOCATION: string;
  /** From the filters hook */
  setSelectedRowIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Whether the active tab is pendingSubmissions */
  activeTab: ActiveTab;
  /** From the filters hook — selected row IDs (for allFilteredSelected) */
  selectedRowIds: Set<string>;
  /** From the filters hook */
  toDateInputValue: (value: unknown) => string;
  /** From the filters hook */
  setCurrentPage: React.Dispatch<React.SetStateAction<number>>;
}

// Keys that, when edited, indicate an order has arrived -- auto-clear orderedAt
const ORDERED_CLEAR_KEYS = new Set(["quantity", "expirationDate"]);

export function useInventoryData({
  canEditInventory,
  initialEditCell,
  selectedLocation,
  onLocationChange,
  onSaveFnChange,
  effectiveLocationFilter,
  allColumns,
  locationColumn,
  filteredRows,
  filteredRowIds,
  visibleColumns,
  UNASSIGNED_LOCATION,
  setSelectedRowIds,
  activeTab,
  selectedRowIds,
  toDateInputValue,
  setCurrentPage,
}: UseInventoryDataParams) {
  const canEditTable = canEditInventory && activeTab !== "pendingSubmissions";

  // ── Core state ──
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());
  const [organizationId, setOrganizationId] = useState("");
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());
  const [deletedRowIds, setDeletedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [copiedRowValues, setCopiedRowValues] = useState<Record<string, string | number | boolean | null> | null>(null);
  const [undoStack, setUndoStack] = useState<InventorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<InventorySnapshot[]>([]);
  const [editingLinkCell, setEditingLinkCell] = useState<{ rowId: string; columnKey: string } | null>(initialEditCell ?? null);
  const [editingDateCell, setEditingDateCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [csvImportDialog, setCsvImportDialog] = useState<CsvImportDialogState | null>(null);
  const [pasteImportDialog, setPasteImportDialog] = useState<PasteImportDialogState | null>(null);
  const [registeredLocations, setRegisteredLocations] = useState<string[]>([]);
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [addLocationError, setAddLocationError] = useState<string | null>(null);
  const [pendingDeleteRows, setPendingDeleteRows] = useState(false);
  const [userColumnOverrides, setUserColumnOverrides] = useState<ColumnVisibilityOverrides>({});

  // ── Refs ──
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const editingRowIdRef = useRef<string | null>(null);
  const pendingScrollToRowRef = useRef<string | null>(null);
  const editSessionCellRef = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  const dirtyRowIdsRef = useRef(dirtyRowIds);
  const deletedRowIdsRef = useRef(deletedRowIds);
  const selectedRowIdsRef = useRef(selectedRowIds);
  const selectedRowIdRef = useRef(selectedRowId);
  const isProvisioningRef = useRef(false);
  const savingRef = useRef(false);
  const pruningRef = useRef(false);
  const restoringSnapshotRef = useRef(false);
  const lastSavedSnapshotRef = useRef<Map<string, string>>(new Map());
  const pendingNewLocationRef = useRef<string | null>(null);
  const onSaveRef = useRef<() => Promise<void>>(async () => {});

  // ── Ref sync ──
  useEffect(() => {
    rowsRef.current = rows;
    dirtyRowIdsRef.current = dirtyRowIds;
    deletedRowIdsRef.current = deletedRowIds;
    selectedRowIdsRef.current = selectedRowIds;
    selectedRowIdRef.current = selectedRowId;
  }, [rows, dirtyRowIds, deletedRowIds, selectedRowIds, selectedRowId]);

  // ── rowById for pending entry labels ──
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const buildPendingEntryLabel = (entry: PendingEntry): string => {
    const row = rowById.get(entry.itemId);
    const exp = row ? toDateInputValue(row.values.expirationDate) : "";
    const currentQty = row !== undefined ? Number(row.values.quantity ?? 0) : null;
    const expPart = exp ? ` | exp ${exp}` : "";
    const qtyPart = currentQty !== null ? ` (${currentQty})` : "";
    return `${entry.itemName}${expPart}${qtyPart}`;
  };

  // ── Helper: mark rows dirty ──
  const markRowsDirty = (ids: string[]) => {
    setDirtyRowIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      dirtyRowIdsRef.current = next;
      return next;
    });
  };

  // ── Bootstrap ──
  const applyBootstrap = (bootstrap: Awaited<ReturnType<typeof loadInventoryBootstrap>>) => {
    const resolvedColumns = [...bootstrap.columns].sort(
      (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
    );
    const persistedRows = bootstrap.items;
    setOrganizationId(String(bootstrap.access?.organizationId ?? ""));
    setRegisteredLocations(bootstrap.registeredLocations ?? []);
    setColumns(resolvedColumns);
    setUserColumnOverrides(bootstrap.columnVisibilityOverrides ?? {});
    const nextRows =
      persistedRows.length > 0
        ? persistedRows
        : [createBlankInventoryRow(resolvedColumns, 0)];
    setRows(nextRows);
    rowsRef.current = nextRows;
    setDirtyRowIds(new Set());
    dirtyRowIdsRef.current = new Set();
    setDeletedRowIds(new Set());
    deletedRowIdsRef.current = new Set();
    setSelectedRowIds(new Set());
    setSelectedRowId(nextRows[0]?.id ?? null);
    setCopiedRowValues(null);
    setUndoStack([]);
    setRedoStack([]);
    editSessionCellRef.current = null;
    // Snapshot current state so the interval timer knows what's already saved
    const snap = new Map<string, string>();
    for (let i = 0; i < nextRows.length; i++) {
      snap.set(nextRows[i].id, JSON.stringify({ values: nextRows[i].values, position: i }));
    }
    lastSavedSnapshotRef.current = snap;
  };

  /** Reload inventory from the API, then prune zero-quantity rows that have
   *  at least one non-zero sibling with the same itemName. Used after
   *  approving a usage submission so "used up" duplicate rows are cleaned up. */
  const reloadAndPruneZeroRows = async () => {
    try {
      const bootstrap = await loadInventoryBootstrap();
      const freshRows = bootstrap.items;

      // Group rows by itemName
      const byName = new Map<string, typeof freshRows>();
      for (const row of freshRows) {
        const name = String(row.values.itemName ?? "").trim().toLowerCase();
        if (!name) continue;
        const group = byName.get(name) ?? [];
        group.push(row);
        byName.set(name, group);
      }

      // Identify zero-qty rows to prune (only when the item has at least one non-zero sibling)
      const idsToDelete: string[] = [];
      for (const group of byName.values()) {
        if (group.length < 2) continue;
        const hasNonZero = group.some((r) => Number(r.values.quantity ?? 0) > 0);
        if (!hasNonZero) continue;
        for (const r of group) {
          if (Number(r.values.quantity ?? 0) === 0) {
            idsToDelete.push(r.id);
          }
        }
      }

      if (idsToDelete.length > 0) {
        await saveInventoryItems([], idsToDelete);
        // Reload again to get the cleaned-up state
        const cleaned = await loadInventoryBootstrap();
        applyBootstrap(cleaned);
      } else {
        applyBootstrap(bootstrap);
      }
    } catch {
      // Silently fall back -- the approval itself already succeeded
    }
  };

  // ── Undo/Redo ──
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

  // ── Cell editing sessions ──
  const beginCellEditSession = (rowId: string, columnKey: string) => {
    const cellKey = `${rowId}:${columnKey}`;
    if (editSessionCellRef.current === cellKey) return;
    editSessionCellRef.current = cellKey;
    editingRowIdRef.current = rowId;
    // Defer state updates so they don't cause a re-render that clears
    // the text selection from select(). Also re-select after the deferred
    // re-render in case a pending state update (from a previous edit)
    // already triggered a re-render that cleared the selection.
    requestAnimationFrame(() => {
      setSelectedRowId(rowId);
      pushUndoSnapshot();
      // Re-select after the state updates flush -- the re-render from
      // setSelectedRowId/pushUndoSnapshot will clear the selection again.
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLInputElement | null;
        if (active?.select && active.tagName === "INPUT") {
          active.select();
        }
      });
    });
  };

  const endCellEditSession = () => {
    editSessionCellRef.current = null;
    editingRowIdRef.current = null;
  };

  // ── Cell change ──
  const onCellChange = (rowId: string, column: InventoryColumn, value: string) => {
    if (!canEditTable) return;
    let changedRowId: string | null = null;
    setRows((prev) => {
      const next = prev.map((row) => {
        if (row.id !== rowId) return row;
        const currentValue = row.values[column.key];
        // Auto-clear orderedAt when restocking fields are updated
        const shouldClearOrdered = ORDERED_CLEAR_KEYS.has(column.key) && !!row.values.orderedAt;
        if (NUMBER_COLUMN_KEYS.has(column.key)) {
          const parsed = Number(value);
          const nextValue = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
          if (currentValue === nextValue && !shouldClearOrdered) return row;
          changedRowId = row.id;
          return {
            ...row,
            values: {
              ...row.values,
              [column.key]: nextValue,
              ...(shouldClearOrdered ? { orderedAt: null } : {}),
            },
          };
        }
        if (column.type === "date") {
          const nextValue = toDateInputValue(value);
          if (String(currentValue ?? "") === nextValue && !shouldClearOrdered) return row;
          changedRowId = row.id;
          return {
            ...row,
            values: {
              ...row.values,
              [column.key]: nextValue,
              ...(shouldClearOrdered ? { orderedAt: null } : {}),
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
      });
      // Synchronously update ref so onSave (via endCellEditSession/onBlur)
      // sees the latest rows before React commits the state update.
      rowsRef.current = next;
      return next;
    });
    if (changedRowId) {
      const resolvedRowId = changedRowId;
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        next.add(resolvedRowId);
        // Synchronously update ref so the interval timer and unload handlers
        // see the dirty ID immediately, before React re-renders.
        dirtyRowIdsRef.current = next;
        return next;
      });
    }
  };

  // ── Row operations ──
  const onAddRow = (position: "above" | "below", event?: ReactMouseEvent<HTMLElement>) => {
    if (!canEditTable) return;
    pushUndoSnapshot();
    if (event) {
      const element = event.target as HTMLElement | null;
      element?.closest("details")?.removeAttribute("open");
    }
    const anchorFromFiltered =
      filteredRows.find(({ row }) => row.id === selectedRowId)?.row;
    const anchorRowId = anchorFromFiltered?.id ?? null;
    const newRowId = crypto.randomUUID();
    setSelectedRowId(newRowId);
    setDirtyRowIds((ids) => {
      const next = new Set(ids);
      next.add(newRowId);
      dirtyRowIdsRef.current = next;
      return next;
    });
    setRows((prev) => {
      const selectedIndex =
        anchorRowId ? prev.findIndex((row) => row.id === anchorRowId) : -1;
      const insertIndex = selectedIndex >= 0
        ? (position === "above" ? selectedIndex : selectedIndex + 1)
        : prev.length;
      const created = createBlankInventoryRow(allColumns, insertIndex);
      created.id = newRowId;
      if (locationColumn && effectiveLocationFilter !== "All Locations" && effectiveLocationFilter !== UNASSIGNED_LOCATION) {
        created.values[locationColumn.key] = effectiveLocationFilter;
      }
      const next = [
        ...prev.slice(0, insertIndex),
        created,
        ...prev.slice(insertIndex),
      ];
      rowsRef.current = next;
      return next;
    });
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
    const allFilteredSelected = filteredRowIds.length > 0 &&
      filteredRowIds.filter((rowId) => selectedRowIds.has(rowId)).length === filteredRowIds.length;
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

  const normalizeLinkValue = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    // Block dangerous URI schemes
    if (/^(javascript|data|vbscript):/i.test(trimmed)) return "";
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };

  const onPasteToSelectedRow = () => {
    if (!canEditTable || !selectedRowId || !copiedRowValues) return;
    pushUndoSnapshot();
    let changedRowId: string | null = null;
    setRows((prev) => {
      const next = prev.map((row) => {
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
      });
      rowsRef.current = next;
      return next;
    });

    if (changedRowId) {
      const resolvedRowId = changedRowId;
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        next.add(resolvedRowId);
        dirtyRowIdsRef.current = next;
        return next;
      });
    }
  };

  const onRequestDeleteSelectedRows = () => {
    if (!canEditTable || selectedRowIds.size === 0) return;
    setPendingDeleteRows(true);
  };

  const onConfirmDeleteSelectedRows = () => {
    setPendingDeleteRows(false);
    if (!canEditTable || selectedRowIds.size === 0) return;
    pushUndoSnapshot();
    const idsToDelete = new Set(selectedRowIds);
    const persistedIdsToDelete = rows
      .filter((row) => idsToDelete.has(row.id) && Boolean(row.createdAt))
      .map((row) => row.id);
    setDeletedRowIds((prev) => {
      const next = new Set(prev);
      for (const id of persistedIdsToDelete) next.add(id);
      deletedRowIdsRef.current = next;
      return next;
    });
    setDirtyRowIds((prev) => {
      const next = new Set(prev);
      for (const id of idsToDelete) next.delete(id);
      dirtyRowIdsRef.current = next;
      return next;
    });
    setRows((prev) => {
      if (prev.length <= 1) {
        const created = createBlankInventoryRow(allColumns, 0);
        setDirtyRowIds((ids) => {
          const next = new Set(ids);
          next.add(created.id);
          dirtyRowIdsRef.current = next;
          return next;
        });
        setSelectedRowId(created.id);
        rowsRef.current = [created];
        return [created];
      }
      const nextRows = prev.filter((row) => !idsToDelete.has(row.id));
      if (nextRows.length === 0) {
        const created = createBlankInventoryRow(allColumns, 0);
        setDirtyRowIds((ids) => {
          const next = new Set(ids);
          next.add(created.id);
          dirtyRowIdsRef.current = next;
          return next;
        });
        setSelectedRowId(created.id);
        rowsRef.current = [created];
        return [created];
      }
      if (selectedRowId && idsToDelete.has(selectedRowId)) {
        setSelectedRowId(nextRows[0]?.id ?? null);
      }
      rowsRef.current = nextRows;
      return nextRows;
    });
    setSelectedRowIds(new Set());
  };

  const onMoveSelectedRows = (targetLocation: string) => {
    if (!canEditTable || !locationColumn) return;
    const idsToMove = selectedRowIds.size > 0 ? selectedRowIds : (selectedRowId ? new Set([selectedRowId]) : new Set<string>());
    if (idsToMove.size === 0) return;
    pushUndoSnapshot();
    setRows((prev) => {
      const next = prev.map((row) =>
        idsToMove.has(row.id)
          ? { ...row, values: { ...row.values, [locationColumn.key]: targetLocation } }
          : row,
      );
      rowsRef.current = next;
      return next;
    });
    setDirtyRowIds((prev) => {
      const next = new Set(prev);
      for (const id of idsToMove) next.add(id);
      dirtyRowIdsRef.current = next;
      return next;
    });
    setSelectedRowIds(new Set());
  };

  // ── Display helpers ──
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

  // ── Snapshot-based save ──
  /** Serialize a row's saveable state for snapshot comparison.
   *  Includes position so reordering is detected. */
  const serializeRowForSnapshot = (row: InventoryRow, position: number) =>
    JSON.stringify({ values: row.values, position });

  /** Return rows that differ from the last-saved snapshot, with positions set.
   *  Skips new blank rows (no createdAt, all values at defaults) -- those
   *  shouldn't auto-save until the user has filled something in. */
  const diffRowsAgainstSnapshot = (currentRows: InventoryRow[], snap: Map<string, string>) => {
    const changed: InventoryRow[] = [];
    for (let i = 0; i < currentRows.length; i++) {
      const row = currentRows[i];
      const prev = snap.get(row.id);
      const serialized = serializeRowForSnapshot(row, i);
      if (prev === serialized) continue;
      // New row (not in snapshot) with all-default values -- skip until user edits it
      if (prev === undefined && !row.createdAt) {
        const hasContent = Object.entries(row.values).some(([, v]) =>
          typeof v === "string" ? v.trim() !== "" : typeof v === "number" ? v !== 0 : v != null,
        );
        if (!hasContent) continue;
      }
      changed.push({ ...row, position: i });
    }
    return changed;
  };

  /** Diff current rows against last-saved snapshot, save any changes + deletions.
   *  No dependency on dirtyRowIds for detecting edits -- purely snapshot-based. */
  const onSave = async (silent = false) => {
    if (!canEditInventory || savingRef.current) return;

    const currentRows = rowsRef.current;
    const pendingDeleted = Array.from(deletedRowIdsRef.current);
    const snap = lastSavedSnapshotRef.current;

    const changedRows = diffRowsAgainstSnapshot(currentRows, snap);

    if (changedRows.length === 0 && pendingDeleted.length === 0) return;

    savingRef.current = true;
    setSaving(true);
    try {
      await saveInventoryItems(changedRows, pendingDeleted);

      // Update snapshot to reflect what was just saved
      const nextSnap = new Map(snap);
      for (const row of changedRows) {
        nextSnap.set(row.id, serializeRowForSnapshot(row, row.position));
      }
      for (const id of pendingDeleted) {
        nextSnap.delete(id);
      }
      lastSavedSnapshotRef.current = nextSnap;

      // Clear deleted IDs that were just saved
      if (pendingDeleted.length > 0) {
        const savedSet = new Set(pendingDeleted);
        setDeletedRowIds((prev) => {
          const next = new Set(prev);
          for (const id of savedSet) next.delete(id);
          deletedRowIdsRef.current = next;
          return next;
        });
      }

      // Also clear dirtyRowIds for the saved rows (keeps UI indicators accurate)
      const savedIds = new Set(changedRows.map((r) => r.id));
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        for (const id of savedIds) next.delete(id);
        dirtyRowIdsRef.current = next;
        return next;
      });

      setUndoStack([]);
      setRedoStack([]);
      pruningRef.current = false;
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 2000);
    } catch (err: any) {
      if (!silent) {
        alert(err?.message ?? "Failed to save inventory");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Keep a stable ref to onSave so the interval always calls the latest version.
  onSaveRef.current = onSave;

  // ── Import handlers ──
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
      const beforeImportSignature = buildRowsSignature(rows);
      const result = await importInventoryCsv(csvImportDialog.csvText, selectedHeaders);
      const bootstrap = await loadInventoryBootstrap();
      const afterImportSignature = buildRowsSignature(bootstrap.items);

      if (beforeImportSignature === afterImportSignature) {
        throw new Error("Import canceled: all selected rows are already in inventory.");
      }

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
      applyBootstrap(bootstrap);
      setCsvImportDialog(null);
      alert("Import complete.");
    } catch (err: any) {
      alert(err?.message ?? "Import failed. Please verify your file headers and row values.");
    } finally {
      setImportingCsv(false);
    }
  };

  // ── Effects ──

  // Bootstrap loading with provisioning retry
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError("");
      setLoadingMessage(pickLoadingLine());

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
            isProvisioningRef.current = true;
            setLoadingMessage(pickLoadingLine());
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

  // Loading message rotation
  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => {
      setLoadingMessage(() =>
        pickLoadingLine(),
      );
    }, 2200);
    return () => window.clearInterval(interval);
  }, [loading]);

  // Keyboard shortcuts (Cmd+Z/Y/C/V)
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

  // Keepalive/unload save
  useEffect(() => {
    /** Synchronous, keepalive save for page unload / hide / SPA unmount.
     *  Uses snapshot diffing -- no dirty tracking dependency.
     *  Bypasses savingRef -- even if an async save is in flight,
     *  we fire a redundant keepalive request to guarantee delivery. */
    const flushSync = () => {
      if (!canEditInventory) return;
      const changedRows = diffRowsAgainstSnapshot(rowsRef.current, lastSavedSnapshotRef.current);
      const pendingDeleted = Array.from(deletedRowIdsRef.current);
      if (changedRows.length === 0 && pendingDeleted.length === 0) return;
      saveInventoryItemsSync(changedRows, pendingDeleted);
    };

    const onPageHide = () => flushSync();
    const onBeforeUnload = () => flushSync();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushSync();
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // SPA navigation unmount -- fire keepalive save
      flushSync();
    };
  }, [canEditInventory]);

  // Expose save fn to parent
  useEffect(() => {
    if (!onSaveFnChange) return;
    const fn = () => onSaveRef.current();
    onSaveFnChange(fn);
    return () => onSaveFnChange(null);
  }, [onSaveFnChange]);

  // Autosave interval
  useEffect(() => {
    if (!canEditInventory) return;
    const id = window.setInterval(() => {
      void onSaveRef.current(true);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearInterval(id);
  }, [canEditInventory]);

  // Location auto-add on creation
  useEffect(() => {
    if (pendingNewLocationRef.current && effectiveLocationFilter === pendingNewLocationRef.current && canEditTable) {
      pendingNewLocationRef.current = null;
      onAddRow("above");
    }
  }, [effectiveLocationFilter]);

  // Clear selections when switching locations
  useEffect(() => {
    setSelectedRowIds(new Set());
    setSelectedRowId(null);
  }, [effectiveLocationFilter]);

  // Selection validation
  useEffect(() => {
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(rows.map((row) => row.id));
      const filtered = new Set(Array.from(prev).filter((rowId) => validIds.has(rowId)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [rows]);

  // Handle deferred scroll-to-row after tab/sort/filter changes settle
  useEffect(() => {
    const rowId = pendingScrollToRowRef.current;
    if (!rowId) return;
    const rowIndex = filteredRows.findIndex((r) => r.row.id === rowId);
    if (rowIndex < 0) return;
    const ROWS_PER_PAGE_LOCAL = 50;
    const targetPage = Math.floor(rowIndex / ROWS_PER_PAGE_LOCAL) + 1;
    setCurrentPage(targetPage);
    pendingScrollToRowRef.current = null;
    setTimeout(() => {
      const el = document.querySelector(`[data-row-id="${rowId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => {
          const input = el.querySelector<HTMLInputElement>('input[type="url"]');
          if (input) {
            input.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
            input.focus();
          }
        }, 100);
      }
    }, 100);
  }, [filteredRows]);

  // Select all checkbox indeterminate state
  useEffect(() => {
    if (!selectAllCheckboxRef.current) return;
    const selectedFilteredCount = filteredRowIds.filter((rowId) => selectedRowIds.has(rowId)).length;
    const allFilteredSelected = filteredRowIds.length > 0 && selectedFilteredCount === filteredRowIds.length;
    const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;
    selectAllCheckboxRef.current.indeterminate = someFilteredSelected;
  }, [filteredRowIds, selectedRowIds]);

  // Auto-select first filtered row
  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedRowId(null);
      return;
    }
    if (!filteredRows.some(({ row }) => row.id === selectedRowId)) {
      setSelectedRowId(filteredRows[0].row.id);
    }
  }, [filteredRows, selectedRowId]);

  // If no location selected yet but locations exist, auto-select the first one
  // (passed through from filters hook locationOptions)

  // ── Computed derived values ──
  const selectedFilteredCount = useMemo(
    () => filteredRowIds.filter((rowId) => selectedRowIds.has(rowId)).length,
    [filteredRowIds, selectedRowIds],
  );

  const allFilteredSelected = filteredRowIds.length > 0 && selectedFilteredCount === filteredRowIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;

  return {
    // Loading
    loading,
    loadError,
    loadingMessage,
    // Org
    organizationId,
    // Columns
    columns,
    setColumns,
    userColumnOverrides,
    setUserColumnOverrides,
    // Rows
    rows,
    setRows,
    dirtyRowIds,
    setDirtyRowIds,
    deletedRowIds,
    setDeletedRowIds,
    selectedRowId,
    setSelectedRowId,
    copiedRowValues,
    setCopiedRowValues,
    // Undo
    undoStack,
    redoStack,
    // Editing
    editingLinkCell,
    setEditingLinkCell,
    editingDateCell,
    setEditingDateCell,
    // Save
    saving,
    showSaved,
    // Import
    importingCsv,
    csvImportDialog,
    setCsvImportDialog,
    pasteImportDialog,
    setPasteImportDialog,
    // Locations
    registeredLocations,
    setRegisteredLocations,
    addingLocation,
    setAddingLocation,
    newLocationName,
    setNewLocationName,
    addLocationError,
    setAddLocationError,
    // Delete
    pendingDeleteRows,
    setPendingDeleteRows,
    // Refs
    importInputRef,
    selectAllCheckboxRef,
    editingRowIdRef,
    pendingScrollToRowRef,
    editSessionCellRef,
    rowsRef,
    dirtyRowIdsRef,
    deletedRowIdsRef,
    selectedRowIdsRef,
    selectedRowIdRef,
    isProvisioningRef,
    savingRef,
    pruningRef,
    restoringSnapshotRef,
    lastSavedSnapshotRef,
    pendingNewLocationRef,
    onSaveRef,
    // Row operations
    onAddRow,
    onToggleRowSelection,
    onToggleSelectAllFiltered,
    onCopySelectedRow,
    onPasteToSelectedRow,
    onRequestDeleteSelectedRows,
    onConfirmDeleteSelectedRows,
    onMoveSelectedRows,
    onCellChange,
    // Cell edit sessions
    beginCellEditSession,
    endCellEditSession,
    // Save
    onSave,
    // Display helpers
    getReadOnlyCellText,
    isEditingLinkCell,
    isEditingDateCell,
    normalizeLinkValue,
    // Undo/Redo
    pushUndoSnapshot,
    undoLastChange,
    redoLastChange,
    snapshotFromRefs,
    applySnapshot,
    // Bootstrap
    applyBootstrap,
    reloadAndPruneZeroRows,
    // Import handlers
    onChooseCsvImport,
    onOpenPasteImport,
    onCsvSelected,
    onToggleImportHeader,
    onCancelCsvImport,
    onCancelPasteImport,
    onConfirmPasteImport,
    onConfirmCsvImport,
    // Snapshot helpers
    serializeRowForSnapshot,
    diffRowsAgainstSnapshot,
    // Dirty helpers
    markRowsDirty,
    // Pending entry labels
    buildPendingEntryLabel,
    rowById,
    // Derived
    canEditTable,
    allFilteredSelected,
    someFilteredSelected,
    selectedFilteredCount,
  };
}
