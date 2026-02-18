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

export type InventoryAccess = {
  userId: string;
  organizationId: string;
  role: string;
  canEditInventory: boolean;
  canManageColumns: boolean;
};

export type InventoryColumn = ApiColumn;

export type InventoryRow = {
  id: string;
  position: number;
  values: Record<string, string | number | boolean | null>;
  createdAt?: string;
};

const requireBaseUrl = () => {
  if (!INVENTORY_API_BASE_URL) {
    throw new Error("Missing VITE_INVENTORY_API_BASE_URL");
  }
  return INVENTORY_API_BASE_URL;
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

export const importInventoryCsv = async (
  csvText: string,
): Promise<{
  ok: boolean;
  createdCount: number;
  updatedCount: number;
  importedRows: number;
  createdColumns: Array<{ id: string; key: string; label: string }>;
}> => {
  const base = requireBaseUrl();
  const res = await authFetch(`${base}/inventory/import-csv`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvText }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || "Failed to import CSV");
  }
  return await res.json();
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
