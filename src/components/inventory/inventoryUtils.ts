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

/** True when the row has no operational use — no on-hand quantity, no
 *  expiration date, and no retire markers. The user may have typed a name,
 *  set a min quantity, attached a vendor, etc., but until the row has actually
 *  received stock or been retired it's still safe to discard. The server's
 *  `hasProtectedHistory` check is the final gate (rejects if audit events
 *  beyond ITEM_CREATE exist), so the client check just hides the Discard
 *  button when the values themselves clearly indicate operational history.
 *
 *  Anything that fails this check should route through Retire instead so
 *  the loss reason and audit trail are preserved. */
export const isDiscardableRow = (row: InventoryRow): boolean => {
  const v = row.values ?? {};
  const qty = Number(v.quantity ?? 0);
  if (Number.isFinite(qty) && qty > 0) return false;
  if (typeof v.expirationDate === "string" && v.expirationDate.trim() !== "") return false;
  if (v.retiredAt) return false;
  if (v.retiredQty && Number(v.retiredQty) > 0) return false;
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
