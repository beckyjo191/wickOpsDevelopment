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
  sortOrder: number;
};

type ApiItem = {
  id: string;
  position: number;
  valuesJson: string;
  createdAt: string;
  updatedAtCustom: string;
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
  values: Record<string, string | number | boolean | null>;
  createdAt?: string;
};

export type InventoryUsageEntryInput = {
  itemId: string;
  quantityUsed: number;
  notes?: string;
  location?: string;
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
  registeredLocations: string[];
  columnVisibilityOverrides: ColumnVisibilityOverrides;
  nextToken: string | null;
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
        values: parseValues(item.valuesJson),
        createdAt: item.createdAt,
      }))
      .sort((a, b) => a.position - b.position),
    registeredLocations: Array.isArray(data.registeredLocations)
      ? (data.registeredLocations as string[]).filter((l: string) => typeof l === "string" && l.length > 0)
      : [],
    columnVisibilityOverrides: (data.columnVisibilityOverrides ?? {}) as ColumnVisibilityOverrides,
    nextToken: data.nextToken ?? null,
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

export const saveInventoryItems = async (
  rows: InventoryRow[],
  deletedRowIds: string[] = [],
): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/items/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rows: rows.map((row, index) => ({
        id: row.id,
        position: index,
        values: row.values,
        createdAt: row.createdAt,
      })),
      deletedRowIds,
    }),
  });

  if (!res.ok) {
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
  pending: boolean;
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
    pending: !!data?.pending,
    submissionId: String(data?.submissionId ?? ""),
    entryCount: Number(data?.entryCount ?? 0),
  };
};

export type PendingEntry = {
  itemId: string;
  itemName: string;
  quantityUsed: number;
  notes?: string;
  location?: string;
};

export type PendingSubmission = {
  id: string;
  submittedAt: string;
  submittedByUserId: string;
  submittedByEmail: string;
  submittedByName: string;
  status: "pending" | "approved" | "rejected";
  entriesJson: string;
  reviewedAt?: string;
  reviewedByUserId?: string;
  reviewedByEmail?: string;
  rejectionReason?: string;
};

export const listPendingSubmissions = async (): Promise<PendingSubmission[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/usage/pending`);
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to load pending submissions."));
  }
  const data = await res.json();
  return (Array.isArray(data.submissions) ? data.submissions : []) as PendingSubmission[];
};

export const approveUsageSubmission = async (
  submissionId: string,
  overrideEntries?: PendingEntry[],
): Promise<{ ok: boolean; updatedCount: number }> => {
  const base = requireBaseUrl();
  const body = overrideEntries && overrideEntries.length > 0
    ? JSON.stringify({ entries: overrideEntries })
    : undefined;
  const res = await authFetch(
    `${base}/inventory/usage/pending/${encodeURIComponent(submissionId)}/approve`,
    {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
    },
  );
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to approve submission."));
  }
  const data = await res.json();
  return { ok: !!data?.ok, updatedCount: Number(data?.updatedCount ?? 0) };
};

export const deleteUsageSubmission = async (submissionId: string): Promise<void> => {
  const base = requireBaseUrl();
  const res = await authFetch(
    `${base}/inventory/usage/pending/${encodeURIComponent(submissionId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to delete submission."));
  }
};

export const rejectUsageSubmission = async (
  submissionId: string,
  reason?: string,
): Promise<{ ok: boolean }> => {
  const base = requireBaseUrl();
  const res = await authFetch(
    `${base}/inventory/usage/pending/${encodeURIComponent(submissionId)}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason ?? "" }),
    },
  );
  if (!res.ok) {
    throw new Error(await getApiErrorMessage(res, "Failed to reject submission."));
  }
  return { ok: true };
};

export const importInventoryCsv = async (
  csvText: string,
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

// ─── Location Registry ───────────────────────────────────────────────────────

/** Try to extract a human-readable error from a JSON response body. */
const extractApiError = async (res: Response, fallback: string): Promise<string> => {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch { /* not JSON — fall through */ }
  return fallback;
};

export const addInventoryLocation = async (name: string): Promise<string[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to add location"));
  const data = await res.json();
  return Array.isArray(data.locations) ? data.locations : [];
};

export const renameInventoryLocation = async (oldName: string, newName: string): Promise<{ locations: string[]; renamedCount: number }> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!res.ok) throw new Error(await extractApiError(res, "Failed to rename location"));
  const data = await res.json();
  return {
    locations: Array.isArray(data.locations) ? data.locations : [],
    renamedCount: Number(data.renamedCount ?? 0),
  };
};

export const removeInventoryLocation = async (name: string): Promise<string[]> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/locations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.text()) || "Failed to remove location");
  const data = await res.json();
  return Array.isArray(data.locations) ? data.locations : [];
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

  // --- Sheet 1: Inventory ---
  const headers = columns.map((c) => c.label);
  const rows = allItems.map((item) =>
    columns.map((col) => {
      const val = item.values[col.key];
      if (val == null) return "";
      if (col.type === "boolean") return val ? "Yes" : "No";
      return val;
    }),
  );

  const inventoryWs = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  inventoryWs["!cols"] = columns.map((col) => ({
    wch: Math.max(col.label.length + 4, 15),
  }));

  // --- Sheet 2: Locations ---
  const locationRows = (bootstrap.registeredLocations ?? []).map((loc) => [loc]);
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

export type AuditAnalytics = {
  period: string;
  days: number;
  totalEvents: number;
  usageOverTime: Array<{ date: string; totalUsed: number }>;
  userComparison: Array<{
    userId: string;
    email: string;
    name: string;
    edits: number;
    approvals: number;
    submissions: number;
    total: number;
  }>;
  topItems: Array<{
    itemId: string;
    itemName: string;
    changeCount: number;
    totalUsed: number;
  }>;
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
}): Promise<AuditAnalytics> => {
  const url = `${INVENTORY_API_BASE_URL}/inventory/audit/analytics?period=${params.period}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to load analytics."));
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
  items: Array<{ itemId?: string; itemName: string; qtyOrdered: number; unitCost?: number }>;
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
): Promise<{ status: string }> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders/${encodeURIComponent(orderId)}/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to receive restock order."));
  return res.json();
};

export const closeRestockOrder = async (orderId: string): Promise<void> => {
  const res = await authFetch(`${INVENTORY_API_BASE_URL}/inventory/restock/orders/${encodeURIComponent(orderId)}/close`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to close restock order."));
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
