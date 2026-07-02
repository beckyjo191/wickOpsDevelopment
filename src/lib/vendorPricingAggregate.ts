// ── Vendor pricing: logical-item (name) aggregation ─────────────────────────
// Vendor pricing is stored per inventory ROW (`${rowId}#${vendor}`), but a
// logical item spans many lot rows (one per expiration date, and per location).
// So the price you set on lot A is invisible when you look at lot B. These
// helpers collapse pricing across all rows that share an item name — matching
// how low-stock, reorder, and the price-history rollup already key on name —
// so the app treats "same name" as one item for reads. The per-row rows remain
// the write target; this is a read-time view.

import type { InventoryRow, ItemVendorPricingEntry } from "./inventoryApi";

const nameOf = (row: InventoryRow): string =>
  String(row.values.itemName ?? "").trim().toLowerCase();

/** Freshest entry per vendor wins (by `lastUpdatedAt`). A later receipt or edit
 *  on any lot is the current price for the logical item. */
const mergeFreshest = (
  into: Map<string, ItemVendorPricingEntry>,
  from: Iterable<ItemVendorPricingEntry>,
): void => {
  for (const entry of from) {
    const existing = into.get(entry.vendorLower);
    if (!existing || String(entry.lastUpdatedAt) > String(existing.lastUpdatedAt)) {
      into.set(entry.vendorLower, entry);
    }
  }
};

/** Re-key a per-row pricing map so every lot of a logical item resolves to the
 *  SAME merged pricing (freshest per vendor across all its lots). Returned map
 *  is keyed by rowId, so existing `map.get(rowId)` call sites become
 *  name-coherent with no change. Orphan entries (rows no longer present) are
 *  passed through unchanged so nothing silently disappears. */
export function aggregateVendorPricingByName(
  rows: InventoryRow[],
  rawByRow: Map<string, Map<string, ItemVendorPricingEntry>>,
): Map<string, Map<string, ItemVendorPricingEntry>> {
  const nameByRow = new Map<string, string>();
  const rowsByName = new Map<string, string[]>();
  for (const row of rows) {
    const name = nameOf(row);
    if (!name) continue;
    nameByRow.set(row.id, name);
    const list = rowsByName.get(name);
    if (list) list.push(row.id);
    else rowsByName.set(name, [row.id]);
  }

  const mergedByName = new Map<string, Map<string, ItemVendorPricingEntry>>();
  for (const [rowId, inner] of rawByRow) {
    const name = nameByRow.get(rowId);
    if (!name) continue; // orphan — handled below
    let merged = mergedByName.get(name);
    if (!merged) { merged = new Map(); mergedByName.set(name, merged); }
    mergeFreshest(merged, inner.values());
  }

  const result = new Map<string, Map<string, ItemVendorPricingEntry>>();
  for (const [name, rowIds] of rowsByName) {
    const merged = mergedByName.get(name);
    if (!merged) continue;
    for (const rowId of rowIds) result.set(rowId, merged);
  }
  // Preserve orphan entries (rowId not among current rows) as-is.
  for (const [rowId, inner] of rawByRow) {
    if (!nameByRow.has(rowId)) result.set(rowId, inner);
  }
  return result;
}

/** Every raw pricing entry belonging to a logical item (all lots sharing the
 *  given name). Used by the pricing modal, which needs the un-merged rows to
 *  edit an entry in place and to delete a vendor across ALL lots. */
export function rawPricingForName(
  itemName: string,
  rows: InventoryRow[],
  rawByRow: Map<string, Map<string, ItemVendorPricingEntry>>,
): ItemVendorPricingEntry[] {
  const target = itemName.trim().toLowerCase();
  const out: ItemVendorPricingEntry[] = [];
  for (const row of rows) {
    if (nameOf(row) !== target) continue;
    const inner = rawByRow.get(row.id);
    if (inner) out.push(...inner.values());
  }
  return out;
}
