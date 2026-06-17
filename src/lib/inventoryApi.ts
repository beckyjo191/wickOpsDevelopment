import { authFetch, getCachedAuthToken } from "./authFetch";
import type { AppModuleKey } from "./moduleRegistry";
export type { AppModuleKey };

const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVENTORY_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVENTORY_API_BASE_URL);
const CORE_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

type ApiColumn = {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "link" | "boolean";
  isCore: boolean;
  isRequired: boolean;
  isVisible: boolean;
  isEditable: boolean;
  /** Whether the column shows a "filter by value" header dropdown. Replaces
   *  the previous hardcoded `column.key === "category"` branch. Optional in
   *  the wire shape because pre-migration rows lack the field. */
  isGroupable?: boolean;
  /** Locations where this custom column renders. Ignored for core columns
   *  (they render everywhere). Empty array = dormant. Optional in the wire
   *  shape because core columns omit the field. */
  attachedLocationIds?: string[];
  sortOrder: number;
};

type ApiItem = {
  id: string;
  position: number;
  /** Structural location pointer. Required after migration v1. */
  locationId?: string;
  valuesJson: string;
  createdAt: string;
  updatedAtCustom: string;
};

/** First-class location entity. Replaces the old `registeredLocations: string[]` bootstrap field. */
export type InventoryLocation = {
  id: string;
  organizationId: string;
  module: "inventory";
  kind: "location";
  name: string;
  sortOrder: number;
  createdAt: string;
};

type InventoryProvisioningPayload = {
  error?: string;
  code?: string;
  retryAfterMs?: number;
};

export type InventoryAccess = {
  userId: string;
  organizationId: string;
  role: string;
  allowedModules?: string[];
  canEditInventory: boolean;
  canManageColumns: boolean;
};

// AppModuleKey is now the canonical type from moduleRegistry.
// The re-export above keeps this file as the import point for existing consumers.

export type InventoryColumn = ApiColumn;
export type ColumnVisibilityOverrides = Record<string, boolean>;

export type ModuleAccessUser = {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  allowedModules: AppModuleKey[];
};

export type InventoryRow = {
  id: string;
  position: number;
  /** Structural location pointer. Required for new rows post-migration. */
  locationId?: string;
  values: Record<string, string | number | boolean | null>;
  createdAt?: string;
};

export type InventoryUsageEntryInput = {
  itemId: string;
  quantityUsed: number;
  notes?: string;
};

export class InventoryProvisioningError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "InventoryProvisioningError";
    this.retryAfterMs = retryAfterMs;
  }
}

export const isInventoryProvisioningError = (
  value: unknown,
): value is InventoryProvisioningError => value instanceof InventoryProvisioningError;

/**
 * Thrown when the server rejects a delete because the item still has stock on
 * hand. Callers should prompt the user to log usage or retire stock first.
 */
export class DeleteBlockedError extends Error {
  readonly protectedRows: Array<{ id: string; itemName: string }>;

  constructor(message: string, protectedRows: Array<{ id: string; itemName: string }>) {
    super(message);
    this.name = "DeleteBlockedError";
    this.protectedRows = protectedRows;
  }
}

export const isDeleteBlockedError = (value: unknown): value is DeleteBlockedError =>
  value instanceof DeleteBlockedError;

const requireBaseUrl = () => {
  if (!INVENTORY_API_BASE_URL) {
    throw new Error("Missing VITE_INVENTORY_API_BASE_URL");
  }
  return INVENTORY_API_BASE_URL;
};

const getApiErrorMessage = async (res: Response, fallback: string): Promise<string> => {
  const text = (await res.text()).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Ignore JSON parse errors and return raw text.
  }
  return text;
};

