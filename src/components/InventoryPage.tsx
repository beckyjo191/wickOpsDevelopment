import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  approveUsageSubmission,
  convertImportFileToCsv,
  deleteUsageSubmission,
  extractCsvHeaders,
  generateAndDownloadInventoryTemplate,
  importInventoryCsv,
  addInventoryLocation,
  isInventoryProvisioningError,
  listPendingSubmissions,
  loadInventoryBootstrap,
  saveInventoryItems,
  saveInventoryItemsSync,
  type ColumnVisibilityOverrides,
  type InventoryColumn,
  type InventoryRow,
  type PendingEntry,
  type PendingSubmission,
} from "../lib/inventoryApi";
import { LocationPills } from "./LocationPills";
export type InventoryFilter = "all" | "expired" | "exp30" | "exp60" | "lowStock";
type ActiveTab = InventoryFilter | "pendingSubmissions";
type SortDirection = "asc" | "desc";

interface InventoryPageProps {
  canEditInventory: boolean;
  canReviewSubmissions?: boolean;
  initialFilter?: InventoryFilter;
  initialSearch?: string;
  initialEditCell?: { rowId: string; columnKey: string };
  selectedLocation: string | null;
  onLocationChange: (location: string | null) => void;
  /** Called with the async save function when the component mounts, null when it unmounts.
   *  Lets a parent await a save before navigating away (avoids race with stale reads). */
  onSaveFnChange?: (fn: (() => Promise<void>) | null) => void;
}

const NUMBER_COLUMN_KEYS = new Set(["quantity", "minQuantity"]);
const AUTOSAVE_DELAY_MS = 3000;
const ROWS_PER_PAGE = 50;
const UNDO_HISTORY_LIMIT = 80;
const COLUMN_WIDTHS_STORAGE_KEY_PREFIX = "wickops.inventory.columnWidths:";
const DEFAULT_PROVISIONING_RETRY_MS = 2000;
import { pickLoadingLine } from "../lib/loadingLines";

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

const buildRowsSignature = (rows: InventoryRow[]): string =>
  JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      position: row.position,
      values: Object.fromEntries(
        Object.entries(row.values)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, value ?? null]),
      ),
    })),
  );

type PendingSubmissionCardProps = {
  submission: PendingSubmission;
  entries: PendingEntry[];
  editedQtys: Record<number, string>;
  buildLabel: (entry: PendingEntry) => string;
  onEditQty: (entryIndex: number, value: string) => void;
  onApprove: () => Promise<void>;
  onDelete: () => Promise<void>;
};

