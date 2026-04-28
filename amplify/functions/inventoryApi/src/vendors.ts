// ── Shared: vendors.ts ──────────────────────────────────────────────────────
// Vendor registry helpers.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import type { InventoryStorage } from "./types";

export const VENDORS_REGISTRY_ID = "inventory-meta-vendors";

export const getRegisteredVendors = async (storage: InventoryStorage): Promise<string[]> => {
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: storage.columnTable, Key: { id: VENDORS_REGISTRY_ID } }),
    );
    const vendors = result.Item?.vendors;
    if (Array.isArray(vendors)) return vendors.map((v: unknown) => String(v)).filter((v) => v.length > 0);
  } catch { /* ignore */ }
  return [];
};

export const saveRegisteredVendors = async (storage: InventoryStorage, vendors: string[]): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName: storage.columnTable,
      Item: { id: VENDORS_REGISTRY_ID, vendors, updatedAt: new Date().toISOString() },
    }),
  );
};