const parseValues = (valuesJson: string): Record<string, string | number | boolean | null> => {
  try {
    const parsed = JSON.parse(valuesJson ?? "{}");
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
};

export const loadInventoryBootstrap = async (): Promise<{
  access: InventoryAccess;
  columns: InventoryColumn[];
  items: InventoryRow[];
  locations: InventoryLocation[];
  registeredVendors: string[];
  /** 1g: per-(item, vendor) pricing rows for the org. Frontend indexes
   *  these into a Map for fast reads in the item-detail modal + Shop tab. */
  vendorPricing: ItemVendorPricingEntry[];
  /** 1h.2: per-org curated unit list. Drives unit pickers across the app
   *  so EMS/pantry/fire users don't see units that don't apply. Empty
   *  array fallback uses the full KNOWN_UNITS list. */
  allowedUnits: string[];
  /** 1h.7: org-wide gate. When false (default), i modal hides
   *  Amount/Unit and the dual-axis Pack form is suppressed — basic
   *  EMS-style flow. Pantry/restaurant orgs flip this on in Settings to
   *  unlock weight/volume capture and $/lb price-trend math. */
  tracksUnits: boolean;
  columnVisibilityOverrides: ColumnVisibilityOverrides;
  nextToken: string | null;
  /** Set when the server just ran a schema migration; clients render a toast. */
  migrationNotice: { message: string } | null;
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/bootstrap`);
  if (res.status === 202) {
    let payload: InventoryProvisioningPayload | null = null;
    try {
      payload = (await res.json()) as InventoryProvisioningPayload;
    } catch {
      payload = null;
    }
    if (payload?.code === "INVENTORY_STORAGE_PROVISIONING") {
      throw new InventoryProvisioningError(
        payload.error ?? "Inventory storage is still provisioning",
        Number(payload.retryAfterMs ?? 2000),
      );
    }
  }
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to load inventory bootstrap");
  }
  const data = await res.json();
  return {
    access: data.access as InventoryAccess,
    columns: (data.columns ?? []) as InventoryColumn[],
    items: ((data.items ?? []) as ApiItem[])
      .map((item) => ({
        id: item.id,
        position: Number(item.position ?? 0),
        locationId: item.locationId,
        values: parseValues(item.valuesJson),
        createdAt: item.createdAt,
      }))
      .sort((a, b) => a.position - b.position),
    locations: Array.isArray(data.locations)
      ? (data.locations as InventoryLocation[]).filter((l) => l && typeof l.id === "string")
      : [],
    registeredVendors: Array.isArray(data.registeredVendors)
      ? (data.registeredVendors as string[]).filter((v: string) => typeof v === "string" && v.length > 0)
      : [],
    vendorPricing: Array.isArray(data.vendorPricing)
      ? (data.vendorPricing as ItemVendorPricingEntry[]).filter((e) => e && typeof e.id === "string")
      : [],
    allowedUnits: Array.isArray(data.allowedUnits)
      ? (data.allowedUnits as string[]).filter((u): u is string => typeof u === "string" && u.length > 0)
      : [],
    // Default false so legacy bootstrap responses (and 202 retry path)
    // stay in the EMS-style flow until users explicitly opt in.
    tracksUnits: typeof data.tracksUnits === "boolean" ? data.tracksUnits : false,
    columnVisibilityOverrides: (data.columnVisibilityOverrides ?? {}) as ColumnVisibilityOverrides,
    nextToken: data.nextToken ?? null,
    migrationNotice:
      data.migrationNotice && typeof data.migrationNotice.message === "string"
        ? { message: String(data.migrationNotice.message) }
        : null,
  };
};

/** Fetch a page of inventory items (used to load remaining pages after bootstrap). */
export const loadInventoryItems = async (
  nextToken: string,
  limit = 250,
): Promise<{ items: InventoryRow[]; nextToken: string | null }> => {
  const base = requireBaseUrl();
  const params = new URLSearchParams({ nextToken, limit: String(limit) });
  const res = await authFetch(`${base}/inventory/items?${params}`);
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to load inventory items");
  }
  const data = await res.json();
  return {
    items: ((data.items ?? []) as ApiItem[])
      .map((item) => ({
        id: item.id,
        position: Number(item.position ?? 0),
        locationId: item.locationId,
        values: parseValues(item.valuesJson),
        createdAt: item.createdAt,
      }))
      .sort((a, b) => a.position - b.position),
    nextToken: data.nextToken ?? null,
  };
};

export const saveUserColumnVisibility = async (
  overrides: ColumnVisibilityOverrides,
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/column-visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to save column visibility preferences");
  }
};

export type RestockMetadata = {
  source: "supplier" | "donation" | "transfer" | "correction" | "other";
  qtyDelta: number;
  unitCost?: number;
  /** Vendor/supplier name — drives phase 2 "spend by vendor" analytics. */
  vendor?: string;
  reorderLink?: string;
  location?: string;
};

export type RetireReason = "expired" | "damaged" | "lost" | "recalled" | "discontinued";

/** Human-friendly labels for each RetireReason. Keep in sync with backend
 *  types.ts. Used by the Remove dialog and any analytics surface that renders
 *  reason names. */
export const RETIRE_REASON_LABEL: Record<RetireReason, string> = {
  expired: "Expired",
  damaged: "Damaged or broken",
  lost: "Lost — can't find it",
  recalled: "Recalled by manufacturer",
  discontinued: "We don't carry this anymore",
};

export type RetireMetadata = {
  reason: RetireReason;
  qty: number;
  notes?: string;
};

export const saveInventoryItems = async (
  rows: InventoryRow[],
  deletedRowIds: string[] = [],
  options?: {
    restockMetadata?: Record<string, RestockMetadata>;
    retireMetadata?: Record<string, RetireMetadata>;
  },
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/items/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: rows.map((row, index) => ({
        id: row.id,
        position: index,
        locationId: row.locationId,
        values: row.values,
        createdAt: row.createdAt,
      })),
      deletedRowIds,
      ...(options?.restockMetadata ? { restockMetadata: options.restockMetadata } : {}),
      ...(options?.retireMetadata ? { retireMetadata: options.retireMetadata } : {}),
    }),
  });

  if (!res.ok) {
    if (res.status === 409) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as {
          code?: string;
          error?: string;
          protectedRows?: Array<{ id: string; itemName: string }>;
        };
        if (parsed.code === "DELETE_BLOCKED_HAS_STOCK" && Array.isArray(parsed.protectedRows)) {
          throw new DeleteBlockedError(
            parsed.error ?? "Some items still have stock and can't be deleted.",
            parsed.protectedRows,
          );
        }
        throw new Error(parsed.error ?? text ?? "Failed to save inventory");
      } catch (err) {
        if (err instanceof DeleteBlockedError) throw err;
        throw new Error(text || "Failed to save inventory");
      }
    }
    throw new Error((await res.text()) || "Failed to save inventory");
  }
};

/** Synchronous, fire-and-forget save using `keepalive` + cached auth token.
 *  Designed for page unload / visibilitychange where we cannot await promises.
 *  Falls back silently if no cached token is available. */
export const saveInventoryItemsSync = (
  rows: InventoryRow[],
  deletedRowIds: string[] = [],
): void => {
  const token = getCachedAuthToken();
  if (!token) return;
  const base = normalizeBaseUrl(import.meta.env.VITE_INVENTORY_API_BASE_URL);
  if (!base) return;
  try {
    fetch(`${base}/inventory/items/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        rows: rows.map((row, index) => ({
          id: row.id,
          position: index,
          locationId: row.locationId,
          values: row.values,
          createdAt: row.createdAt,
        })),
        deletedRowIds,
      }),
      keepalive: true,
    });
  } catch {
    // Best-effort — page is unloading
  }
};

/**
 * After usage approval decrements quantities, prune zero-qty expiration rows
 * where the same item (name+location) still has non-zero rows.
 * If all rows for an item are zero, keep one.
 */
export const pruneZeroQtyRows = async (
  rows: InventoryRow[],
  columns: InventoryColumn[],
  locationColumnKey?: string,
): Promise<void> => {
  const expCol = columns.find((c) => c.key === "expirationDate");
  if (!expCol) return;

  const allGroups = new Map<string, InventoryRow[]>();
  for (const r of rows) {
    const name = String(r.values.itemName ?? "").trim();
    const loc = locationColumnKey ? String(r.values[locationColumnKey] ?? "").trim() : "";
    const key = `${name}||${loc}`;
    const group = allGroups.get(key) ?? [];
    group.push(r);
    allGroups.set(key, group);
  }

  const idsToDelete: string[] = [];
  for (const group of allGroups.values()) {
    if (group.length < 2) continue;
    const nonZeroRows = group.filter((r) => Number(r.values.quantity ?? 0) !== 0);
    const zeroWithExp = group.filter((r) => {
      if (Number(r.values.quantity ?? 0) !== 0) return false;
      const hasExp =
        r.values[expCol.key] != null &&
        String(r.values[expCol.key]).trim() !== "";
      return hasExp;
    });
    if (zeroWithExp.length === 0) continue;
    if (nonZeroRows.length === 0) {
      for (let i = 1; i < zeroWithExp.length; i++) {
        idsToDelete.push(zeroWithExp[i].id);
      }
    } else {
      for (const r of zeroWithExp) {
        idsToDelete.push(r.id);
      }
    }
  }

  if (idsToDelete.length > 0) {
    await saveInventoryItems([], idsToDelete);
  }
};

