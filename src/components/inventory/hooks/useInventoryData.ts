import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  convertImportFileToCsv,
  extractCsvHeaders,
  importInventoryCsv,
  isDeleteBlockedError,
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  loadInventoryItems,
  moveInventoryItems,
  saveInventoryItems,
  saveInventoryItemsSync,
  type ColumnVisibilityOverrides,
  type InventoryColumn,
  type InventoryLocation,
  type InventoryRow,
  type ItemVendorPricingEntry,
} from "../../../lib/inventoryApi";
import { pickLoadingLine } from "../../../lib/loadingLines";
import { formatCurrency, isCurrencyColumnKey, parseCurrency } from "../../../lib/currency";
import type {
  ActiveTab,
  CsvImportDialogState,
  InventorySnapshot,
  PasteImportDialogState,
} from "../inventoryTypes";
import {
  AUTOSAVE_DELAY_MS,
  DEFAULT_PROVISIONING_RETRY_MS,
  NUMBER_COLUMN_KEYS,
  UNDO_HISTORY_LIMIT,
} from "../inventoryTypes";
import { buildRowsSignature, createBlankInventoryRow, normalizeHeaderKey } from "../inventoryUtils";
import { useToast } from "../../shared/Toast";

interface UseInventoryDataParams {
  canEditInventory: boolean;
  initialEditCell?: { rowId: string; columnKey: string };
  selectedLocationId: string | null;
  onSelectedLocationIdChange: (locationId: string | null) => void;
  onSaveFnChange?: (fn: (() => Promise<void>) | null) => void;
  /** From the filters hook — the location id currently in scope (or ALL_LOCATIONS). */
  effectiveLocationId: string;
  /** From the filters hook — the "All Locations" sentinel. */
  ALL_LOCATIONS: string;
  /** From the filters hook */
  allColumns: InventoryColumn[];
  /** From the filters hook */
  filteredRows: { row: InventoryRow; index: number }[];
  /** From the filters hook */
  filteredRowIds: string[];
  /** From the filters hook */
  visibleColumns: InventoryColumn[];
  /** From the filters hook */
  setSelectedRowIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Current inventory tab. Used to disable table edits when in Log Usage mode. */
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
  selectedLocationId: _selectedLocationId,
  onSelectedLocationIdChange: _onSelectedLocationIdChange,
  onSaveFnChange,
  effectiveLocationId,
  ALL_LOCATIONS,
  allColumns,
  filteredRows,
  filteredRowIds,
  visibleColumns: _visibleColumns,
  setSelectedRowIds,
  activeTab,
  selectedRowIds,
  toDateInputValue,
  setCurrentPage,
}: UseInventoryDataParams) {
  const toast = useToast();
  const canEditTable = canEditInventory && activeTab !== "logUsage";

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
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  // 1g: per-(item, vendor) pricing rows, indexed for fast modal + Shop reads.
  // Source of truth is the bootstrap response + delta updates from upsert /
  // delete calls. Map<itemId, Map<vendorLower, entry>> so the modal load
  // is O(1) per item.
  const [vendorPricing, setVendorPricing] = useState<Map<string, Map<string, ItemVendorPricingEntry>>>(new Map());
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [addLocationError, setAddLocationError] = useState<string | null>(null);
  const [registeredVendors, setRegisteredVendors] = useState<string[]>([]);
  // 1h.2c: per-org curated unit list. Empty array fallback signals "use
  // the master KNOWN_UNITS list" — every legacy org sees the same picker
  // they did before until they curate via Settings.
  const [allowedUnits, setAllowedUnits] = useState<string[]>([]);
  // 1h.7: org-wide UoM gate. Default false (EMS-style) — i modal
  // hides Amount/Unit fields. Pantry/restaurant orgs flip on in Settings.
  const [tracksUnits, setTracksUnits] = useState<boolean>(false);
  const [migrationToastShown, setMigrationToastShown] = useState(false);
  /** Open-state for the unified Remove dialog. The rowIds are captured at
   *  the moment of opening so subsequent selection changes don't shift the
   *  target (matters for the mobile per-row case where selectedRowIds may
   *  not even reflect the row that triggered the dialog). Null = closed. */
  const [removeTarget, setRemoveTarget] = useState<{ rowIds: string[] } | null>(null);
  const [userColumnOverrides, setUserColumnOverrides] = useState<ColumnVisibilityOverrides>({});

  // ── Refs ──
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const editingRowIdRef = useRef<string | null>(null);
  /** Row that was recently blurred — autosave still skips it for a short grace period
   *  so rapid cross-cell edits within the same row don't produce intermediate audit entries. */
  const recentlyEditedRowIdRef = useRef<string | null>(null);
  const recentlyEditedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollToRowRef = useRef<string | null>(null);
  const editSessionCellRef = useRef<string | null>(null);
  /** Anchor row ID that a newly-added row was inserted above/below */
  const newRowAnchorIdRef = useRef<string | null>(null);
  const newRowPositionRef = useRef<"above" | "below">("below");
  const anchorReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Captured filteredRows index of the row being edited. Lets the filters
   *  hook pin that row in place so it doesn't jump around as its sort key
   *  (e.g. item name) changes character-by-character. Null when nothing is
   *  being edited. */
  const editingOriginalIndexRef = useRef<number | null>(null);
  /** Bumped when editing ends to force filteredRows memo to re-sort */
  const [sortEpoch, setSortEpoch] = useState(0);
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
  const onSaveRef = useRef<(silent?: boolean) => Promise<void>>(async () => {});

  // ── Ref sync ──
  useEffect(() => {
    rowsRef.current = rows;
    dirtyRowIdsRef.current = dirtyRowIds;
    deletedRowIdsRef.current = deletedRowIds;
    selectedRowIdsRef.current = selectedRowIds;
    selectedRowIdRef.current = selectedRowId;
  }, [rows, dirtyRowIds, deletedRowIds, selectedRowIds, selectedRowId]);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

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
    setLocations(bootstrap.locations ?? []);
    setRegisteredVendors(bootstrap.registeredVendors ?? []);
    setAllowedUnits(bootstrap.allowedUnits ?? []);
    setTracksUnits(bootstrap.tracksUnits ?? false);
    // 1g: index vendor-pricing rows by itemId → vendorLower → entry. Bootstrap
    // returns a flat array; transformed once on apply so reads in the modal
    // and Shop are O(1).
    const nextVendorPricing = new Map<string, Map<string, ItemVendorPricingEntry>>();
    for (const entry of bootstrap.vendorPricing ?? []) {
      const inner = nextVendorPricing.get(entry.itemId) ?? new Map<string, ItemVendorPricingEntry>();
      inner.set(entry.vendorLower, entry);
      nextVendorPricing.set(entry.itemId, inner);
    }
    setVendorPricing(nextVendorPricing);
    setColumns(resolvedColumns);
    setUserColumnOverrides(bootstrap.columnVisibilityOverrides ?? {});
    // Show the migration toast once per session per org. The server only sets
    // migrationNotice on the bootstrap that actually ran the migration, so a
    // page refresh after the toast was dismissed won't re-trigger it.
    if (bootstrap.migrationNotice && !migrationToastShown) {
      toast.info(bootstrap.migrationNotice.message);
      setMigrationToastShown(true);
    }
    // Pick a fallback locationId for new blank rows when there are no items.
    const seedLocationId = bootstrap.locations?.[0]?.id;
    const nextRows =
      persistedRows.length > 0
        ? persistedRows
        : [
            {
              ...createBlankInventoryRow(resolvedColumns, 0),
              locationId: seedLocationId,
            },
          ];
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

    // Figure out whether the user is continuing on the same row (blur→focus
    // between cells of one row) or switching to a new row. The previously-
    // pinned row can be held in editingRowIdRef (active edit) OR
    // recentlyEditedRowIdRef (grace period after blur).
    const prevPinnedRowId = editingRowIdRef.current ?? recentlyEditedRowIdRef.current;
    const switchingRow = prevPinnedRowId !== null && prevPinnedRowId !== rowId;

    editingRowIdRef.current = rowId;

    // Cancel any grace-period timers from the previous edit session.
    if (recentlyEditedTimerRef.current) clearTimeout(recentlyEditedTimerRef.current);
    recentlyEditedRowIdRef.current = null;
    recentlyEditedTimerRef.current = null;
    if (anchorReleaseTimerRef.current) clearTimeout(anchorReleaseTimerRef.current);
    anchorReleaseTimerRef.current = null;

    if (switchingRow) {
      // Release the previous row's anchor + pin — user has moved on.
      if (newRowAnchorIdRef.current) {
        newRowAnchorIdRef.current = null;
      }
      editingOriginalIndexRef.current = null;
      setSortEpoch((n) => n + 1);
    }

    // Capture this row's current position for pinning so it doesn't jump
    // around as its sort key changes per keystroke. Skip if:
    //  - the row is a newly-added row with an anchor (anchor governs its spot), or
    //  - we already have a pin captured for this row (resuming same-row edit,
    //    or onAddRow's top-pin set it to 0 before any cell click).
    if (!newRowAnchorIdRef.current && editingOriginalIndexRef.current === null) {
      const idx = filteredRowIds.indexOf(rowId);
      editingOriginalIndexRef.current = idx >= 0 ? idx : null;
    }
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
    const rowId = editingRowIdRef.current;
    editSessionCellRef.current = null;
    editingRowIdRef.current = null;
    // Keep editingOriginalIndexRef set through the grace period below so
    // the row stays pinned across blur→focus when tabbing between cells of
    // the same row. It's cleared by the grace timer (or by
    // beginCellEditSession when the user switches to a different row).
    if (rowId) {
      recentlyEditedRowIdRef.current = rowId;
      if (recentlyEditedTimerRef.current) clearTimeout(recentlyEditedTimerRef.current);
      recentlyEditedTimerRef.current = setTimeout(() => {
        recentlyEditedRowIdRef.current = null;
        recentlyEditedTimerRef.current = null;
        editingOriginalIndexRef.current = null;
        setSortEpoch((n) => n + 1);
      }, 5000);
      // Short timer for releasing the sort anchor — just long enough to
      // survive the blur→focus gap when tabbing between cells (~200ms).
      if (newRowAnchorIdRef.current) {
        if (anchorReleaseTimerRef.current) clearTimeout(anchorReleaseTimerRef.current);
        anchorReleaseTimerRef.current = setTimeout(() => {
          anchorReleaseTimerRef.current = null;
          if (newRowAnchorIdRef.current) {
            newRowAnchorIdRef.current = null;
            setSortEpoch((n) => n + 1);
          }
        }, 300);
      }
    }
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
        const nextValues: Record<string, string | number | boolean | null> = {
          ...row.values,
          [column.key]: value,
        };
        // When the user edits packCost or packSize, recompute the derived
        // unitCost from (packCost / packSize) so the stored cache stays in
        // sync with what the Unit Cost cell will display. Analytics consumers
        // read values.unitCost — this keeps them honest after a manual edit.
        if (column.key === "packCost" || column.key === "packSize") {
          const rawPackCost = column.key === "packCost" ? value : String(row.values.packCost ?? "");
          const rawPackSize = column.key === "packSize" ? value : String(row.values.packSize ?? "");
          const packCost = parseCurrency(rawPackCost);
          const packSize = Number(rawPackSize);
          if (
            Number.isFinite(packCost)
            && packCost >= 0
            && Number.isFinite(packSize)
            && packSize > 0
          ) {
            nextValues.unitCost = packCost / packSize;
          }
        }
        return { ...row, values: nextValues };
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
  const onAddRow = (position: "above" | "below" | "top", event?: ReactMouseEvent<HTMLElement>) => {
    if (!canEditTable) return;
    pushUndoSnapshot();
    if (event) {
      const element = event.target as HTMLElement | null;
      element?.closest("details")?.removeAttribute("open");
    }
    // "top" means no anchor — always insert at position 0 and pin to top of sorted list
    const useAnchor = position !== "top";
    const anchorFromFiltered = useAnchor
      ? filteredRows.find(({ row }) => row.id === selectedRowId)?.row
      : undefined;
    const anchorRowId = anchorFromFiltered?.id ?? null;
    const newRowId = crypto.randomUUID();
    editingRowIdRef.current = newRowId;
    newRowAnchorIdRef.current = anchorRowId;
    newRowPositionRef.current = position === "top" ? "above" : position;
    // "top" add (or above/below without a valid anchor) has no anchor row to
    // pin next to — blank values would otherwise sort the new row to the end.
    // Pin via editingOriginalIndexRef (the "existing row being edited" path)
    // so the filters hook puts it at index 0. Cleared by endCellEditSession.
    if (!anchorRowId) {
      editingOriginalIndexRef.current = 0;
    }
    setSelectedRowId(newRowId);
    // Bump sort epoch so filtered-rows memo re-evaluates with the new ref values
    setSortEpoch((n) => n + 1);
    setDirtyRowIds((ids) => {
      const next = new Set(ids);
      next.add(newRowId);
      dirtyRowIdsRef.current = next;
      return next;
    });
    setRows((prev) => {
      const selectedIndex = anchorRowId
        ? prev.findIndex((row) => row.id === anchorRowId)
        : -1;
      const insertIndex = selectedIndex >= 0
        ? (position === "above" ? selectedIndex : selectedIndex + 1)
        : 0;
      const created = createBlankInventoryRow(allColumns, insertIndex);
      created.id = newRowId;
      // Stamp the structural location pointer. We never create rows in the
      // "All Locations" view (the toolbar disables Add Row there); fall back
      // to the first available location if the scope is somehow ALL.
      const fallbackLoc = locations[0]?.id;
      created.locationId =
        effectiveLocationId !== ALL_LOCATIONS ? effectiveLocationId : fallbackLoc;
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

  /**
   * Hard-delete the given rows. Used by the unified Remove dialog when the
   * user picks "Created by mistake". Server-side guard still enforces
   * qty == 0; this is the client-side optimistic update.
   */
  const performDeleteRows = (idsToDelete: Set<string>) => {
    if (!canEditTable || idsToDelete.size === 0) return;
    pushUndoSnapshot();
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
        // Pick a replacement from the sorted/filtered view (not the raw rows
        // array) so the auto-paginate effect keeps the user on their current
        // page instead of jumping to wherever nextRows[0] lands after sort.
        const oldFilteredIdx = filteredRows.findIndex(
          ({ row }) => row.id === selectedRowId,
        );
        if (oldFilteredIdx >= 0) {
          const survivors = filteredRows
            .map(({ row }) => row.id)
            .filter((id) => !idsToDelete.has(id));
          const replacement =
            survivors[Math.min(oldFilteredIdx, survivors.length - 1)] ?? null;
          setSelectedRowId(replacement);
        } else {
          setSelectedRowId(nextRows[0]?.id ?? null);
        }
      }
      rowsRef.current = nextRows;
      return nextRows;
    });
    setSelectedRowIds(new Set());
  };

  // ── Unified Remove flow ────────────────────────────────────────────────
  // The dialog asks "what happened?" and routes to either retire (with
  // reason + optional notes) or hard delete. Capture rowIds at open time so
  // the action targets exactly the rows the user clicked, even if the
  // global selection changes underneath us before the user confirms.
  const onRequestRemoveRow = (rowId: string) => {
    if (!canEditTable) return;
    setRemoveTarget({ rowIds: [rowId] });
  };

  const onRequestRemoveSelectedRows = () => {
    if (!canEditTable || selectedRowIds.size === 0) return;
    setRemoveTarget({ rowIds: Array.from(selectedRowIds) });
  };

  const onCancelRemove = () => setRemoveTarget(null);

  const onConfirmRemove = async (
    choice: import("../RemoveItemDialog").RemoveChoice,
  ) => {
    const target = removeTarget;
    setRemoveTarget(null);
    if (!target || !canEditTable || target.rowIds.length === 0) return;

    if (choice.kind === "delete") {
      performDeleteRows(new Set(target.rowIds));
      return;
    }

    // Retire path: reuse the existing onRetireRows handler so the qty-zero
    // stub logic, audit metadata, and reorder-list bookkeeping stay in one
    // place. Clear any selection used to populate the target so the
    // toolbar's "N selected" affordance resets afterward.
    await onRetireRows(target.rowIds, choice.reason, choice.notes);
    if (selectedRowIds.size > 0) setSelectedRowIds(new Set());
  };

  /** Structural location move. Calls the new server endpoint that emits an
   *  ITEM_MOVE audit event per row, then optimistically updates local state.
   *  Replaces the prior "edit values.location and shovel through autosave"
   *  flow — locations are no longer column values, so the move endpoint is
   *  the only way to change them. */
  const onMoveSelectedRows = async (targetLocationId: string) => {
    if (!canEditTable) return;
    const idsToMove = selectedRowIds.size > 0
      ? selectedRowIds
      : (selectedRowId ? new Set([selectedRowId]) : new Set<string>());
    if (idsToMove.size === 0) return;
    pushUndoSnapshot();
    // Optimistic update: stamp locationId locally so the table reflects the
    // move before the server roundtrip completes.
    setRows((prev) => {
      const next = prev.map((row) =>
        idsToMove.has(row.id) ? { ...row, locationId: targetLocationId } : row,
      );
      rowsRef.current = next;
      return next;
    });
    setSelectedRowIds(new Set());

    try {
      await moveInventoryItems(Array.from(idsToMove), targetLocationId);
    } catch (err: any) {
      // Revert the optimistic update on failure. Reload bootstrap to be safe —
      // partial moves are possible if the server moved some but not all.
      try {
        const bootstrap = await loadInventoryBootstrap();
        applyBootstrap(bootstrap);
      } catch { /* fall through to error toast */ }
      toast.error(err?.message ?? "Failed to move items");
    }
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
      if (isCurrencyColumnKey(column.key) && Number.isFinite(parsed)) {
        // Format ".89" / "0.89" / "4239" as "$0.89" / "$4,239.00" — read-only
        // display only; the stored value remains the numeric string so other
        // consumers (analytics, save events) can Number() it cleanly.
        return formatCurrency(parsed);
      }
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
  const diffRowsAgainstSnapshot = (
    currentRows: InventoryRow[],
    snap: Map<string, string>,
    /** Row IDs to skip (actively edited + recently blurred grace period) */
    skipRowIds?: Set<string> | null,
  ) => {
    const changed: InventoryRow[] = [];
    for (let i = 0; i < currentRows.length; i++) {
      const row = currentRows[i];
      if (skipRowIds && skipRowIds.has(row.id)) continue;
      const prev = snap.get(row.id);
      const serialized = serializeRowForSnapshot(row, i);
      if (prev === serialized) continue;
      // New row (not in snapshot) with all-default values -- skip until user edits it.
      // Post-restructure: location is structural (no longer in values), so we
      // don't need to special-case any value keys here.
      if (prev === undefined && !row.createdAt) {
        const hasContent = Object.entries(row.values).some(([_k, v]) =>
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

    // During autosave (silent), skip rows being actively edited AND rows
    // in the post-blur grace period so rapid cross-cell edits within one
    // row don't generate intermediate audit entries for each field.
    // Manual save (Save button / blur) saves everything.
    let skipIds: Set<string> | null = null;
    if (silent) {
      const editing = editingRowIdRef.current;
      const recent = recentlyEditedRowIdRef.current;
      if (editing || recent) {
        skipIds = new Set<string>();
        if (editing) skipIds.add(editing);
        if (recent) skipIds.add(recent);
      }
    }
    const changedRows = diffRowsAgainstSnapshot(
      currentRows,
      snap,
      skipIds,
    );

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
      if (isDeleteBlockedError(err)) {
        // The server rejects deletes for any row that still has stock on hand.
        // Client gates with isDeletableRow, but a race between a fresh restock
        // and a stale view can still trigger this. Restore the would-be-deleted
        // rows from the latest bootstrap so the user sees current state.
        const blockedIds = new Set(err.protectedRows.map((r) => r.id));
        setDeletedRowIds((prev) => {
          const next = new Set(prev);
          for (const id of blockedIds) next.delete(id);
          deletedRowIdsRef.current = next;
          return next;
        });
        try {
          const bootstrap = await loadInventoryBootstrap();
          applyBootstrap(bootstrap);
        } catch { /* non-critical: rows reappear on next load */ }
        if (!silent) {
          toast.error(
            "Some items still have stock — log usage or retire first, then delete.",
          );
        }
      } else if (!silent) {
        toast.error(err?.message ?? "Failed to save inventory");
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
      toast.error(err?.message ?? "Failed to import file");
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
      toast.info("Paste your CSV or tab-delimited data first.");
      return;
    }
    const headers = extractCsvHeaders(rawText);
    if (headers.length === 0) {
      toast.error("Could not detect headers from pasted data.");
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
      toast.info("Select at least one column to import.");
      return;
    }
    // CSV imports require an explicit destination location. The toolbar's
    // import flow (via handleChooseCsvImport) only opens the dialog when
    // we're scoped to a real location — but defensively reject if somehow
    // the user is in "All Locations" view here.
    if (effectiveLocationId === ALL_LOCATIONS) {
      toast.error("Pick a specific location before importing a CSV.");
      return;
    }

    setImportingCsv(true);
    try {
      const beforeImportSignature = buildRowsSignature(rows);
      const result = await importInventoryCsv(csvImportDialog.csvText, effectiveLocationId, selectedHeaders);
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
      toast.success("Import complete.");
    } catch (err: any) {
      toast.error(err?.message ?? "Import failed. Please verify your file headers and row values.");
    } finally {
      setImportingCsv(false);
    }
  };

  // ── Effects ──

  // Bootstrap loading with provisioning retry + paginated fetch of remaining items
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError("");
      setLoadingMessage(pickLoadingLine());

      // 1. Bootstrap (first page of items + columns + access)
      let bootstrap: Awaited<ReturnType<typeof loadInventoryBootstrap>> | null = null;
      while (!cancelled) {
        try {
          bootstrap = await loadInventoryBootstrap();
          if (cancelled) return;
          applyBootstrap(bootstrap);
          break;
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

      // 2. Fetch remaining pages in the background
      if (bootstrap?.nextToken) {
        let token: string | null = bootstrap.nextToken;
        while (token && !cancelled) {
          try {
            const page = await loadInventoryItems(token);
            if (cancelled) return;
            token = page.nextToken;
            // Append new rows and update snapshot so autosave doesn't flag them dirty
            setRows((prev) => {
              const next = [...prev, ...page.items];
              rowsRef.current = next;
              const snap = lastSavedSnapshotRef.current;
              for (let i = 0; i < page.items.length; i++) {
                const row = page.items[i];
                snap.set(row.id, JSON.stringify({ values: row.values, position: prev.length + i }));
              }
              return next;
            });
          } catch {
            // Non-critical: user has first page, remaining pages failed
            console.warn("Failed to load remaining inventory pages");
            break;
          }
        }
      }

      if (!cancelled) setLoading(false);
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

  // Location auto-add on creation. After a user creates a new location we
  // navigate to it and immediately drop in a blank row to type into.
  useEffect(() => {
    if (pendingNewLocationRef.current && effectiveLocationId === pendingNewLocationRef.current && canEditTable) {
      pendingNewLocationRef.current = null;
      onAddRow("above");
    }
  }, [effectiveLocationId]);

  // Clear selections when switching locations
  useEffect(() => {
    setSelectedRowIds(new Set());
    setSelectedRowId(null);
  }, [effectiveLocationId]);

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

  // ── Retire rows ──
  // Retirement is a qty-to-zero event with a reason code (see RetireReason).
  // The row is preserved in storage so retirement history survives for loss
  // analytics and the Activity audit trail, but it's hidden from the inventory
  // grid and the Reorder tab (see useInventoryFilters + ReorderTab). The reason
  // is captured in an ITEM_RETIRE audit event that drives loss analytics.
  const onRetireRows = async (
    rowIds: string[],
    reason: import("../../../lib/inventoryApi").RetireReason = "expired",
    notes?: string,
  ) => {
    if (!canEditInventory || rowIds.length === 0) return;
    const now = new Date().toISOString();
    const idSet = new Set(rowIds);

    // Snapshot qtyBefore from current rows, before we mutate them.
    const retireMetadata: Record<string, import("../../../lib/inventoryApi").RetireMetadata> = {};
    const retiredRowsToSave: InventoryRow[] = [];
    for (const row of rowsRef.current) {
      if (!idSet.has(row.id)) continue;
      const qtyBefore = Number(row.values.quantity ?? 0);
      const qtyDelta = Number.isFinite(qtyBefore) && qtyBefore > 0 ? qtyBefore : 0;
      retireMetadata[row.id] = {
        reason,
        qty: qtyDelta,
        ...(notes ? { notes } : {}),
      };
      retiredRowsToSave.push({
        ...row,
        values: {
          ...row.values,
          retiredAt: now,
          retiredQty: String(qtyBefore || 0),
          retirementReason: reason,
          quantity: 0,
          // expirationDate is intentionally kept so retirement history has context
        },
      });
    }

    if (retiredRowsToSave.length === 0) return;

    // When retirement empties the last active lot for a (itemName, location)
    // group, leave a quantity-zero stub behind so the Reorder tab still knows
    // the user needs to restock. Without this, the row vanishes from reorder
    // analytics the instant it gets retired. We skip the stub when:
    //   - another active lot for the same group remains (that lot already
    //     carries the min-qty signal)
    //   - the retired row has no minQuantity set (reorder has nothing to
    //     flag against, so a stub row would just sit there silently)
    //   - we've already queued a stub for this group in the current batch
    //     (retiring 3 lots of the same item should spawn 1 stub, not 3)
    const retiredRowIdSet = new Set(retiredRowsToSave.map((r) => r.id));
    // Group key uses structural locationId now. Empty string for items
    // without a location (shouldn't happen post-migration, but defensive).
    const groupKey = (name: string, locId: string) => `${name}\x00${locId}`;
    const groupHasRemainingActiveLot = new Set<string>();
    for (const row of rowsRef.current) {
      if (retiredRowIdSet.has(row.id)) continue;
      if (row.values.retiredAt) continue;
      const name = String(row.values.itemName ?? "").trim();
      if (!name) continue;
      const locId = String(row.locationId ?? "");
      groupHasRemainingActiveLot.add(groupKey(name, locId));
    }
    const stubGroupsQueued = new Set<string>();
    const stubsToCreate: InventoryRow[] = [];
    for (const retiredRow of retiredRowsToSave) {
      const name = String(retiredRow.values.itemName ?? "").trim();
      if (!name) continue;
      const locId = String(retiredRow.locationId ?? "");
      const key = groupKey(name, locId);
      if (groupHasRemainingActiveLot.has(key)) continue;
      if (stubGroupsQueued.has(key)) continue;
      const minQty = Number(retiredRow.values.minQuantity);
      if (!Number.isFinite(minQty) || minQty <= 0) continue;
      stubGroupsQueued.add(key);
      const stubId = crypto.randomUUID();
      const stubValues: Record<string, string | number | boolean | null> = {
        itemName: name,
        quantity: 0,
        minQuantity: minQty,
        parentItemId: String(retiredRow.values.parentItemId ?? stubId),
      };
      // Carry reorder-relevant metadata forward so the stub behaves like the
      // original lot for reorder purposes (vendor link, pack sizing, price,
      // category). Category is no longer treated specially — it's just one
      // more field to copy forward like any other.
      for (const field of ["reorderLink", "packSize", "packCost", "unitCost", "category"] as const) {
        const v = retiredRow.values[field];
        if (v !== undefined && v !== null && v !== "") stubValues[field] = v;
      }
      stubsToCreate.push({
        id: stubId,
        position: rowsRef.current.length + stubsToCreate.length,
        locationId: locId || undefined,
        values: stubValues,
        createdAt: now,
      });
    }

    pushUndoSnapshot();
    setRows((prev) => {
      const byId = new Map(retiredRowsToSave.map((r) => [r.id, r]));
      const next = prev.map((row) => byId.get(row.id) ?? row);
      // Append stubs after the existing rows so they don't disturb ordering.
      const withStubs = stubsToCreate.length > 0 ? [...next, ...stubsToCreate] : next;
      rowsRef.current = withStubs;
      return withStubs;
    });

    // Direct save with retireMetadata — bypasses the batched autosave so the
    // metadata lands on the save request alongside the qty-zero edit.
    savingRef.current = true;
    setSaving(true);
    try {
      await saveInventoryItems([...retiredRowsToSave, ...stubsToCreate], [], {
        retireMetadata,
        skeletonRowIds: stubsToCreate.map((s) => s.id),
      });
      const snap = lastSavedSnapshotRef.current;
      const nextSnap = new Map(snap);
      for (const row of retiredRowsToSave) {
        nextSnap.set(row.id, serializeRowForSnapshot(row, row.position));
      }
      for (const stub of stubsToCreate) {
        nextSnap.set(stub.id, serializeRowForSnapshot(stub, stub.position));
      }
      lastSavedSnapshotRef.current = nextSnap;
      setDirtyRowIds((prev) => {
        const next = new Set(prev);
        for (const r of retiredRowsToSave) next.delete(r.id);
        for (const s of stubsToCreate) next.delete(s.id);
        dirtyRowIdsRef.current = next;
        return next;
      });
      setShowSaved(true);
      window.setTimeout(() => setShowSaved(false), 2000);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to retire items");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

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
    locations,
    setLocations,
    addingLocation,
    setAddingLocation,
    newLocationName,
    setNewLocationName,
    addLocationError,
    setAddLocationError,
    // Vendors
    registeredVendors,
    setRegisteredVendors,
    // Allowed units (1h.2c)
    allowedUnits,
    setAllowedUnits,
    // Org-wide tracksUnits gate (1h.7) — drives whether the i modal
    // surfaces Amount/Unit fields.
    tracksUnits,
    setTracksUnits,
    // Vendor pricing (1g) — Map<itemId, Map<vendorLower, entry>>. Item-detail
    // modal reads from this; on save it patches the map directly so the next
    // render reflects the change without a bootstrap roundtrip.
    vendorPricing,
    setVendorPricing,
    // Remove (unified dialog: routes to retire or delete based on reason)
    removeTarget,
    onRequestRemoveRow,
    onRequestRemoveSelectedRows,
    onConfirmRemove,
    onCancelRemove,
    // Refs
    importInputRef,
    selectAllCheckboxRef,
    editingRowIdRef,
    recentlyEditedRowIdRef,
    newRowAnchorIdRef,
    newRowPositionRef,
    editingOriginalIndexRef,
    sortEpoch,
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
    onMoveSelectedRows,
    onRetireRows,
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
    rowById,
    // Derived
    canEditTable,
    allFilteredSelected,
    someFilteredSelected,
    selectedFilteredCount,
  };
}
