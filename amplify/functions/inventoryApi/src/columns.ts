// ── Shared: columns.ts ──────────────────────────────────────────────────────
// Column listing and core-column seeding.

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { INVENTORY_COLUMN_BY_MODULE_INDEX } from "./config";
import { normalizeLooseKey } from "./normalize";
import { ensureStorageForOrganization } from "./storage";
import type { InventoryColumn, InventoryStorage } from "./types";

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
      ...((page.Items ?? []) as InventoryColumn[]).filter((item) => item.module === "inventory"),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
};

export const ensureColumns = async (organizationId: string): Promise<InventoryColumn[]> => {
  const storage = await ensureStorageForOrganization(organizationId);
  const existing = await listColumns(storage);

  const coreColumnIdForKey = (key: string): string => `inventory-core-${key}`;

  // For existing orgs, ensure the location core column exists (added after initial 4 core columns).
  // Skip if the org already has a column with key matching "location" (from a template).
  if (existing.length > 0) {
    const hasLocationColumn = existing.some(
      (c) => normalizeLooseKey(c.key) === "location" || normalizeLooseKey(c.label) === "location" || normalizeLooseKey(c.label) === "storagelocation",
    );
    if (!hasLocationColumn) {
      const maxSort = Math.max(...existing.map((c) => c.sortOrder ?? 0), 40);
      try {
        await ddb.send(
          new PutCommand({
            TableName: storage.columnTable,
            Item: {
              id: coreColumnIdForKey("location"),
              organizationId,
              module: "inventory",
              key: "location",
              label: "Location",
              type: "text",
              isCore: true,
              isRequired: false,
              isVisible: true,
              isEditable: true,
              sortOrder: maxSort + 10,
              createdAt: new Date().toISOString(),
            } satisfies InventoryColumn,
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") throw err;
      }
    }

    // Ensure the reorderLink core column exists (added after location).
    const hasReorderLinkColumn = existing.some(
      (c) => normalizeLooseKey(c.key) === "reorderlink",
    );
    if (!hasReorderLinkColumn) {
      const maxSort = Math.max(...existing.map((c) => c.sortOrder ?? 0), 50);
      try {
        await ddb.send(
          new PutCommand({
            TableName: storage.columnTable,
            Item: {
              id: coreColumnIdForKey("reorderLink"),
              organizationId,
              module: "inventory",
              key: "reorderLink",
              label: "Reorder Link",
              type: "link",
              isCore: true,
              isRequired: false,
              isVisible: true,
              isEditable: true,
              sortOrder: maxSort + 10,
              createdAt: new Date().toISOString(),
            } satisfies InventoryColumn,
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") throw err;
      }
    }

    // Ensure the unitCost core column exists (added after reorderLink).
    // Hidden by default — orgs that don't track cost won't see an empty column.
    // Non-editable — value is refreshed only by restock events (Fast Restock /
    // Orders receive) so the cached latest-price stays honest.
    const hasUnitCostColumn = existing.some(
      (c) => normalizeLooseKey(c.key) === "unitcost",
    );
    if (!hasUnitCostColumn) {
      const maxSort = Math.max(...existing.map((c) => c.sortOrder ?? 0), 60);
      try {
        await ddb.send(
          new PutCommand({
            TableName: storage.columnTable,
            Item: {
              id: coreColumnIdForKey("unitCost"),
              organizationId,
              module: "inventory",
              key: "unitCost",
              label: "Unit Cost",
              type: "number",
              isCore: true,
              isRequired: false,
              isVisible: false,
              isEditable: false,
              sortOrder: maxSort + 10,
              createdAt: new Date().toISOString(),
            } satisfies InventoryColumn,
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") throw err;
      }
    }

    // Ensure the packSize core column exists (items that come in cases/boxes).
    // Hidden by default; editable so users can set per-item pack size.
    const hasPackSizeColumn = existing.some(
      (c) => normalizeLooseKey(c.key) === "packsize",
    );
    if (!hasPackSizeColumn) {
      const maxSort = Math.max(...existing.map((c) => c.sortOrder ?? 0), 70);
      try {
        await ddb.send(
          new PutCommand({
            TableName: storage.columnTable,
            Item: {
              id: coreColumnIdForKey("packSize"),
              organizationId,
              module: "inventory",
              key: "packSize",
              label: "Pack Size",
              type: "number",
              isCore: true,
              isRequired: false,
              isVisible: false,
              isEditable: true,
              sortOrder: maxSort + 10,
              createdAt: new Date().toISOString(),
            } satisfies InventoryColumn,
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") throw err;
      }
    }

    // Ensure the packCost core column exists. Derived from unitCost × packSize
    // — the frontend computes + displays; no stored value is expected.
    // Hidden by default + non-editable so users can toggle visibility but
    // can't type into it.
    const hasPackCostColumn = existing.some(
      (c) => normalizeLooseKey(c.key) === "packcost",
    );
    if (!hasPackCostColumn) {
      const maxSort = Math.max(...existing.map((c) => c.sortOrder ?? 0), 80);
      try {
        await ddb.send(
          new PutCommand({
            TableName: storage.columnTable,
            Item: {
              id: coreColumnIdForKey("packCost"),
              organizationId,
              module: "inventory",
              key: "packCost",
              label: "Pack Cost",
              type: "number",
              isCore: true,
              isRequired: false,
              isVisible: false,
              isEditable: false,
              sortOrder: maxSort + 10,
              createdAt: new Date().toISOString(),
            } satisfies InventoryColumn,
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (err: any) {
        if (err?.name !== "ConditionalCheckFailedException") throw err;
      }
    }

    if (
      !hasLocationColumn
      || !hasReorderLinkColumn
      || !hasUnitCostColumn
      || !hasPackSizeColumn
      || !hasPackCostColumn
    ) {
      return listColumns(storage);
    }
    return existing;
  }

  const defaults: Omit<InventoryColumn, "id">[] = [
    {
      organizationId,
      module: "inventory",
      key: "itemName",
      label: "Item Name",
      type: "text",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 10,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "quantity",
      label: "Quantity",
      type: "number",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 20,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "minQuantity",
      label: "Min Quantity",
      type: "number",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 30,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "expirationDate",
      label: "Expiration Date",
      type: "date",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 40,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "location",
      label: "Location",
      type: "text",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 50,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "reorderLink",
      label: "Reorder Link",
      type: "link",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 60,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "unitCost",
      label: "Unit Cost",
      type: "number",
      isCore: true,
      isRequired: false,
      // Hidden by default — orgs that don't track cost won't see an empty column.
      // Users can show it from the column settings.
      isVisible: false,
      // Non-editable — value is refreshed only by restock events (Fast Restock
      // or Orders receive) so the cached latest-price matches audit history.
      isEditable: false,
      sortOrder: 70,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "packSize",
      label: "Pack Size",
      type: "number",
      isCore: true,
      isRequired: false,
      // Hidden by default — orgs that don't buy in boxes don't see it.
      isVisible: false,
      isEditable: true,
      sortOrder: 80,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "packCost",
      label: "Pack Cost",
      type: "number",
      isCore: true,
      isRequired: false,
      // Hidden by default + read-only — value is derived (unitCost × packSize)
      // and computed by the frontend; users can reveal the column but can't
      // edit the cell directly.
      isVisible: false,
      isEditable: false,
      sortOrder: 90,
      createdAt: new Date().toISOString(),
    },
  ];

  for (const column of defaults) {
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

  return listColumns(storage);
};