export const submitInventoryUsage = async (
  entries: InventoryUsageEntryInput[],
): Promise<{
  ok: boolean;
  submissionId: string;
  entryCount: number;
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/usage/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Usage submission failed."));
  }
  const data = await res.json();
  return {
    ok: !!data?.ok,
    submissionId: String(data?.submissionId ?? ""),
    entryCount: Number(data?.entryCount ?? 0),
  };
};

/**
 * Reverse a previously logged usage event. The original audit event keeps its
 * place in the feed but is marked as undone (`details.undone === true`); the
 * decremented quantity is added back to the item.
 */
export const undoUsageEvent = async (
  eventId: string,
  itemId: string,
): Promise<{ ok: boolean }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/usage/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, itemId }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to undo usage event."));
  }
  const data = await res.json();
  return { ok: !!data?.ok };
};

/**
 * Reverse a previous ITEM_RETIRE: clears the retire markers on the row and
 * additively restores the retired quantity.
 */
export const undoRetireEvent = async (
  eventId: string,
  itemId: string,
): Promise<{ ok: boolean }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/items/undo-retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, itemId }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to undo retire event."));
  }
  const data = await res.json();
  return { ok: !!data?.ok };
};

/**
 * Reverse a previous COLUMN_DELETE: recreates the column row from the snapshot
 * stamped on the original event. Per-row values for that column were never
 * scrubbed, so the data reappears once the column metadata is back.
 */
export const undoColumnDeleteEvent = async (
  eventId: string,
): Promise<{ ok: boolean }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to restore column."));
  }
  const data = await res.json();
  return { ok: !!data?.column };
};

export const importInventoryCsv = async (
  csvText: string,
  locationId: string,
  selectedHeaders?: string[],
): Promise<{
  ok: boolean;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  duplicateSkippedCount: number;
  importedRows: number;
  createdColumns: Array<{ id: string; key: string; label: string }>;
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/import-csv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      csvText,
      locationId,
      selectedHeaders,
    }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Import failed. Please check your file and try again."));
  }
  return await res.json();
};

const detectDelimiter = (text: string): string => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  if (tabCount >= commaCount && tabCount >= semicolonCount && tabCount > 0) return "\t";
  if (semicolonCount > commaCount && semicolonCount > 0) return ";";
  return ",";
};

export const extractCsvHeaders = (csvText: string): string[] => {
  const delimiter = detectDelimiter(csvText);
  const headers: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      headers.push(current.trim());
      current = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      headers.push(current.trim());
      return headers.filter((header) => header.length > 0);
    }

    current += char;
  }

  if (current.trim().length > 0) {
    headers.push(current.trim());
  }

  return headers.filter((header) => header.length > 0);
};

const isSpreadsheetFile = (file: File): boolean => {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    file.type.includes("spreadsheetml") ||
    file.type.includes("ms-excel")
  );
};

export const convertImportFileToCsv = async (file: File): Promise<string> => {
  if (!isSpreadsheetFile(file)) {
    return await file.text();
  }

  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("Spreadsheet is empty.");
  }
  const sheet = workbook.Sheets[firstSheetName];
  const csvText = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  if (!csvText.trim()) {
    throw new Error("Spreadsheet does not contain importable data.");
  }
  return csvText;
};

export const createInventoryColumn = async (input: {
  label: string;
  /** Defaults to "text" server-side. */
  type?: "text" | "number" | "date" | "link" | "boolean";
  /** Whether the column shows the header dropdown filter. */
  isGroupable?: boolean;
  /** Locations where the column should render. Omit (or pass empty) to fall
   *  back to the server default of "attach to every existing location". */
  attachedLocationIds?: string[];
}): Promise<InventoryColumn> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to create column");
  }
  const data = await res.json();
  return data.column as InventoryColumn;
};

export const deleteInventoryColumn = async (columnId: string): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/${encodeURIComponent(columnId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to delete column");
  }
};

export const updateInventoryColumnVisibility = async (
  columnId: string,
  isVisible: boolean,
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/${encodeURIComponent(columnId)}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isVisible }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to update column visibility");
  }
};

export const updateInventoryColumnLabel = async (
  columnId: string,
  label: string,
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/${encodeURIComponent(columnId)}/label`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to update column label");
  }
};

export const updateInventoryColumnType = async (
  columnId: string,
  type: "text" | "number" | "date" | "link" | "boolean",
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/${encodeURIComponent(columnId)}/type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to update column type");
  }
};

export const reorderInventoryColumns = async (
  columnOrder: string[],
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/columns/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnOrder }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to reorder columns");
  }
};

export const listModuleAccessUsers = async (): Promise<{
  modules: AppModuleKey[];
  users: ModuleAccessUser[];
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/module-access/users`);
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to load module access users");
  }
  const data = await res.json();
  return {
    modules: (Array.isArray(data.modules) ? data.modules : []) as AppModuleKey[],
    users: (Array.isArray(data.users) ? data.users : []) as ModuleAccessUser[],
  };
};

export const updateUserModuleAccess = async (
  userId: string,
  allowedModules: AppModuleKey[],
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/module-access/users/${encodeURIComponent(userId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowedModules }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to update module access"));
  }
};

export const revokeUserAccess = async (
  userId: string,
): Promise<{ seatsUsed: number }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/module-access/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to revoke user access");
  }
  return res.json() as Promise<{ seatsUsed: number }>;
};

export const updateCurrentUserDisplayName = async (displayName: string): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/profile/display-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to update display name");
  }
};

