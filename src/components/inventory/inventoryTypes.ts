// Re-export types from inventoryApi that are used throughout the inventory module
export type {
  ColumnVisibilityOverrides,
  InventoryColumn,
  InventoryRow,
  PendingEntry,
  PendingSubmission,
} from "../../lib/inventoryApi";

export type InventoryFilter = "all" | "expired" | "exp30" | "exp60" | "lowStock";
export type ActiveTab = InventoryFilter | "pendingSubmissions";
export type SortDirection = "asc" | "desc";

export interface InventoryPageProps {
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

export type CsvImportDialogState = {
  csvText: string;
  headers: string[];
  selectedHeaders: string[];
};

export type PasteImportDialogState = {
  rawText: string;
};

export type InventorySnapshot = {
  rows: import("../../lib/inventoryApi").InventoryRow[];
  dirtyRowIds: Set<string>;
  deletedRowIds: Set<string>;
  selectedRowIds: Set<string>;
  selectedRowId: string | null;
};

export type PendingSubmissionCardProps = {
  submission: import("../../lib/inventoryApi").PendingSubmission;
  entries: import("../../lib/inventoryApi").PendingEntry[];
  editedQtys: Record<number, string>;
  buildLabel: (entry: import("../../lib/inventoryApi").PendingEntry) => string;
  onEditQty: (entryIndex: number, value: string) => void;
  onApprove: () => Promise<void>;
  onDelete: () => Promise<void>;
};

export type MergedEntry = {
  entry: import("../../lib/inventoryApi").PendingEntry;
  origIndex: number;
  totalQty: number;
};

export const NUMBER_COLUMN_KEYS = new Set(["quantity", "minQuantity"]);
export const AUTOSAVE_DELAY_MS = 3000;
export const ROWS_PER_PAGE = 50;
export const UNDO_HISTORY_LIMIT = 80;
export const COLUMN_WIDTHS_STORAGE_KEY_PREFIX = "wickops.inventory.columnWidths:";
export const DEFAULT_PROVISIONING_RETRY_MS = 2000;
