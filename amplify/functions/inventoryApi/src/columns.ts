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
 * and expirationDate are gone; notes and category are new core columns.
 */
const CORE_COLUMN_IS_EDITABLE: Record<string, boolean> = {
  itemName: true,
  quantity: true,
  minQuantity: true,
  vendor: true,
  reorderLink: true,
  unitCost: false,   // derived from packCost / packSize (or restock events)
  packSize: true,
  packCost: true,
  notes: true,
  category: true,
};

/** Authoritative `isGroupable` per core column key. Only `category` ships
 *  with the dropdown filter on by default; all others off. */
const CORE_COLUMN_IS_GROUPABLE: Record<string, boolean> = {
  itemName: false,
  quantity: false,
  minQuantity: false,
  vendor: false,
  reorderLink: false,
  unitCost: false,
  packSize: false,
  packCost: false,
  notes: false,
  category: true,
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
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "vendor",
      label: "Vendor",
      type: "text",
      isCore: true,
      isRequired: false,
      isVisible: false,
      isEditable: true,
      isGroupable: false,
      sortOrder: 40,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "reorderLink",
      label: "Product URL",
      type: "link",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      sortOrder: 50,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "unitCost",
      label: "Unit Cost",
      type: "number",
      isCore: true,
      isRequired: false,
      isVisible: false,
      // Non-editable — value is refreshed only by restock events / pack
      // derivation so the cached latest-price matches audit history.
      isEditable: false,
      isGroupable: false,
      sortOrder: 60,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "packSize",
      label: "Pack Size",
      type: "number",
      isCore: true,
      isRequired: false,
      isVisible: false,
      isEditable: true,
      isGroupable: false,
      sortOrder: 70,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "packCost",
      label: "Pack Cost",
      type: "number",
      isCore: true,
      isRequired: false,
      isVisible: false,
      isEditable: true,
      isGroupable: false,
      sortOrder: 80,
      createdAt: new Date().toISOString(),
    },
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
    {
      organizationId,
      module: "inventory",
      kind: "column",
      key: "category",
      label: "Category",
      type: "text",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      // Category ships with the header dropdown filter on. Replaces the
      // previous hardcoded `column.key === "category"` branch in the table.
      isGroupable: true,
      sortOrder: 100,
      createdAt: new Date().toISOString(),
    },
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

  // Reconcile drift on existing core rows (isEditable / isGroupable / kind).
  // Only touches core columns whose stored value disagrees with the authoritative
  // map. Non-core columns are user-managed and never reconciled here.
  let reconciled = false;
  for (const col of existing) {
    if (!col.isCore) continue;
    const updates: Record<string, unknown> = {};
    const editableTarget = CORE_COLUMN_IS_EDITABLE[col.key];
    const groupableTarget = CORE_COLUMN_IS_GROUPABLE[col.key];
    if (editableTarget !== undefined && col.isEditable !== editableTarget) {
      updates.isEditable = editableTarget;
    }
    if (groupableTarget !== undefined && (col.isGroupable ?? false) !== groupableTarget) {
      updates.isGroupable = groupableTarget;
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