export const syncCurrentUserEmail = async (): Promise<{ email: string }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/profile/email/sync`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to sync email");
  }
  const data = await res.json();
  return {
    email: String(data?.email ?? ""),
  };
};

// ─── Org Module Management ────────────────────────────────────────────────────

export type OrgModulesState = {
  plan: string;
  orgAvailableModules: AppModuleKey[];
  orgEnabledModules: AppModuleKey[];
};

/** Fetch the org's plan and module activation state */
export const getOrgModules = async (): Promise<OrgModulesState> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/org-modules`);
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to load org modules");
  }
  const data = await res.json();
  return {
    plan: String(data.plan ?? ""),
    orgAvailableModules: (Array.isArray(data.orgAvailableModules)
      ? data.orgAvailableModules
      : []) as AppModuleKey[],
    orgEnabledModules: (Array.isArray(data.orgEnabledModules)
      ? data.orgEnabledModules
      : []) as AppModuleKey[],
  };
};

/** Org owner activates/deactivates modules. Returns the new enabled set. */
export const updateOrgModules = async (
  enabledModules: AppModuleKey[],
): Promise<AppModuleKey[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/org-modules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabledModules }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to update org modules");
  }
  const data = await res.json();
  return (Array.isArray(data.orgEnabledModules)
    ? data.orgEnabledModules
    : []) as AppModuleKey[];
};

// ─── Onboarding Templates ────────────────────────────────────────────────────

export type IndustryTemplateColumn = {
  label: string;
  type: "text" | "number" | "date" | "link" | "boolean";
};

export type IndustryTemplate = {
  id: string;
  name: string;
  description: string;
  columns: IndustryTemplateColumn[];
};

export const listIndustryTemplates = async (): Promise<IndustryTemplate[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/onboarding/templates`);
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to load industry templates");
  }
  const data = await res.json();
  return (Array.isArray(data.templates) ? data.templates : []) as IndustryTemplate[];
};

export const applyIndustryTemplate = async (
  templateId: string,
): Promise<{ addedColumns: Array<{ label: string; key: string }> }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/onboarding/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId }),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to apply template"));
  }
  const data = await res.json();
  return {
    addedColumns: Array.isArray(data.addedColumns) ? data.addedColumns : [],
  };
};

// ─── Alert Summary ────────────────────────────────────────────────────────────

export type LocationAlertBreakdown = {
  location: string;
  expiredCount: number;
  expiringSoonCount: number;
  lowStockCount: number;
};

export type InventoryAlertSummary = {
  expiredCount: number;
  expiringSoonCount: number;
  lowStockCount: number;
  byLocation?: LocationAlertBreakdown[];
};

export const fetchInventoryAlertSummary = async (): Promise<InventoryAlertSummary> => {
  try {
    const base = requireBaseUrl();
    const res = await authFetch(`${base}/inventory/alert-summary`);
    if (!res.ok) return { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 };
    const data = await res.json();
    const byLocation = Array.isArray(data.byLocation)
      ? data.byLocation.map((b: any) => ({
          location: String(b.location ?? ""),
          expiredCount: Number(b.expiredCount ?? 0),
          expiringSoonCount: Number(b.expiringSoonCount ?? 0),
          lowStockCount: Number(b.lowStockCount ?? 0),
        }))
      : undefined;
    return {
      expiredCount: Number(data.expiredCount ?? 0),
      expiringSoonCount: Number(data.expiringSoonCount ?? 0),
      lowStockCount: Number(data.lowStockCount ?? 0),
      byLocation,
    };
  } catch {
    return { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 };
  }
};

// ─── Location Registry (id-keyed post-restructure) ───────────────────────────

/** Try to extract a human-readable error from a JSON response body. */
const extractApiError = async (res: Response, fallback: string): Promise<string> => {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch { /* not JSON — fall through */ }
  return fallback;
};

export const listInventoryLocations = async (): Promise<InventoryLocation[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations`);
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to load locations"));
  const data = await res.json();
  return Array.isArray(data.locations) ? (data.locations as InventoryLocation[]) : [];
};

export const addInventoryLocation = async (name: string): Promise<{
  location: InventoryLocation;
  locations: InventoryLocation[];
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to add location"));
  const data = await res.json();
  return {
    location: data.location as InventoryLocation,
    locations: Array.isArray(data.locations) ? (data.locations as InventoryLocation[]) : [],
  };
};

export const renameInventoryLocation = async (
  id: string,
  newName: string,
): Promise<{ location: InventoryLocation; locations: InventoryLocation[] }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, newName }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to rename location"));
  const data = await res.json();
  return {
    location: data.location as InventoryLocation,
    locations: Array.isArray(data.locations) ? (data.locations as InventoryLocation[]) : [],
  };
};

/**
 * Returned by removeInventoryLocation when the server refuses because items
 * still live in the target. The frontend uses this shape to populate a
 * confirm dialog ("Move these N items first or pick another action").
 */
export class LocationNotEmptyError extends Error {
  readonly itemCount: number;
  constructor(message: string, itemCount: number) {
    super(message);
    this.name = "LocationNotEmptyError";
    this.itemCount = itemCount;
  }
}

export const isLocationNotEmptyError = (v: unknown): v is LocationNotEmptyError =>
  v instanceof LocationNotEmptyError;

export const removeInventoryLocation = async (id: string): Promise<InventoryLocation[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    if (res.status === 409) {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string; itemCount?: number };
        if (parsed.code === "LOCATION_NOT_EMPTY") {
          throw new LocationNotEmptyError(
            parsed.error ?? "Location still has items",
            Number(parsed.itemCount ?? 0),
          );
        }
        throw new Error(parsed.error ?? text ?? "Failed to remove location");
      } catch (err) {
        if (err instanceof LocationNotEmptyError) throw err;
        throw new Error(text || "Failed to remove location");
      }
    }
    throw new Error((await res.text()) || "Failed to remove location");
  }
  const data = await res.json();
  return Array.isArray(data.locations) ? (data.locations as InventoryLocation[]) : [];
};

