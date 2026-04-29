import type { InventoryColumn, InventoryRow } from "./inventoryTypes";

export const normalizeHeaderKey = (value: string): string => value.trim().toLowerCase();

export const createBlankInventoryRow = (
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

/** True when the row can be deleted — no stock on hand. The server's
 *  delete guard is the final gate: it rejects with `DELETE_BLOCKED_HAS_STOCK`
 *  if quantity > 0 at save time. Past audit history (edits, usage, retires)
 *  doesn't block delete; those events live in the audit table keyed by
 *  ITEM#<id> and survive the row.
 *
 *  Retire is a different verb — it tracks lot loss with a reason for analytics
 *  and is unaffected by Delete. */
export const isDeletableRow = (row: InventoryRow): boolean => {
  const v = row.values ?? {};
  const qty = Number(v.quantity ?? 0);
  return !(Number.isFinite(qty) && qty > 0);
};

export const buildRowsSignature = (rows: InventoryRow[]): string =>
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

/**
 * Logical-item identity across lots. Falls back to the row's own id for rows
 * that haven't been stamped yet (pre-migration or freshly-created blank rows).
 */
export const getParentItemId = (row: InventoryRow): string => {
  const raw = row.values.parentItemId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return row.id;
};

/** Group rows by their logical parentItemId. Useful for lot rollups. */
export const groupRowsByParent = (rows: InventoryRow[]): Map<string, InventoryRow[]> => {
  const out = new Map<string, InventoryRow[]>();
  for (const row of rows) {
    const parent = getParentItemId(row);
    const bucket = out.get(parent);
    if (bucket) bucket.push(row);
    else out.set(parent, [row]);
  }
  return out;
};
