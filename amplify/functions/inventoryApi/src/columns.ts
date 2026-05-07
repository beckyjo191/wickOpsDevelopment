// ── Shared: columns.ts ──────────────────────────────────────────────────────
// Column listing and core-column seeding. Also hosts location-row reads since
// locations live in the same DynamoDB table (see RESTRUCTURE_SPEC.md §2.6).

import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { INVENTORY_COLUMN_BY_MODULE_INDEX } from "./config";
import { ensureStorageForOrganization } from "./storage";
import type { InventoryColumn, InventoryLocation, InventoryStorage } from "./types";

/**
 * Authoritative `isEditable` flag per core column key. Used by
 * `ensureColumns` to reconcile existing orgs' column rows when the flag
 * changes across releases (lazy-seed's `attribute_not_exists` blocks updates
 * to existing rows, so schema drift accumulates without this step).
 *
 * Keep in sync with the `defaults` array below. Post-restructure: location
 * and expirationDate are gone; notes is a core column.
 */
const CORE_COLUMN_IS_EDITABLE: Record<string, boolean> = {
  itemName: true,
  quantity: true,
  minQuantity: true,
  notes: true,
  // Note: vendor / reorderLink / unitCost / packSize / packCost intentionally
  // omitted. They're deprecated (1g) — vendor-specific data lives on the
  // separate inventoryItemVendorPricing table now. Existing column rows are
  // demoted to isCore: false via DEPRECATED_CORE_KEYS so users can clean up.
  // `category` (1h.5) and `unit` (1h.6) likewise — see DEPRECATED_CORE_KEYS.
};

/** Keys that USED to be core but no longer drive any system behavior. The
 *  reconcile loop demotes their stored rows to `isCore: false` so users can
 *  delete them via Manage Columns. Data in those cells is preserved (the
 *  per-item valuesJson isn't touched) — only the column metadata changes.
 *
 *  - dimension / displayUnit: 1a additions, replaced by `unit` (single column,
 *    family inferred at runtime).
 *  - vendor / packSize / packCost / unitCost / reorderLink: 1g moves these off
 *    the inventory item entirely. They were always per-vendor (a Costco box
 *    of 100 vs a BoundTree box of 50 of the same item), and the table grew
 *    unwieldy carrying them. Pricing + pack + URL now live on a separate
 *    per-(item, vendor) `inventoryItemVendorPricing` table. Existing values
 *    on item rows stay readable as a temporary fallback during migration.
 *  - category: 1h.5 — pulled as a core column. Almost never filled in
 *    practice, location-based grouping covers the "where do I find this"
 *    use case, and templates that wanted it can ship it as a regular
 *    custom column. Existing rows demote so users can hide / delete.
 *  - unit: 1h.6 — moved to per-(item, vendor) pricing rows. The inventory
 *    grid no longer renders a Unit column; the Quantity / Min Quantity
 *    cells source their suffix from the item's `displayUnit` (which
 *    derives from the first vendor pricing row's unit). Existing values
 *    in row.values.unit stay readable as a fallback during transition. */
const DEPRECATED_CORE_KEYS = new Set<string>([
  "dimension",
  "displayUnit",
  "vendor",
  "packSize",
  "packCost",
  "unitCost",
  "reorderLink",
  "category",
  "unit",
]);

/** Authoritative `isGroupable` per core column key. Post-1h.5 there are no
 *  default groupable core columns — `category` was the only one and it's
 *  been deprecated. The map stays so individual core keys can opt back in
 *  cleanly if we ever want a dropdown-filter header on one of them. */
const CORE_COLUMN_IS_GROUPABLE: Record<string, boolean> = {
  itemName: false,
  quantity: false,
  minQuantity: false,
  notes: false,
};

/**
 * Type-guard: a row in the columns table is a column row when its kind is
 * "column" OR absent (pre-migration rows lack the field).
 */
const isColumnRow = (item: Record<string, unknown>): boolean => {
  const kind = item.kind;
  return kind === undefined || kind === null || kind === "column";
};

const isLocationRow = (item: Record<string, unknown>): boolean => item.kind === "location";