/** Bulk structural location move. Emits one ITEM_MOVE audit event per row. */
export const moveInventoryItems = async (
  rowIds: string[],
  locationId: string,
): Promise<{ movedCount: number }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/items/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rowIds, locationId }),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to move items"));
  const data = await res.json();
  return { movedCount: Number(data.movedCount ?? 0) };
};

/**
 * Update the per-location attachments on a custom column. Setting an empty
 * array hides the column everywhere; setting all location ids attaches it
 * to all of them (matching pre-restructure org-wide behavior).
 */
export const updateInventoryColumnAttachments = async (
  columnId: string,
  attachedLocationIds: string[],
  isGroupable?: boolean,
): Promise<void> => {
  const base = requireBaseUrl();
  const body: Record<string, unknown> = { attachedLocationIds };
  if (typeof isGroupable === "boolean") body.isGroupable = isGroupable;
  const res = await authFetch(`${base}/inventory/columns/${encodeURIComponent(columnId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to update column attachments"));
  }
};

export const addInventoryVendor = async (name: string): Promise<string[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/vendors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to add vendor"));
  const data = await res.json();
  return Array.isArray(data.vendors) ? data.vendors : [];
};

export const renameInventoryVendor = async (oldName: string, newName: string): Promise<{ vendors: string[]; renamedCount: number }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/vendors/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to rename vendor"));
  const data = await res.json();
  return {
    vendors: Array.isArray(data.vendors) ? data.vendors : [],
    renamedCount: Number(data.renamedCount ?? 0),
  };
};

export const removeInventoryVendor = async (name: string): Promise<string[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/vendors`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.text()) || "Failed to remove vendor");
  const data = await res.json();
  return Array.isArray(data.vendors) ? data.vendors : [];
};

// ─── XLSX Template Generation ─────────────────────────────────────────────────

export const generateAndDownloadInventoryTemplate = async (
  columns: InventoryColumn[],
): Promise<void> => {
  const XLSX = await import("xlsx");

  const today = new Date();
  const nextYear = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  const nextYearStr = `${String(nextYear.getMonth() + 1).padStart(2, "0")}/${String(nextYear.getDate()).padStart(2, "0")}/${nextYear.getFullYear()}`;

  const sampleValues: Record<string, (string | number)[]> = {
    itemName: ["Example Item 1", "Example Item 2"],
    quantity: [10, 5],
    minQuantity: [3, 2],
    expirationDate: [nextYearStr, nextYearStr],
  };

  const headers = columns.map((c) => c.label);
  const row1: (string | number)[] = columns.map((col) => {
    if (col.key in sampleValues) return sampleValues[col.key]![0]!;
    if (col.type === "number") return 1;
    if (col.type === "boolean") return "Yes";
    if (col.type === "date") return nextYearStr;
    if (col.type === "link") return "https://example.com";
    return "Example";
  });
  const row2: (string | number)[] = columns.map((col) => {
    if (col.key in sampleValues) return sampleValues[col.key]![1]!;
    if (col.type === "number") return 1;
    if (col.type === "boolean") return "No";
    if (col.type === "date") return nextYearStr;
    if (col.type === "link") return "https://example.com";
    return "Example";
  });

  const wsData = [headers, row1, row2];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws["!cols"] = columns.map((col) => ({ wch: Math.max(col.label.length + 4, 15) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventory Template");
  XLSX.writeFile(wb, "wickops-inventory-template.xlsx");
};

// ─── Inventory Data Export ────────────────────────────────────────────────────

export const exportInventoryData = async (): Promise<void> => {
  const XLSX = await import("xlsx");

  // Fetch bootstrap (columns, first page of items, locations)
  const bootstrap = await loadInventoryBootstrap();
  const columns = bootstrap.columns.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const allItems: InventoryRow[] = [...bootstrap.items];

  // Paginate through remaining items
  let nextToken = bootstrap.nextToken;
  while (nextToken) {
    const page = await loadInventoryItems(nextToken);
    allItems.push(...page.items);
    nextToken = page.nextToken;
  }

  const locationNameById = new Map(bootstrap.locations.map((l) => [l.id, l.name]));

  // --- Sheet 1: Inventory ---
  // Synthesize a "Location" column at export time so the spreadsheet stays
  // human-readable. Location is structural (not a column) in the data model,
  // but exported XLSX rows have always carried it as a visible field.
  const headers = ["Location", ...columns.map((c) => c.label)];
  const rows = allItems.map((item) => {
    const loc = item.locationId ? locationNameById.get(item.locationId) ?? "" : "";
    const cells = columns.map((col) => {
      const val = item.values[col.key];
      if (val == null) return "";
      if (col.type === "boolean") return val ? "Yes" : "No";
      return val;
    });
    return [loc, ...cells];
  });

  const inventoryWs = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  inventoryWs["!cols"] = [
    { wch: 20 },
    ...columns.map((col) => ({ wch: Math.max(col.label.length + 4, 15) })),
  ];

  // --- Sheet 2: Locations ---
  const locationRows = bootstrap.locations.map((loc) => [loc.name]);
  const locationsWs = XLSX.utils.aoa_to_sheet([["Location"], ...locationRows]);
  locationsWs["!cols"] = [{ wch: 30 }];

  // --- Build workbook ---
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, inventoryWs, "Inventory");
  XLSX.utils.book_append_sheet(wb, locationsWs, "Locations");

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  XLSX.writeFile(wb, `wickops-inventory-export-${dateStr}.xlsx`);
};

// ─── Billing Portal ───────────────────────────────────────────────────────────

/**
 * Create a Stripe Customer Portal session for the logged-in user's org.
 * Returns the portal URL to redirect to.
 */
// ─── Audit Log ───────────────────────────────────────────────────────────────

export type AuditEvent = {
  eventId: string;
  action: string;
  timestamp: string;
  userId: string;
  userEmail: string;
  userName: string;
  itemId?: string;
  itemName?: string;
  details: Record<string, unknown>;
};

export type AuditFeedResponse = {
  events: AuditEvent[];
  nextCursor: string | null;
};

/** Period-bound aggregations. Returned for both the current period and (when
 *  compareYoY is requested) the same window one year prior — letting the
 *  client render YoY deltas without a second round trip. */
export type AuditAnalyticsSlice = {
  totals: {
    qtyUsed: number;
    spend: number;
    lossQty: number;
    lossValue: number;
  };
  usageOverTime: Array<{ date: string; totalUsed: number; totalSpend: number }>;
  byVendor: Array<{ vendor: string; spend: number; orderCount: number }>;
  bySpendItem: Array<{ itemId: string; itemName: string; spend: number; qtyReceived: number }>;
  byUsageItem: Array<{ itemId: string; itemName: string; qtyUsed: number; cost: number }>;
  lossByReason: Array<{ reason: string; qty: number; value: number }>;
};

export type AuditAnalytics = AuditAnalyticsSlice & {
  period: string;
  days: number;
  /** Calendar-anchored usage cost (qtyUsed × current item unit cost). Always
   *  computed across the full year regardless of the period selector so the
   *  user can compare today vs week vs YTD at a glance. Kept for back-compat;
   *  the Analytics tab no longer renders this card. */
  usageSpend: {
    today: number;
    week: number;
    ytd: number;
  };
  /** Same shape, computed for the same window one year ago. Present only when
   *  the request set `compareYoY`. */
  previous?: AuditAnalyticsSlice;
  /** Inventory items currently missing both unit and pack cost — surfaced
   *  on the Analytics tab so users can backfill prices for items that
   *  accumulated usage data without ever having a price set. Sorted by
   *  on-hand quantity descending so high-stock items float to the top. */
  missingPriceItems?: Array<{
    itemId: string;
    parentItemId: string;
    itemName: string;
    quantity: number;
  }>;
};

/** Bulk-update pricing fields on inventory items. Each entry only writes
 *  the fields it carries — leaving a field undefined preserves the row's
 *  existing value. Used by the Analytics tab's missing-prices backfill. */
export const updateItemPricing = async (updates: Array<{
  itemId: string;
  unitCost?: number;
  packSize?: number;
  packCost?: number;
  reorderLink?: string;
}>): Promise<{ updatedCount: number }> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/items/pricing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to update pricing."));
  return res.json();
};

export const fetchAuditFeed = async (params: {
  limit?: number;
  cursor?: string;
  startAfter?: string;
  endBefore?: string;
  action?: string;
  userId?: string;
}): Promise<AuditFeedResponse> => {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.startAfter) qs.set("startAfter", params.startAfter);
  if (params.endBefore) qs.set("endBefore", params.endBefore);
  if (params.action) qs.set("action", params.action);
  if (params.userId) qs.set("userId", params.userId);
  const qsStr = qs.toString();
  const url = `${INVENTORY_API_BASE_URL}/inventory/audit/feed${qsStr ? `?${qsStr}` : ""}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load audit feed."));
  return res.json();
};

export const fetchItemHistory = async (
  itemId: string,
  params: { limit?: number; cursor?: string },
): Promise<AuditFeedResponse> => {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const qsStr = qs.toString();
  const url = `${INVENTORY_API_BASE_URL}/inventory/audit/item/${encodeURIComponent(itemId)}${qsStr ? `?${qsStr}` : ""}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load item history."));
  return res.json();
};

