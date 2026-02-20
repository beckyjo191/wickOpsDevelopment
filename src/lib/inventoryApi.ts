import { authFetch } from "./authFetch";

const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVENTORY_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVENTORY_API_BASE_URL);

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

export type AppModuleKey = "inventory" | "usage";

export type InventoryColumn = ApiColumn;

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
    nextToken: data.nextToken ?? null,
  };
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

export const submitInventoryUsage = async (
  entries: InventoryUsageEntryInput[],
): Promise<{
  ok: boolean;
  updatedCount: number;
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
    updatedCount: Number(data?.updatedCount ?? 0),
  };
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
    throw new Error((await res.text()) || "Failed to update module access");
  }
};