export const listColumns = async (storage: InventoryStorage): Promise<InventoryColumn[]> => {
  const out: InventoryColumn[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.columnTable,
        IndexName: INVENTORY_COLUMN_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(
      ...((page.Items ?? []) as Record<string, unknown>[])
        .filter((item) => item.module === "inventory" && isColumnRow(item))
        .map((item) => item as unknown as InventoryColumn),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
};

/** List per-org locations from the columns table (kind = "location"). */
export const listLocations = async (storage: InventoryStorage): Promise<InventoryLocation[]> => {
  const out: InventoryLocation[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.columnTable,
        IndexName: INVENTORY_COLUMN_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(
      ...((page.Items ?? []) as Record<string, unknown>[])
        .filter((item) => item.module === "inventory" && isLocationRow(item))
        .map((item) => item as unknown as InventoryLocation),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
};

/**
 * Idempotent core-column seeder. Pre-migration orgs get the v1 set seeded;
 * post-migration orgs get reconciled (label/isEditable/isGroupable/isCore drift
 * propagates without manual backfill).
 *
 * Intentionally conservative: we never delete existing rows here. Removing
 * `location` and demoting `expirationDate` from core happens in the migration
 * (see migration.ts), not in seeding.
 */
export const ensureColumns = async (organizationId: string): Promise<InventoryColumn[]> => {
  const storage = await ensureStorageForOrganization(organizationId);
  const existing = await listColumns(storage);

  const coreColumnIdForKey = (key: string): string => `inventory-core-${key}`;

  // Authoritative core column set (post-restructure).
  const defaults: Omit<InventoryColumn, "id">[] = [
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "itemName",
      label: "Item Name",
      type: "text",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      sortOrder: 10,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "quantity",
      label: "Quantity",
      type: "number",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      sortOrder: 20,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "minQuantity",
      label: "Min Quantity",
      type: "number",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      sortOrder: 30,
      createdAt: new Date().toISOString(),
    },
    // 1h.6: `unit` is no longer a core column on the inventory row. UoM
    // moved to per-(item, vendor) pricing rows so each vendor can sell in
    // its own unit (Costco apples in lb vs. corner-store ct). Quantity /
    // Min Quantity render their suffix from the item's `displayUnit`,
    // which derives from the first vendor pricing row's unit. Existing
    // orgs' Unit core column gets demoted to isCore: false by the
    // reconcile loop and can be hidden / deleted by users.
    // 1g: vendor, reorderLink, unitCost, packSize, packCost are no longer
    // seeded as inventory-row columns — they live on the per-(item, vendor)
    // `inventoryItemVendorPricing` table, accessed via the item detail
    // modal. Existing orgs that still have these column rows from an earlier
    // seed get demoted to isCore: false by the reconcile pass below so they
    // can be deleted via Manage Columns. Item values for these keys remain
    // readable as a fallback until 1g.7 migration finishes.
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "notes",
      label: "Notes",
      type: "text",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      sortOrder: 90,
      createdAt: new Date().toISOString(),
    },
    // 1h.5: `category` is no longer seeded for new orgs. Templates that
    // want a category-style facet can ship it as a regular custom column.
    // Existing orgs keep their category data; the reconcile loop demotes
    // those rows to isCore: false so users can hide or delete them.
  ];

  const existingByKey = new Map(existing.map((c) => [c.key, c]));

  // Lazy seed: insert every default that doesn't yet exist by key.
  for (const column of defaults) {
    if (existingByKey.has(column.key)) continue;
    try {
      await ddb.send(
        new PutCommand({
          TableName: storage.columnTable,
          Item: {
            id: coreColumnIdForKey(column.key),
            ...column,
          },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    } catch (err: any) {
      if (err?.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
  }

  // Reconcile drift on existing core rows (isEditable / isGroupable / kind /
  // deprecation). Only touches core columns whose stored value disagrees with
  // the authoritative map. Non-core columns are user-managed and never
  // reconciled here.
  let reconciled = false;
  for (const col of existing) {
    if (!col.isCore) continue;
    const updates: Record<string, unknown> = {};

    // Demote deprecated keys: flip isCore→false so the column-mgmt UI shows
    // a delete button. Data on item rows is preserved (valuesJson untouched).
    if (DEPRECATED_CORE_KEYS.has(col.key)) {
      updates.isCore = false;
    } else {
      const editableTarget = CORE_COLUMN_IS_EDITABLE[col.key];
      const groupableTarget = CORE_COLUMN_IS_GROUPABLE[col.key];
      if (editableTarget !== undefined && col.isEditable !== editableTarget) {
        updates.isEditable = editableTarget;
      }
      if (groupableTarget !== undefined && (col.isGroupable ?? false) !== groupableTarget) {
        updates.isGroupable = groupableTarget;
      }
    }
    // Backfill kind on pre-migration rows.
    if (col.kind === undefined) {
      updates.kind = "column";
    }
    if (Object.keys(updates).length === 0) continue;
    try {
      const setExpr = Object.keys(updates)
        .map((k) => `#${k} = :${k}`)
        .join(", ");
      const exprNames = Object.fromEntries(Object.keys(updates).map((k) => [`#${k}`, k]));
      const exprValues = Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v]));
      await ddb.send(
        new UpdateCommand({
          TableName: storage.columnTable,
          Key: { id: col.id },
          UpdateExpression: `SET ${setExpr}`,
          ExpressionAttributeNames: exprNames,
          ExpressionAttributeValues: exprValues,
        }),
      );
      reconciled = true;
    } catch (err) {
      console.warn(`Failed to reconcile core column ${col.key}`, err);
    }
  }

  if (existingByKey.size < defaults.length || reconciled) {
    return listColumns(storage);
  }
  return existing;
};