export const fetchAuditAnalytics = async (params: {
  period: "7d" | "30d" | "90d";
  /** When true, the server also returns a `previous` aggregation for the same
   *  window one year ago — used to render YoY deltas. Defaults to false. */
  compareYoY?: boolean;
  /** When set, the server filters every aggregation to events stamped at this
   *  location (USAGE/RETIRE by name, RESTOCK by id). Omit for org-wide. */
  locationId?: string;
}): Promise<AuditAnalytics> => {
  const qs = new URLSearchParams({ period: params.period });
  if (params.compareYoY) qs.set("compareYoY", "1");
  if (params.locationId) qs.set("locationId", params.locationId);
  // Send the user's local-time day / week / year boundaries so the server's
  // calendar-anchored usageSpend buckets reflect the user's clock instead of
  // the Lambda's UTC. Without this, a usage event from 7 PM MDT yesterday
  // (= 01:00 UTC today) gets counted as "today" by a UTC-only server.
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // 7-day window = the last 7 days INCLUDING today (7 buckets total).
  const weekStart = new Date(dayStart.getTime() - 6 * 86400000);
  const yearStart = new Date(now.getFullYear(), 0, 1);
  qs.set("dayStartMs", String(dayStart.getTime()));
  qs.set("weekStartMs", String(weekStart.getTime()));
  qs.set("yearStartMs", String(yearStart.getTime()));
  const url = `${INVENTORY_API_BASE_URL}/inventory/audit/analytics?${qs.toString()}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load analytics."));
  return res.json();
};

/** Slice C: drill into a single vendor — items bought from them in the
 *  selected period with per-item spend, qty, and average unit cost. */
export type VendorBreakdown = {
  vendor: string;
  period: string;
  totals: {
    spend: number;
    orderCount: number;
    itemCount: number;
  };
  items: Array<{
    itemId: string;
    itemName: string;
    spend: number;
    qty: number;
    avgUnitCost: number;
    minUnitCost: number;
    maxUnitCost: number;
  }>;
};

export const fetchVendorBreakdown = async (params: {
  vendor: string;
  period: "7d" | "30d" | "90d";
  /** When set, restock events are filtered to ones received at this location. */
  locationId?: string;
}): Promise<VendorBreakdown> => {
  const qs = new URLSearchParams({ period: params.period, vendor: params.vendor });
  if (params.locationId) qs.set("locationId", params.locationId);
  const url = `${INVENTORY_API_BASE_URL}/inventory/audit/analytics/vendor?${qs.toString()}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load vendor breakdown."));
  return res.json();
};

// ─── Billing Portal ───────────────────────────────────────────────────────────

// ─── Restock Orders ───────────────────────────────────────────────────────────

