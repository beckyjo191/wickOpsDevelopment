// ── Shared: locations.ts ────────────────────────────────────────────────────
// Location registry helpers.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import type { InventoryStorage } from "./types";

export const LOCATIONS_REGISTRY_ID = "inventory-meta-locations";

export const getRegisteredLocations = async (storage: InventoryStorage): Promise<string[]> => {
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: storage.columnTable, Key: { id: LOCATIONS_REGISTRY_ID } }),
    );
    const locations = result.Item?.locations;
    if (Array.isArray(locations)) return locations.map((l: unknown) => String(l)).filter((l) => l.length > 0);
  } catch { /* ignore */ }
  return [];
};

export const saveRegisteredLocations = async (storage: InventoryStorage, locations: string[]): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName: storage.columnTable,
      Item: { id: LOCATIONS_REGISTRY_ID, locations, updatedAt: new Date().toISOString() },
    }),
  );
};