function PendingSubmissionCard({
  submission,
  entries,
  editedQtys,
  buildLabel,
  onEditQty,
  onApprove,
  onDelete,
}: PendingSubmissionCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handle = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err: any) {
      setError(err?.message ?? "Action failed.");
      setBusy(false);
    }
  };

  // Merge entries with the same itemId within this submission
  type MergedEntry = { entry: PendingEntry; origIndex: number; totalQty: number };
  const merged: MergedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const existing = merged.find((m) => m.entry.itemId === e.itemId);
    if (existing) {
      existing.totalQty += e.quantityUsed;
    } else {
      merged.push({ entry: e, origIndex: i, totalQty: e.quantityUsed });
    }
  }

  return (
    <div className="inventory-pending-card">
      <div className="inventory-pending-card-meta">
        <span className="inventory-pending-who">{submission.submittedByName || submission.submittedByEmail}</span>
        <span className="inventory-pending-when">{formatPendingTime(submission.submittedAt)}</span>
      </div>
      <table className="inventory-pending-entries">
        <tbody>
          {merged.map(({ entry, origIndex, totalQty }) => (
            <tr key={entry.itemId}>
              <td className="inventory-pending-entry-name">
                {buildLabel(entry)}
                {entry.notes && (
                  <span className="inventory-pending-entry-note">{entry.notes}</span>
                )}
              </td>
              <td className="inventory-pending-entry-qty">
                <input
                  type="number"
                  min={1}
                  step="any"
                  className="inventory-pending-qty-input"
                  value={editedQtys[origIndex] !== undefined ? editedQtys[origIndex] : String(totalQty)}
                  onChange={(e) => onEditQty(origIndex, e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  disabled={busy}
                  aria-label={`Quantity for ${entry.itemName}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="inventory-pending-error">{error}</p> : null}
      <div className="inventory-pending-actions">
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => void handle(onDelete)}
          disabled={busy}
        >
          Delete
        </button>
        <button
          type="button"
          className="button button-primary button-sm"
          onClick={() => void handle(onApprove)}
          disabled={busy}
        >
          {busy ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

const formatPendingTime = (isoString: string): string => {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
};

export function InventoryPage({
  canEditInventory,
  canReviewSubmissions,
  initialFilter,
  initialSearch,
  initialEditCell,
  selectedLocation,
  onLocationChange,
  onSaveFnChange,
}: InventoryPageProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [importingCsv, setImportingCsv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [activeTab, setActiveTabInternal] = useState<ActiveTab>(() => {
    if (initialFilter) return initialFilter;
    try {
      const saved = localStorage.getItem("wickops.inventory.activeTab");
      if (saved && ["all", "expired", "exp30", "exp60", "lowStock", "pendingSubmissions"].includes(saved)) {
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
  const activeFilter: InventoryFilter = activeTab === "pendingSubmissions" ? "all" : activeTab;
  const setActiveFilter = (f: InventoryFilter) => setActiveTabRaw(f);

  // When navigating from dashboard with a filter, sync the tab
  useEffect(() => {
    if (initialFilter) setActiveTabRaw(initialFilter);
  }, [initialFilter]);

  // Pending submissions state
  const [pendingSubmissions, setPendingSubmissions] = useState<PendingSubmission[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState("");
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllError, setApproveAllError] = useState("");
  // Per-submission edited quantities: submissionId → entry index → quantityUsed
  const [editedQtys, setEditedQtys] = useState<Record<string, Record<number, string>>>({});
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templateSelectedIds, setTemplateSelectedIds] = useState<Set<string> | null>(null);
  const [searchTerm, setSearchTerm] = useState(initialSearch ?? "");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(initialSearch ?? "");
  const [currentPage, setCurrentPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState("All Categories");
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
  // Derived sort for the current tab — used in JSX and filteredRows
  const sortState = sortStateByTab[activeTab] ?? (activeTab === "all" ? { key: "itemName", direction: "asc" as SortDirection } : null);
  const [organizationId, setOrganizationId] = useState("");
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());
  const [deletedRowIds, setDeletedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const editingRowIdRef = useRef<string | null>(null);
  const pendingScrollToRowRef = useRef<string | null>(null);
  const [copiedRowValues, setCopiedRowValues] = useState<Record<string, string | number | boolean | null> | null>(null);
  const [pendingDeleteRows, setPendingDeleteRows] = useState(false);
  const [undoStack, setUndoStack] = useState<InventorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<InventorySnapshot[]>([]);
  const [editingLinkCell, setEditingLinkCell] = useState<{ rowId: string; columnKey: string } | null>(initialEditCell ?? null);
  const [userColumnOverrides, setUserColumnOverrides] = useState<ColumnVisibilityOverrides>({});
  const [editingDateCell, setEditingDateCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [registeredLocations, setRegisteredLocations] = useState<string[]>([]);
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [addLocationError, setAddLocationError] = useState<string | null>(null);
  const pendingNewLocationRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 780px)").matches);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const isProvisioningRef = useRef(false);
  const [csvImportDialog, setCsvImportDialog] = useState<CsvImportDialogState | null>(null);
  const [pasteImportDialog, setPasteImportDialog] = useState<PasteImportDialogState | null>(null);
  const resizeStateRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const rowsRef = useRef(rows);
  const dirtyRowIdsRef = useRef(dirtyRowIds);
  const deletedRowIdsRef = useRef(deletedRowIds);
  const savingRef = useRef(false);
  const selectedRowIdsRef = useRef(selectedRowIds);
  const selectedRowIdRef = useRef(selectedRowId);
  const restoringSnapshotRef = useRef(false);
  const editSessionCellRef = useRef<string | null>(null);
  const canEditTable = canEditInventory && activeTab !== "pendingSubmissions";

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 780px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setSelectMode(false);
      setExpandedCardId(null);
    }
  }, [isMobile]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const buildPendingEntryLabel = (entry: PendingEntry): string => {
    const row = rowById.get(entry.itemId);
    const exp = row ? toDateInputValue(row.values.expirationDate) : "";
    const currentQty = row !== undefined ? Number(row.values.quantity ?? 0) : null;
    const expPart = exp ? ` | exp ${exp}` : "";
    const qtyPart = currentQty !== null ? ` (${currentQty})` : "";
    return `${entry.itemName}${expPart}${qtyPart}`;
  };

  const mergedPendingItems = useMemo(() => {
    if (activeTab !== "pendingSubmissions") return [] as { entry: PendingEntry; totalQty: number }[];
    const map = new Map<string, { entry: PendingEntry; totalQty: number }>();
    for (const sub of pendingSubmissions) {
      let entries: PendingEntry[] = [];
      try { entries = JSON.parse(sub.entriesJson); } catch { entries = []; }
      for (const e of entries) {
        const existing = map.get(e.itemId);
        if (existing) {
          existing.totalQty += e.quantityUsed;
        } else {
          map.set(e.itemId, { entry: e, totalQty: e.quantityUsed });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.entry.itemName.localeCompare(b.entry.itemName),
    );
  }, [pendingSubmissions, activeTab]);

  // Fetch pending submissions on mount (for badge count) and when tab is active
  useEffect(() => {
    if (!canReviewSubmissions) return;
    const isOnTab = activeTab === "pendingSubmissions";
    if (isOnTab) setPendingLoading(true);
    setPendingError("");
    listPendingSubmissions()
      .then((subs) => {
        setPendingSubmissions(subs.filter((s) => s.status === "pending"));
        if (isOnTab) setPendingLoading(false);
      })
      .catch((err: any) => {
        if (isOnTab) {
          setPendingError(err?.message ?? "Failed to load pending submissions.");
          setPendingLoading(false);
        }
      });
  }, [activeTab, canReviewSubmissions]);

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
      // Silently fall back — the approval itself already succeeded
    }
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
    editSessionCellRef.current = cellKey;
    editingRowIdRef.current = rowId;
    // Defer state updates so they don't cause a re-render that clears
    // the text selection from select(). Also re-select after the deferred
    // re-render in case a pending state update (from a previous edit)
    // already triggered a re-render that cleared the selection.
    requestAnimationFrame(() => {
      setSelectedRowId(rowId);
      pushUndoSnapshot();
      // Re-select after the state updates flush — the re-render from
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

  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => {
      setLoadingMessage(() =>
        pickLoadingLine(),
      );
    }, 2200);
    return () => window.clearInterval(interval);
  }, [loading]);

  // The location column object (from all columns, not just visible)
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

  // pruningRef kept for save-flow compatibility (reset after manual save)
  const pruningRef = useRef(false);
  // Snapshot of row values as last sent to the API.  The interval diffs
  // current rows against this to decide what to save — no dirty tracking needed.
  const lastSavedSnapshotRef = useRef<Map<string, string>>(new Map());

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

  const UNASSIGNED_LOCATION = "Unassigned";

  const locationOptions = useMemo(() => {
    const fromItems = locationColumn
      ? rows.map((row) => String(row.values[locationColumn.key] ?? "").trim()).filter((v) => v.length > 0)
      : [];
    const named = Array.from(new Set([...fromItems, ...registeredLocations])).sort((a, b) => a.localeCompare(b));
    // If any items have no location assigned, add an "Unassigned" option
    const hasUnassigned = locationColumn
      ? rows.some((row) => String(row.values[locationColumn.key] ?? "").trim() === "")
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

  // If no location selected yet but locations exist, auto-select the first one
  useEffect(() => {
    if (selectedLocation === null && locationOptions.length > 0) {
      onLocationChange(locationOptions[0]);
    }
  }, [selectedLocation, locationOptions, onLocationChange]);

  // Map prop to filter value
  const effectiveLocationFilter = selectedLocation !== null && locationOptions.includes(selectedLocation)
    ? selectedLocation
    : locationOptions.length > 0 ? locationOptions[0] : "All Locations";

  // Clear selections when switching locations
  useEffect(() => {
    setSelectedRowIds(new Set());
    setSelectedRowId(null);
  }, [effectiveLocationFilter]);

  // Auto-add an empty row when a new location is created
  useEffect(() => {
    if (pendingNewLocationRef.current && effectiveLocationFilter === pendingNewLocationRef.current && canEditTable) {
      pendingNewLocationRef.current = null;
      onAddRow("above");
    }
  }, [effectiveLocationFilter]);


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
    for (const row of rows) {
      if (locationColumn && effectiveLocationFilter !== "All Locations") {
        const rowLocation = String(row.values[locationColumn.key] ?? "").trim();
        const matchesLocation = effectiveLocationFilter === UNASSIGNED_LOCATION
          ? rowLocation === ""
          : rowLocation === effectiveLocationFilter;
        if (!matchesLocation) continue;
      }
      const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
      const isExpired = daysUntil !== null && daysUntil < 0;
      if (isExpired) expired++;
      if (daysUntil !== null && daysUntil >= 0 && daysUntil <= 30) exp30++;
      if (daysUntil !== null && daysUntil >= 0 && daysUntil <= 60) exp60++;
      const quantityRaw = row.values.quantity;
      const minQuantityRaw = row.values.minQuantity;
      const quantity = Number(quantityRaw);
      const minQuantity = Number(minQuantityRaw);
      const hasMin =
        minQuantityRaw !== null &&
        minQuantityRaw !== undefined &&
        String(minQuantityRaw).trim() !== "" &&
        Number.isFinite(minQuantity);
      const isLowStock = hasMin && Number.isFinite(quantity) && quantity < minQuantity;
      if (isLowStock) lowStock++;
    }
    return { expired, exp30, exp60, lowStock };
  }, [rows, locationColumn, effectiveLocationFilter]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = debouncedSearchTerm.trim().toLowerCase();

    const filtered = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (editingRowIdRef.current && row.id === editingRowIdRef.current) return true;
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

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * ROWS_PER_PAGE;
  const paginatedRows = filteredRows.slice(pageStart, pageStart + ROWS_PER_PAGE);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm, activeFilter, effectiveLocationFilter, effectiveCategoryFilter]);

  // Handle deferred scroll-to-row after tab/sort/filter changes settle
  useEffect(() => {
    const rowId = pendingScrollToRowRef.current;
    if (!rowId) return;
    const rowIndex = filteredRows.findIndex((r) => r.row.id === rowId);
    if (rowIndex < 0) return;
    const targetPage = Math.floor(rowIndex / ROWS_PER_PAGE) + 1;
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

  useEffect(() => {
    // Don't reset tabs while inventory is still loading — columns aren't available yet
    if (loading) return;
    if (!hasExpirationColumn && (activeFilter === "expired" || activeFilter === "exp30" || activeFilter === "exp60")) {
      setActiveFilter("all");
      return;
    }
    if (!hasMinQuantityColumn && activeFilter === "lowStock") {
      setActiveFilter("all");
    }
  }, [activeFilter, hasExpirationColumn, hasMinQuantityColumn, loading]);

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

  // Keys that, when edited, indicate an order has arrived — auto-clear orderedAt
  const ORDERED_CLEAR_KEYS = new Set(["quantity", "expirationDate"]);

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

  /** Serialize a row's saveable state for snapshot comparison.
   *  Includes position so reordering is detected. */
  const serializeRowForSnapshot = (row: InventoryRow, position: number) =>
    JSON.stringify({ values: row.values, position });

  /** Return rows that differ from the last-saved snapshot, with positions set.
   *  Skips new blank rows (no createdAt, all values at defaults) — those
   *  shouldn't auto-save until the user has filled something in. */
  const diffRowsAgainstSnapshot = (rows: InventoryRow[], snap: Map<string, string>) => {
    const changed: InventoryRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const prev = snap.get(row.id);
      const serialized = serializeRowForSnapshot(row, i);
      if (prev === serialized) continue;
      // New row (not in snapshot) with all-default values — skip until user edits it
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
   *  No dependency on dirtyRowIds for detecting edits — purely snapshot-based. */
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
    /** Synchronous, keepalive save for page unload / hide / SPA unmount.
     *  Uses snapshot diffing — no dirty tracking dependency.
     *  Bypasses savingRef — even if an async save is in flight,
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
      // SPA navigation unmount — fire keepalive save
      flushSync();
    };
  }, [canEditInventory]);

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

  // Keep a stable ref to onSave so the interval always calls the latest version.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  // Expose save function to parent so it can await a save before navigating away.
  useEffect(() => {
    if (!onSaveFnChange) return;
    const fn = () => onSaveRef.current();
    onSaveFnChange(fn);
    return () => onSaveFnChange(null);
  }, [onSaveFnChange]);

  // Background autosave: every 3 seconds, diff rows against last-saved snapshot.
  useEffect(() => {
    if (!canEditInventory) return;
    const id = window.setInterval(() => {
      void onSaveRef.current(true);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearInterval(id);
  }, [canEditInventory]);

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
                    {isMobile ? (
                      <button
                        type="button"
                        className="button button-primary button-sm"
                        onClick={(event) => onAddRow("below", event)}
                      >
                        Add Item
                      </button>
                    ) : (
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
                    )}
                    {!isMobile && rows.length > 1 && selectedRowIds.size > 0 ? (
                      <>
                        {showLocationPills && locationOptions.length > 1 ? (
                          <details className="inventory-move-menu">
                            <summary className="inventory-import-trigger">
                              Move to… <span className="inventory-move-count">{selectedRowIds.size}</span>
                            </summary>
                            <div className="inventory-move-panel">
                              {locationOptions
                                .filter((loc) => loc !== effectiveLocationFilter)
                                .map((loc) => (
                                  <button
                                    key={loc}
                                    type="button"
                                    className="inventory-move-option"
                                    onClick={(e) => {
                                      onMoveSelectedRows(loc);
                                      const details = e.currentTarget.closest("details");
                                      details?.removeAttribute("open");
                                    }}
                                  >
                                    {loc}
                                  </button>
                                ))}
                            </div>
                          </details>
                        ) : null}
                        <button className="inventory-import-trigger inventory-delete-trigger" onClick={onRequestDeleteSelectedRows}>
                          Delete ({selectedRowIds.size})
                        </button>
                      </>
                    ) : null}
                  </>
                ) : null}
                {!isMobile && (
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
                      <button
                        type="button"
                        className="inventory-import-option"
                        onClick={() => {
                          setTemplateSelectedIds(new Set(columns.map((c) => c.id)));
                          setShowTemplateDialog(true);
                        }}
                        disabled={importingCsv || saving}
                      >
                        Download Template
                      </button>
                    </div>
                  </details>
                )}
                <button
                  className="button button-primary"
                  onClick={() => void onSave()}
                  disabled={saving || (dirtyRowIds.size === 0 && deletedRowIds.size === 0 && !showSaved)}
                >
                  {saving ? "Saving..." : showSaved ? "Saved ✓" : "Save Changes"}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        {showLocationPills ? (
          <>
          <LocationPills
            locations={locationOptions.map((loc) => ({ location: loc }))}
            selectedLocation={selectedLocation}
            onLocationChange={onLocationChange}
          >
            {canEditInventory && !addingLocation ? (
              <button
                type="button"
                className="location-pill location-pill--add"
                onClick={() => { setAddingLocation(true); setAddLocationError(null); setSelectMode(false); setSelectedRowIds(new Set()); }}
                aria-label="Add location"
              >
                +
              </button>
            ) : null}
            {addingLocation && !isMobile ? (
              <span className="location-pill-add-form">
                <input
                  type="text"
                  className={`location-pill-add-input${addLocationError ? " field--error" : ""}`}
                  value={newLocationName}
                  onChange={(e) => { setNewLocationName(e.target.value); setAddLocationError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLocationName.trim()) {
                      const name = newLocationName.trim();
                      const dup = locationOptions.find((l) => l.toLowerCase() === name.toLowerCase());
                      if (dup && dup !== UNASSIGNED_LOCATION) {
                        setAddLocationError(`"${dup}" already exists`);
                        return;
                      }
                      void addInventoryLocation(name).then((locs) => {
                        setRegisteredLocations(locs);
                        pendingNewLocationRef.current = name;
                        onLocationChange(name);
                        setNewLocationName("");
                        setAddingLocation(false);
                        setAddLocationError(null);
                      }).catch((err: any) => {
                        const msg = err?.message ?? String(err);
                        setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                      });
                    }
                    if (e.key === "Escape") {
                      setNewLocationName("");
                      setAddingLocation(false);
                      setAddLocationError(null);
                    }
                  }}
                  placeholder="Location name..."
                  autoFocus
                />
                <button
                  type="button"
                  className="location-pill-add-confirm"
                  onClick={() => {
                    if (!newLocationName.trim()) return;
                    const name = newLocationName.trim();
                    const dup = locationOptions.find((l) => l.toLowerCase() === name.toLowerCase());
                    if (dup && dup !== UNASSIGNED_LOCATION) {
                      setAddLocationError(`"${dup}" already exists`);
                      return;
                    }
                    void addInventoryLocation(name).then((locs) => {
                      setRegisteredLocations(locs);
                      pendingNewLocationRef.current = name;
                      onLocationChange(name);
                      setNewLocationName("");
                      setAddingLocation(false);
                      setAddLocationError(null);
                    }).catch((err: any) => {
                      const msg = err?.message ?? String(err);
                      setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                    });
                  }}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="location-pill-add-cancel"
                  onClick={() => { setNewLocationName(""); setAddingLocation(false); setAddLocationError(null); }}
                >
                  ×
                </button>
                {addLocationError ? (
                  <span className="location-pill-add-error">{addLocationError}</span>
                ) : null}
              </span>
            ) : null}
          </LocationPills>
          {addingLocation && isMobile ? (
            <div className="location-add-row">
              <input
                type="text"
                className={`location-pill-add-input${addLocationError ? " field--error" : ""}`}
                value={newLocationName}
                onChange={(e) => { setNewLocationName(e.target.value); setAddLocationError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newLocationName.trim()) {
                    const name = newLocationName.trim();
                    const dup = locationOptions.find((l) => l.toLowerCase() === name.toLowerCase());
                    if (dup && dup !== UNASSIGNED_LOCATION) {
                      setAddLocationError(`"${dup}" already exists`);
                      return;
                    }
                    void addInventoryLocation(name).then((locs) => {
                      setRegisteredLocations(locs);
                      pendingNewLocationRef.current = name;
                      onLocationChange(name);
                      setNewLocationName("");
                      setAddingLocation(false);
                      setAddLocationError(null);
                    }).catch((err: any) => {
                      const msg = err?.message ?? String(err);
                      setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                    });
                  }
                  if (e.key === "Escape") {
                    setNewLocationName("");
                    setAddingLocation(false);
                    setAddLocationError(null);
                  }
                }}
                placeholder="Location name..."
                autoFocus
              />
              <button
                type="button"
                className="location-pill-add-confirm"
                onClick={() => {
                  if (!newLocationName.trim()) return;
                  const name = newLocationName.trim();
                  const dup = locationOptions.find((l) => l.toLowerCase() === name.toLowerCase());
                  if (dup && dup !== UNASSIGNED_LOCATION) {
                    setAddLocationError(`"${dup}" already exists`);
                    return;
                  }
                  void addInventoryLocation(name).then((locs) => {
                    setRegisteredLocations(locs);
                    pendingNewLocationRef.current = name;
                    onLocationChange(name);
                    setNewLocationName("");
                    setAddingLocation(false);
                    setAddLocationError(null);
                  }).catch((err: any) => {
                    const msg = err?.message ?? String(err);
                    setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                  });
                }}
              >
                Add
              </button>
              <button
                type="button"
                className="location-pill-add-cancel"
                onClick={() => { setNewLocationName(""); setAddingLocation(false); setAddLocationError(null); }}
              >
                ×
              </button>
              {addLocationError ? (
                <span className="location-pill-add-error">{addLocationError}</span>
              ) : null}
            </div>
          ) : null}
          </>
        ) : canEditInventory ? (
          <div className="location-empty-state">
            {!addingLocation ? (
              <>
                <p className="location-empty-state-text">
                  Add locations to organize inventory by where it's stored.
                </p>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => { setAddingLocation(true); setAddLocationError(null); }}
                >
                  + Add Location
                </button>
              </>
            ) : (
              <span className="location-pill-add-form">
                <input
                  type="text"
                  className={`location-pill-add-input${addLocationError ? " field--error" : ""}`}
                  value={newLocationName}
                  onChange={(e) => { setNewLocationName(e.target.value); setAddLocationError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLocationName.trim()) {
                      const name = newLocationName.trim();
                      void addInventoryLocation(name).then((locs) => {
                        setRegisteredLocations(locs);
                        pendingNewLocationRef.current = name;
                        onLocationChange(name);
                        setNewLocationName("");
                        setAddingLocation(false);
                        setAddLocationError(null);
                      }).catch((err: any) => {
                        const msg = err?.message ?? String(err);
                        setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                      });
                    }
                    if (e.key === "Escape") {
                      setNewLocationName("");
                      setAddingLocation(false);
                      setAddLocationError(null);
                    }
                  }}
                  placeholder="Location name..."
                  autoFocus
                />
                <button
                  type="button"
                  className="location-pill-add-confirm"
                  onClick={() => {
                    if (!newLocationName.trim()) return;
                    const name = newLocationName.trim();
                    void addInventoryLocation(name).then((locs) => {
                      setRegisteredLocations(locs);
                      pendingNewLocationRef.current = name;
                      onLocationChange(name);
                      setNewLocationName("");
                      setAddingLocation(false);
                      setAddLocationError(null);
                    }).catch((err: any) => {
                      const msg = err?.message ?? String(err);
                      setAddLocationError(msg.includes("already exists") ? msg : "Failed to add location");
                    });
                  }}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="location-pill-add-cancel"
                  onClick={() => { setNewLocationName(""); setAddingLocation(false); setAddLocationError(null); }}
                >
                  ×
                </button>
                {addLocationError ? (
                  <span className="location-pill-add-error">{addLocationError}</span>
                ) : null}
              </span>
            )}
          </div>
        ) : null}

        <div className="inventory-filter-bar">
          {isMobile ? (
            <select
              className="inventory-tab-select"
              value={activeTab}
              onChange={(e) => setActiveTabRaw(e.target.value as typeof activeTab)}
            >
              <option value="all">All Items</option>
              {hasExpirationColumn && (
                <>
                  <option value="expired">
                    Expired{tabCounts.expired > 0 ? ` (${tabCounts.expired})` : ""}
                  </option>
                  <option value="exp30">
                    Expiring 30d{tabCounts.exp30 > 0 ? ` (${tabCounts.exp30})` : ""}
                  </option>
                  <option value="exp60">
                    Expiring 60d{tabCounts.exp60 > 0 ? ` (${tabCounts.exp60})` : ""}
                  </option>
                </>
              )}
              {hasMinQuantityColumn && (
                <option value="lowStock">
                  Low Stock{tabCounts.lowStock > 0 ? ` (${tabCounts.lowStock})` : ""}
                </option>
              )}
              {canReviewSubmissions && (
                <option value="pendingSubmissions">
                  Pending{pendingSubmissions.length > 0 ? ` (${pendingSubmissions.length})` : ""}
                </option>
              )}
            </select>
          ) : (
          <div className="inventory-tabs" role="tablist" aria-label="Inventory filters">
            <button
              className={`inventory-tab-btn${activeTab === "all" ? " active" : ""}`}
              onClick={() => setActiveTabRaw("all")}
              role="tab"
              aria-selected={activeTab === "all"}
            >
              All Items
            </button>
            {hasExpirationColumn ? (
              <>
                <button
                  className={`inventory-tab-btn${activeTab === "expired" ? " active" : ""}`}
                  onClick={() => setActiveTabRaw("expired")}
                  role="tab"
                  aria-selected={activeTab === "expired"}
                >
                  Expired
                  {tabCounts.expired > 0 && activeTab !== "expired" ? (
                    <span className="inventory-tab-badge">{tabCounts.expired}</span>
                  ) : null}
                </button>
                <button
                  className={`inventory-tab-btn${activeTab === "exp30" ? " active" : ""}`}
                  onClick={() => setActiveTabRaw("exp30")}
                  role="tab"
                  aria-selected={activeTab === "exp30"}
                >
                  Expiring Within 30 Days
                  {tabCounts.exp30 > 0 && activeTab !== "exp30" ? (
                    <span className="inventory-tab-badge">{tabCounts.exp30}</span>
                  ) : null}
                </button>
                <button
                  className={`inventory-tab-btn${activeTab === "exp60" ? " active" : ""}`}
                  onClick={() => setActiveTabRaw("exp60")}
                  role="tab"
                  aria-selected={activeTab === "exp60"}
                >
                  Expiring Within 60 Days
                  {tabCounts.exp60 > 0 && activeTab !== "exp60" ? (
                    <span className="inventory-tab-badge">{tabCounts.exp60}</span>
                  ) : null}
                </button>
              </>
            ) : null}
            {hasMinQuantityColumn ? (
              <button
                className={`inventory-tab-btn${activeTab === "lowStock" ? " active" : ""}`}
                onClick={() => setActiveTabRaw("lowStock")}
                role="tab"
                aria-selected={activeTab === "lowStock"}
              >
                Low Stock
                {tabCounts.lowStock > 0 && activeTab !== "lowStock" ? (
                  <span className="inventory-tab-badge">{tabCounts.lowStock}</span>
                ) : null}
              </button>
            ) : null}
            {canReviewSubmissions ? (
              <button
                className={`inventory-tab-btn${activeTab === "pendingSubmissions" ? " active" : ""}`}
                onClick={() => setActiveTabRaw("pendingSubmissions")}
                role="tab"
                aria-selected={activeTab === "pendingSubmissions"}
              >
                Pending Submissions
                {pendingSubmissions.length > 0 && activeTab !== "pendingSubmissions" ? (
                  <span className="inventory-tab-badge">{pendingSubmissions.length}</span>
                ) : null}
              </button>
            ) : null}
          </div>
          )}
          <div className="inventory-filter-right">
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
          </div>
        </div>

        {activeTab === "pendingSubmissions" ? (
          <div className="inventory-pending-wrap">
            {pendingLoading ? (
              <div className="app-loading-card" style={{ padding: "2rem", textAlign: "center" }}>
                <span className="app-spinner" aria-hidden="true" /> Loading submissions...
              </div>
            ) : pendingError ? (
              <p style={{ color: "var(--text-soft)", padding: "1rem" }}>{pendingError}</p>
            ) : pendingSubmissions.length === 0 ? (
              <p style={{ color: "var(--text-soft)", padding: "1rem" }}>No pending submissions.</p>
            ) : (
              <>
                {/* Merged summary + Approve All */}
                <div className="inventory-pending-summary">
                  <div className="inventory-pending-summary-header">
                    <h4 className="inventory-pending-summary-title">All Pending Items</h4>
                    <button
                      type="button"
                      className="button button-primary button-sm"
                      disabled={approvingAll}
                      onClick={async () => {
                        setApprovingAll(true);
                        setApproveAllError("");
                        const toApprove = [...pendingSubmissions];
                        const failed: string[] = [];
                        for (const sub of toApprove) {
                          try {
                            let entries: PendingEntry[] = [];
                            try { entries = JSON.parse(sub.entriesJson); } catch { entries = []; }
                            const subEdits = editedQtys[sub.id] ?? {};
                            const effectiveEntries = entries.map((e, i) => ({
                              ...e,
                              quantityUsed: subEdits[i] !== undefined ? Number(subEdits[i]) || e.quantityUsed : e.quantityUsed,
                            }));
                            const anyEdited = Object.keys(subEdits).length > 0;
                            await approveUsageSubmission(sub.id, anyEdited ? effectiveEntries : undefined);
                            setPendingSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
                            setEditedQtys((prev) => { const next = { ...prev }; delete next[sub.id]; return next; });
                          } catch {
                            failed.push(sub.submittedByName || sub.submittedByEmail);
                          }
                        }
                        setApprovingAll(false);
                        if (failed.length > 0) {
                          setApproveAllError(`Failed to approve: ${failed.join(", ")}`);
                        }
                        await reloadAndPruneZeroRows();
                      }}
                    >
                      {approvingAll ? "Approving..." : "Approve All"}
                    </button>
                  </div>
                  <table className="inventory-pending-entries">
                    <tbody>
                      {mergedPendingItems.map(({ entry, totalQty }) => (
                        <tr key={entry.itemId}>
                          <td className="inventory-pending-entry-name">{buildPendingEntryLabel(entry)}</td>
                          <td className="inventory-pending-entry-qty" style={{ color: "var(--text-soft)", fontWeight: 600 }}>×{totalQty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {approveAllError ? <p className="inventory-pending-error">{approveAllError}</p> : null}
                </div>

                {/* Individual submissions for delete (or qty edits before approve all) */}
                <h4 className="inventory-pending-summary-title" style={{ marginTop: "1.25rem" }}>Submissions</h4>
                {pendingSubmissions.map((sub) => {
                  let entries: PendingEntry[] = [];
                  try { entries = JSON.parse(sub.entriesJson); } catch { entries = []; }
                  const subEdits = editedQtys[sub.id] ?? {};
                  const effectiveEntries: PendingEntry[] = entries.map((e, i) => ({
                    ...e,
                    quantityUsed: subEdits[i] !== undefined ? Number(subEdits[i]) || e.quantityUsed : e.quantityUsed,
                  }));
                  return (
                    <PendingSubmissionCard
                      key={sub.id}
                      submission={sub}
                      entries={effectiveEntries}
                      editedQtys={subEdits}
                      buildLabel={buildPendingEntryLabel}
                      onEditQty={(entryIndex, value) =>
                        setEditedQtys((prev) => ({
                          ...prev,
                          [sub.id]: { ...prev[sub.id], [entryIndex]: value },
                        }))
                      }
                      onApprove={async () => {
                        const anyEdited = Object.keys(subEdits).length > 0;
                        await approveUsageSubmission(sub.id, anyEdited ? effectiveEntries : undefined);
                        setPendingSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
                        setEditedQtys((prev) => { const next = { ...prev }; delete next[sub.id]; return next; });
                        await reloadAndPruneZeroRows();
                      }}
                      onDelete={async () => {
                        await deleteUsageSubmission(sub.id);
                        setPendingSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
                        setEditedQtys((prev) => { const next = { ...prev }; delete next[sub.id]; return next; });
                      }}
                    />
                  );
                })}
              </>
            )}
          </div>
        ) : isMobile ? (
        <div className="inventory-cards-wrap">
          {canEditTable && (
            <div className="inventory-cards-toolbar">
              <button
                type="button"
                className={`button button-ghost button-sm${selectMode ? " active" : ""}`}
                onClick={() => {
                  setSelectMode((prev) => {
                    if (!prev) { setAddingLocation(false); setNewLocationName(""); setAddLocationError(null); }
                    return !prev;
                  });
                  if (selectMode) setSelectedRowIds(new Set());
                }}
              >
                {selectMode ? `Cancel (${selectedRowIds.size})` : "Select"}
              </button>
              {selectMode && selectedRowIds.size > 0 && rows.length > 1 && (
                <>
                  {showLocationPills && locationOptions.length > 1 ? (
                    <details className="inventory-move-menu">
                      <summary className="button button-secondary button-sm">
                        Move to… <span className="inventory-move-count">{selectedRowIds.size}</span>
                      </summary>
                      <div className="inventory-move-panel">
                        {locationOptions
                          .filter((loc) => loc !== effectiveLocationFilter)
                          .map((loc) => (
                            <button
                              key={loc}
                              type="button"
                              className="inventory-move-option"
                              onClick={(e) => {
                                onMoveSelectedRows(loc);
                                const details = e.currentTarget.closest("details");
                                details?.removeAttribute("open");
                              }}
                            >
                              {loc}
                            </button>
                          ))}
                      </div>
                    </details>
                  ) : null}
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={onRequestDeleteSelectedRows}
                  >
                    Delete ({selectedRowIds.size})
                  </button>
                </>
              )}
            </div>
          )}
          {filteredRows.length === 0 ? (
            <p className="inventory-cards-empty">No items match your filters.</p>
          ) : (
            paginatedRows.map(({ row }) => {
              const isExpanded = expandedCardId === row.id;
              const isSelected = selectedRowIds.has(row.id);

              /* Dynamic card summary: use first visible column as title,
                 show up to 4 additional columns as meta badges */
              const nameCol = visibleColumns.find((c) => c.key === "itemName");
              const cardTitle = nameCol
                ? String(row.values[nameCol.key] ?? "").trim() || "Untitled"
                : visibleColumns.length > 0
                  ? String(row.values[visibleColumns[0].key] ?? "").trim() || "Untitled"
                  : "Untitled";

              /* Collapsed card only shows quantity and expiration date */
              const previewCols = visibleColumns
                .filter((c) => c.key === "quantity" || c.key === "expirationDate");

              /* Expiration status for card border styling */
              const expValue = row.values.expirationDate;
              const daysUntil = getDaysUntilExpiration(expValue);
              let expClass = "";
              if (daysUntil !== null) {
                if (daysUntil < 0) expClass = "inventory-card-exp--expired";
                else if (daysUntil <= 30) expClass = "inventory-card-exp--soon";
                else if (daysUntil <= 60) expClass = "inventory-card-exp--warning";
              }

              /* Low stock check */
              const qtyNum = Number(row.values.quantity);
              const minQtyNum = Number(row.values.minQuantity);
              const isLowStock =
                Number.isFinite(qtyNum) &&
                Number.isFinite(minQtyNum) &&
                minQtyNum > 0 &&
                qtyNum < minQtyNum;

              return (
                <div
                  key={row.id}
                  className={`inventory-card${isExpanded ? " inventory-card--expanded" : ""}${isSelected ? " inventory-card--selected" : ""}`}
                  onClick={() => {
                    if (selectMode) {
                      onToggleRowSelection(row.id);
                    } else {
                      setExpandedCardId(isExpanded ? null : row.id);
                      setSelectedRowId(row.id);
                    }
                  }}
                >
                  <div className="inventory-card-summary">
                    {selectMode && (
                      <input
                        type="checkbox"
                        className="inventory-select-checkbox"
                        checked={isSelected}
                        onChange={() => onToggleRowSelection(row.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    <div className="inventory-card-info">
                      <span className="inventory-card-name">{cardTitle}</span>
                      <div className="inventory-card-meta">
                        {previewCols.map((col) => {
                          const val = row.values[col.key];
                          const displayText = getReadOnlyCellText(col, val);
                          if (!displayText.trim()) return null;

                          /* Special styling for quantity (low stock) */
                          if (col.key === "quantity") {
                            const minQtyVal = row.values.minQuantity;
                            const minLabel = minQtyVal !== null && minQtyVal !== undefined && String(minQtyVal).trim() !== "" && Number(minQtyVal) > 0
                              ? ` / ${minQtyVal}`
                              : "";
                            return (
                              <span key={col.id} className={`inventory-card-badge${isLowStock ? " inventory-card-badge--low" : ""}`}>
                                {col.label}: {displayText}{minLabel}
                              </span>
                            );
                          }

                          /* Expiration date as badge with exp color styling */
                          if (col.key === "expirationDate") {
                            if (daysUntil === null) return null;
                            return (
                              <span key={col.id} className={`inventory-card-badge ${expClass}`}>
                                Exp: {displayText}
                              </span>
                            );
                          }

                          /* Link column – skip from preview (item name already shown as card title) */
                          if (col.type === "link") {
                            return null;
                          }

                          /* Generic column badge */
                          return (
                            <span key={col.id} className="inventory-card-tag">
                              {col.label}: {displayText}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <span className="inventory-card-chevron" aria-hidden="true">
                      {isExpanded ? "\u25B2" : "\u25BC"}
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="inventory-card-detail" onClick={(e) => e.stopPropagation()}>
                      {visibleColumns.map((column) => (
                        <div key={column.id} className="inventory-card-field">
                          <label className="inventory-card-field-label">{column.label}</label>
                          {!canEditTable ? (
                            column.type === "link" ? (
                              (() => {
                                const normalizedLink = normalizeLinkValue(String(row.values[column.key] ?? ""));
                                const itemName = String(row.values.itemName ?? "").trim();
                                return normalizedLink ? (
                                  <a className="inventory-card-field-link" href={normalizedLink} target="_blank" rel="noreferrer">
                                    {itemName || normalizedLink}
                                  </a>
                                ) : (
                                  <span className="inventory-card-field-value">--</span>
                                );
                              })()
                            ) : (
                              <span className="inventory-card-field-value">
                                {getReadOnlyCellText(column, row.values[column.key]) || "--"}
                              </span>
                            )
                          ) : column.type === "text" ? (
                            <textarea
                              className="inventory-card-input"
                              value={String(row.values[column.key] ?? "")}
                              rows={2}
                              onFocus={() => {
                                beginCellEditSession(row.id, column.key);
                              }}
                              onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
                              onBlur={endCellEditSession}
                            />
                          ) : column.type === "number" ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              className="inventory-card-input"
                              value={String(row.values[column.key] ?? "")}
                              onFocus={(e) => {
                                e.currentTarget.select();
                                beginCellEditSession(row.id, column.key);
                              }}
                              onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
                              onBlur={endCellEditSession}
                            />
                          ) : column.type === "date" ? (
                            <div className="inventory-card-date-wrap">
                              <input
                                type="date"
                                className="inventory-card-input"
                                value={toDateInputValue(row.values[column.key])}
                                onFocus={() => {
                                  beginCellEditSession(row.id, column.key);
                                }}
                                onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
                                onBlur={endCellEditSession}
                              />
                              {toDateInputValue(row.values[column.key]) && (
                                <button
                                  type="button"
                                  className="inventory-date-clear"
                                  onClick={() => onCellChange(row.id, column, "")}
                                  aria-label="Clear date"
                                >
                                  &times;
                                </button>
                              )}
                            </div>
                          ) : column.type === "link" ? (
                            <input
                              type="url"
                              className="inventory-card-input"
                              value={String(row.values[column.key] ?? "")}
                              placeholder="Paste link"
                              onFocus={() => {
                                beginCellEditSession(row.id, column.key);
                              }}
                              onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
                              onBlur={(e) => {
                                const normalized = normalizeLinkValue(e.target.value);
                                if (normalized !== e.target.value) {
                                  onCellChange(row.id, column, normalized);
                                }
                                endCellEditSession();
                              }}
                            />
                          ) : (
                            <input
                              type="text"
                              className="inventory-card-input"
                              value={String(row.values[column.key] ?? "")}
                              onFocus={() => {
                                beginCellEditSession(row.id, column.key);
                              }}
                              onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
                              onBlur={endCellEditSession}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        ) : (
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
                  column.key === "category" ? (
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
                        className={`inventory-sort-trigger${sortState?.key === column.key ? " inventory-sort-active" : ""}`}
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
              {paginatedRows.map(({ row, index: rowIndex }) => (
                <tr
                  key={row.id}
                  data-row-id={row.id}
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
                                autoFocus={isEditingLinkCell(row.id, column.key)}
                                onFocus={() => {
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

                          const linkLabel = String(row.values.itemName ?? "").trim() || normalizedLink;

                          if (canEditTable) {
                            return (
                              <div className="inventory-link-field-editable">
                                <span
                                  className="inventory-link-field-text"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedRowId(row.id);
                                    setEditingLinkCell({ rowId: row.id, columnKey: column.key });
                                  }}
                                  title="Click to edit link"
                                >
                                  {linkLabel}
                                </span>
                                <a
                                  className="inventory-link-field-open"
                                  href={normalizedLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(event) => event.stopPropagation()}
                                  title="Open link"
                                >
                                  &#x2197;
                                </a>
                              </div>
                            );
                          }

                          return (
                            <a
                              className="inventory-link-field"
                              href={normalizedLink}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {linkLabel}
                            </a>
                          );
                        })()
                      ) : column.type === "text" ? (
                        <textarea
                          value={String(row.values[column.key] ?? "")}
                          onFocus={() => {
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
                          type="text"
                          inputMode={column.type === "number" ? "numeric" : undefined}
                          pattern={column.type === "number" ? "[0-9]*" : undefined}
                          value={String(row.values[column.key] ?? "")}
                          onFocus={(event) => {
                            if (column.type === "number") {
                              event.currentTarget.select();
                              const el = event.currentTarget;
                              const cancel = (e: Event) => { e.preventDefault(); el.removeEventListener("mouseup", cancel); };
                              el.addEventListener("mouseup", cancel, { once: true });
                            }
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
        )}
        {activeTab !== "pendingSubmissions" && totalPages > 1 ? (
          <div className="inventory-pagination">
            <span className="inventory-pagination-info">
              {pageStart + 1}–{Math.min(pageStart + ROWS_PER_PAGE, filteredRows.length)} of {filteredRows.length}
            </span>
            <div className="inventory-pagination-controls">
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
              >
                ← Prev
              </button>
              {totalPages <= 10 ? (
                <span className="inventory-pagination-pages">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                    <button
                      key={page}
                      type="button"
                      className={`inventory-pagination-page${safePage === page ? " active" : ""}`}
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="inventory-pagination-current">Page {safePage} of {totalPages}</span>
              )}
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
              >
                Next →
              </button>
            </div>
          </div>
        ) : null}
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
      {showTemplateDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Download template">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Customize Template Columns</h3>
            <p className="inventory-import-subtitle">
              Choose which columns to include in the download.
            </p>
            <div className="inventory-import-list">
              {columns.map((col) => {
                const selected = templateSelectedIds?.has(col.id) ?? true;
                return (
                  <label key={col.id} className="inventory-import-item">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        setTemplateSelectedIds((prev) => {
                          const next = new Set(prev ?? columns.map((c) => c.id));
                          if (next.has(col.id)) next.delete(col.id);
                          else next.add(col.id);
                          return next;
                        })
                      }
                    />
                    <span>
                      {col.label}
                      <span style={{ opacity: 0.5, marginLeft: "0.5rem", fontSize: "0.75em" }}>
                        {col.type}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="inventory-import-actions">
              <button
                className="button button-secondary"
                onClick={() => setShowTemplateDialog(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={!templateSelectedIds || templateSelectedIds.size === 0}
                onClick={() => {
                  const selectedCols = columns.filter(
                    (c) => templateSelectedIds?.has(c.id) ?? true,
                  );
                  void generateAndDownloadInventoryTemplate(selectedCols).then(() =>
                    setShowTemplateDialog(false),
                  );
                }}
              >
                Download
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteRows && selectedRowIds.size > 0 ? (
        <div className="settings-destructive-overlay">
          <div className="settings-destructive-backdrop" onClick={() => setPendingDeleteRows(false)} />
          <div className="settings-destructive-sheet" role="dialog" aria-label="Confirm delete">
            <div className="settings-destructive-sheet-body">
              <p className="settings-destructive-sheet-title">Delete Items</p>
              <p className="settings-destructive-sheet-msg">
                Delete {selectedRowIds.size} selected {selectedRowIds.size === 1 ? "item" : "items"}? This cannot be undone after saving.
              </p>
            </div>
            <div className="settings-destructive-sheet-actions">
              <button type="button" onClick={() => setPendingDeleteRows(false)}>Cancel</button>
              <button type="button" onClick={onConfirmDeleteSelectedRows}>Delete</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