export type RestockOrderItem = {
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost?: number;
  // For freeform items: vendor URL captured at order time, persisted onto
  // the new inventory row when received with addToInventory.
  reorderLink?: string;
  /** For freeform items: structural location captured at order time.
   *  Preferred over the legacy `location` (name) field. */
  locationId?: string;
  /** Legacy: location name captured at order time on pre-v1 orders. The
   *  receive flow falls back to this when locationId is absent. */
  location?: string;
  // For freeform items: user-entered reorder threshold. Persisted to the new
  // inventory row on receive (addToInventory) or cancel-materialization. When
  // absent, cancel-materialization falls back to qtyOrdered.
  minQuantity?: number;
  // For freeform items: pack size (units per box). Persisted to the new
  // inventory row on receive.
  packSize?: number;
  // For freeform items: pack cost (price per box). Persisted to the new
  // inventory row on receive.
  packCost?: number;
  // ── 1b: amount/UoM/price model (additive) ─────────────────────────────────
  // Mirrors the backend RestockOrderItem extension. See
  // amplify/functions/inventoryApi/src/types.ts for full notes. Optional in
  // 1b — old orders don't carry these fields; readers fall back to legacy
  // unitCost/packSize/packCost while we transition.
  /** Amount the user purchased, in `purchaseUnit` (e.g. 2.5 for "2.5 lb"). */
  purchaseAmount?: number;
  /** Unit-of-measure for purchaseAmount (e.g. "lb", "fl oz", "ct"). */
  purchaseUnit?: string;
  /** Total $ paid for this purchase line. */
  purchasePrice?: number;
  /** Server-derived $ per canonical unit. Used by per-vendor price queries. */
  pricePerCanonical?: number;
  /** Item dimension at order-create time (count|weight|volume). */
  dimension?: "count" | "weight" | "volume";
  /** True for migration-injected historical lines. */
  synthetic?: boolean;
};

export type RestockReceiveLine = {
  itemId: string;
  qtyThisReceive: number;
  expirationDate?: string;
  unitCost?: number;
  addToInventory?: boolean;
};

export type RestockReceiveEvent = {
  receivedAt: string;
  receivedByUserId: string;
  receivedByName: string;
  lines: RestockReceiveLine[];
  closedOrder: boolean;
};

export type RestockOrder = {
  id: string;
  orgId: string;
  status: "open" | "partial" | "closed";
  vendor?: string;
  notes?: string;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  items: RestockOrderItem[];
  receives: RestockReceiveEvent[];
  closedAt?: string;
  closedByName?: string;
};

export const listRestockOrders = async (): Promise<RestockOrder[]> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders`);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load restock orders."));
  const data = await res.json();
  return data.orders ?? [];
};

export const createRestockOrder = async (payload: {
  vendor?: string;
  notes?: string;
  items: Array<{
    itemId?: string;
    itemName: string;
    qtyOrdered: number;
    unitCost?: number;
    reorderLink?: string;
    location?: string;
    minQuantity?: number;
    packSize?: number;
    packCost?: number;
    /** 1b: optional amount/UoM/price triplet. Server derives
     *  pricePerCanonical from these via uom.ts; clients don't compute it. */
    purchaseAmount?: number;
    purchaseUnit?: string;
    purchasePrice?: number;
    /** 1b: dimension snapshot for the line. Defaults to "count" server-side
     *  when absent so older clients keep working. */
    dimension?: "count" | "weight" | "volume";
  }>;
}): Promise<{ orderId: string }> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to create restock order."));
  return res.json();
};

export const receiveRestockOrder = async (
  orderId: string,
  payload: { lines: RestockReceiveLine[]; closeOrder: boolean },
): Promise<{ status: string; receiveTrace?: Array<Record<string, unknown>> }> => {
  // Diagnostic block: log entry, request payload, and full response so we
  // can debug "qty didn't go up" symptoms entirely from the browser console.
  // Console.log (not console.info) so it shows up under the default filter
  // in every browser.
  // console.warn so the log shows up regardless of the browser's default
  // info/log filtering. If even this doesn't appear in the console, the
  // frontend is serving stale code — hard refresh required.
  console.warn("[receive] →", { orderId, payload });
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders/${encodeURIComponent(orderId)}/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await getApiErrorMessage(res, "Failed to receive restock order.");
    console.error("[receive] ← FAILED", res.status, msg);
    throw new Error(msg);
  }
  const data = await res.json();
  console.warn("[receive] ← response", data);
  if (Array.isArray(data?.receiveTrace) && data.receiveTrace.length > 0) {
    console.warn("[receive trace]", data.receiveTrace);
  } else {
    console.warn(
      "[receive trace] EMPTY/MISSING — most likely the deployed Lambda is on the older build (before the trace was added). " +
      "Verify by opening Network tab, finding the /receive POST, and checking whether the response body contains 'receiveTrace'.",
    );
  }
  return data;
};

export const closeRestockOrder = async (orderId: string, note?: string): Promise<void> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders/${encodeURIComponent(orderId)}/close`, {
    method: "POST",
    ...(note && note.trim()
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: note.trim() }),
        }
      : {}),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to close restock order."));
};

// ─── Price history (1d) ───────────────────────────────────────────────────────

export type PriceHistoryEntry = {
  /** Lowercased item name — cross-vendor grouping key. */
  itemKey: string;
  itemName: string;
  /** Most recent non-freeform itemId across observations, when present. */
  itemId?: string;
  vendor: string;
  /** $ per canonical unit — $/ct for count, $/oz for weight, $/fl oz for volume. */
  pricePerCanonical: number;
  canonicalUnit: string;
  dimension: "count" | "weight" | "volume";
  sampleCount: number;
  lastPurchasedAt: string;
  /** True when the most recent observation is a migration-injected line. */
  synthetic: boolean;
};

/** Fetch per-(itemName, vendor) latest-price entries within the recency
 *  window. Optional filters narrow the result to a single item — useful for
 *  the item-detail price drawer. The shopping list calls this without
 *  filters and groups results client-side. */
