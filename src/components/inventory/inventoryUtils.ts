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

/** True when every value on the row is empty / zero / null — i.e. the row was
 *  created (typically via Add Row) but never given content. Mirrors the
 *  server-side `isAllDefaults` check that classifies a row as a blank-row
 *  delete (silently dropped from the audit log). Used to gate the Discard
 *  affordance: anything with content should be retired instead. */
export const isDiscardableRow = (row: InventoryRow): boolean => {
  const values = row.values ?? {};
  for (const v of Object.values(values)) {
    if (v === null || v === undefined || v === "" || v === 0) continue;
    return false;
  }
  return true;
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
