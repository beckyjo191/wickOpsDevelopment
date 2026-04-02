// ── Shared: items.ts ────────────────────────────────────────────────────────
// Item listing and validation helpers.

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { INVENTORY_ITEM_BY_MODULE_INDEX } from "./config";
import { encodeNextToken } from "./http";
import type { InventoryItem, InventoryStorage } from "./types";

export const listItemsPage = async (
  storage: InventoryStorage,
  _organizationId: string,
  limit: number,
  startKey?: Record<string, unknown>,
): Promise<{ items: InventoryItem[]; nextToken: string | null }> => {
  const page = await ddb.send(
    new QueryCommand({
      TableName: storage.itemTable,
      IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
      KeyConditionExpression: "#module = :module",
      ExpressionAttributeNames: { "#module": "module" },
      ExpressionAttributeValues: { ":module": "inventory" },
      ExclusiveStartKey: startKey,
      Limit: limit,
    }),
  );
  const items = ((page.Items ?? []) as InventoryItem[])
    .filter((item) => item.module === "inventory")
    .sort(
    (a, b) => Number(a.position) - Number(b.position),
  );
  return {
    items,
    nextToken: encodeNextToken(page.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
};

export const listAllItems = async (storage: InventoryStorage, _organizationId: string): Promise<InventoryItem[]> => {
  const out: InventoryItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.itemTable,
        IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(
      ...((page.Items ?? []) as InventoryItem[]).filter((item) => item.module === "inventory"),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.position) - Number(b.position));
};

export const validateNonNegativeField = (
  values: Record<string, unknown>,
  field: "quantity" | "minQuantity",
): { ok: true } | { ok: false; error: string } => {
  const raw = values[field];
  if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${field} must be a number` };
  }
  if (parsed < 0) {
    return { ok: false, error: `${field} cannot be negative` };
  }
  return { ok: true };
};

/**
 * Safely parse a valuesJson string into a record. Returns {} on null/undefined/invalid JSON.
 */
export const parseValuesJson = (raw: string | undefined | null): Record<string, unknown> => {
  try {
    return JSON.parse(raw ?? "{}") ?? {};
  } catch {
    return {};
  }
};