export const loadPriceHistory = async (filter?: {
  itemId?: string;
  itemName?: string;
}): Promise<{ history: PriceHistoryEntry[]; recencyWindowDays: number }> => {
  const params = new URLSearchParams();
  if (filter?.itemId) params.set("itemId", filter.itemId);
  if (filter?.itemName) params.set("itemName", filter.itemName);
  const qs = params.toString();
  const res = await authFetch(
    `${INVENTORY_API_BASE_URL}/inventory/price-history${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load price history."));
  const data = (await res.json()) as { history?: PriceHistoryEntry[]; recencyWindowDays?: number };
  return {
    history: Array.isArray(data.history) ? data.history : [],
    recencyWindowDays: typeof data.recencyWindowDays === "number" ? data.recencyWindowDays : 180,
  };
};

// ─── Vendor pricing per item (1g) ─────────────────────────────────────────────

/** One row in the per-(item, vendor) pricing table. The shape mirrors the
 *  backend's InventoryItemVendorPricing — keep both copies in sync. */
export type ItemVendorPricingEntry = {
  /** `${itemId}#${vendorLower}`. Server-composed; client doesn't construct it
   *  except for DELETE URLs. */
  id: string;
  itemId: string;
  vendor: string;
  vendorLower: string;
  /** 1h.7 legacy: per-unit price stored before the dual-axis split.
   *  Readable for transitional data; new rows derive $/ct or $/lb at
   *  display time from `packCost ÷ packCount` or `packCost ÷ packAmount`. */
  unitCost?: number;
  /** 1h.7 legacy: items per pack. Reads fall back to `packCount` first. */
  packSize?: number;
  /** Total $ for one pack at this vendor. Single source of cost truth. */
  packCost?: number;

  // ── 1h.7 dual-axis pack contents ────────────────────────────────────────
  // A row may carry up to two independent measurements of one pack: a
  // count axis (`packCount`) and a bulk-weight-or-volume axis (`packAmount`
  // + `packAmountUnit`). Both share `packCost`.
  //
  //   - apples: packCount = 10, packAmount = 5, packAmountUnit = "lb",
  //             packCost = 4.99 → $0.499/ct AND $0.998/lb
  //   - gauze:  packCount = 100, packCost = 24.99 → $0.25/ct
  //   - flour:  packAmount = 5, packAmountUnit = "lb", packCost = 4.99
  //             → $0.998/lb
  /** Number of countable items in one pack. */
  packCount?: number;
  /** Bulk weight or volume in one pack (paired with `packAmountUnit`). */
  packAmount?: number;
  /** Unit for `packAmount` — must be a weight or volume unit. */
  packAmountUnit?: string;

  packLabel?: string;
  reorderUrl?: string;
  /** Optimistic-lock token. Pass back on the next upsert as
   *  `expectedLastUpdatedAt` to detect concurrent edits. */
  lastUpdatedAt: string;
  lastUpdatedByUserId: string;
};

/** Upsert one (item, vendor) pricing row.
 *  - `expectedLastUpdatedAt`: pass the value the modal last read; server
 *    rejects with 409 if it's stale. Omit for first-time creates.
 *  - `expectAnyVersion`: receive flow uses this to bypass the lock — the new
 *    receipt is authoritatively newer, so last-write-wins is correct there. */
export const upsertItemVendorPricing = async (input: {
  itemId: string;
  vendor: string;
  /** 1h.7: dual-axis pack contents. Pass either or both. The server
   *  rejects packAmount without packAmountUnit, and rejects count units
   *  on packAmountUnit (those belong on packCount). */
  packCount?: number;
  packAmount?: number;
  packAmountUnit?: string;
  packCost?: number;
  packLabel?: string;
  reorderUrl?: string;
  expectedLastUpdatedAt?: string;
  expectAnyVersion?: boolean;
}): Promise<ItemVendorPricingEntry> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/item-vendor-pricing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    // Surface a typed error so the modal can re-fetch and re-render.
    const data = (await res.json()) as { error?: string; current?: ItemVendorPricingEntry | null };
    throw new VendorPricingConflictError(
      data.error ?? "Pricing was edited by someone else. Refresh and try again.",
      data.current ?? null,
    );
  }
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to save vendor pricing."));
  const data = (await res.json()) as { entry: ItemVendorPricingEntry };
  return data.entry;
};

/** Thrown when the server rejects an upsert because another writer modified
 *  the row first. Carries the current server-side row so the caller can
 *  show the user what changed. */
export class VendorPricingConflictError extends Error {
  readonly current: ItemVendorPricingEntry | null;
  constructor(message: string, current: ItemVendorPricingEntry | null) {
    super(message);
    this.name = "VendorPricingConflictError";
    this.current = current;
  }
}

export const isVendorPricingConflictError = (
  v: unknown,
): v is VendorPricingConflictError => v instanceof VendorPricingConflictError;

export const deleteItemVendorPricing = async (id: string): Promise<void> => {
  const res = await authFetch(
    `${INVENTORY_API_BASE_URL}/inventory/item-vendor-pricing/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to delete vendor pricing."));
};

// ─── Allowed units (1h.2) ─────────────────────────────────────────────────────

/** Read the org's curated allowed-units list, the full master list, and
 *  the org-wide tracksUnits gate. Settings UI uses all three. */
export const loadAllowedUnits = async (): Promise<{
  units: string[];
  knownUnits: string[];
  tracksUnits: boolean;
}> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/allowed-units`);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load allowed units."));
  const data = (await res.json()) as {
    units?: string[];
    knownUnits?: string[];
    tracksUnits?: boolean;
  };
  return {
    units: Array.isArray(data.units) ? data.units : [],
    knownUnits: Array.isArray(data.knownUnits) ? data.knownUnits : [],
    tracksUnits: typeof data.tracksUnits === "boolean" ? data.tracksUnits : false,
  };
};

/** Replace the org's allowed-units list and the tracksUnits gate. Server
 *  validates each unit against KNOWN_UNITS; persists the units list even
 *  when tracksUnits=false so re-enabling restores the prior selection. */
export const setAllowedUnits = async (
  units: string[],
  tracksUnits: boolean,
): Promise<{ units: string[]; tracksUnits: boolean }> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/allowed-units`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ units, tracksUnits }),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to save allowed units."));
  const data = (await res.json()) as { units?: string[]; tracksUnits?: boolean };
  return {
    units: Array.isArray(data.units) ? data.units : [],
    tracksUnits: typeof data.tracksUnits === "boolean" ? data.tracksUnits : tracksUnits,
  };
};

export const createBillingPortalSession = async (): Promise<string> => {
  if (!CORE_API_BASE_URL) {
    throw new Error("Missing VITE_API_BASE_URL");
  }
  const res = await authFetch(`${CORE_API_BASE_URL}/create-portal-session`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to open billing portal."));
  }
  const data = await res.json();
  return String(data.url ?? "");
};
