// ── Shared: locations.ts ────────────────────────────────────────────────────
// Location entity helpers. Locations live as `kind: "location"` rows in the
// per-org columns table (see RESTRUCTURE_SPEC.md §2.6) — a unified store keeps
// the per-org provisioning footprint small. This module is the read/write
// boundary; route handlers compose these primitives.

import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import type { InventoryLocation, InventoryStorage } from "./types";
import { listLocations } from "./columns";

export { listLocations };

/** Pre-migration registry id. Surviving the migration as a "meta" row that
 *  records the migrated registry's last state (audit only — readers don't
 *  consult it). The migration converts its `locations: string[]` blob into
 *  per-location rows and then stamps `kind: "meta"` on the singleton. */
export const LOCATIONS_REGISTRY_ID = "inventory-meta-locations";

export const DEFAULT_LOCATION_NAME = "Default";

const collator = new Intl.Collator("en", { sensitivity: "base" });

const equalsCaseInsensitive = (a: string, b: string): boolean =>
  collator.compare(a.trim(), b.trim()) === 0;

export const getLocationById = async (
  storage: InventoryStorage,
  id: string,
): Promise<InventoryLocation | null> => {
  const result = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id } }),
  );
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item || item.kind !== "location") return null;
  return item as unknown as InventoryLocation;
};

export const findLocationByName = async (
  storage: InventoryStorage,
  name: string,
): Promise<InventoryLocation | null> => {
  const all = await listLocations(storage);
  return all.find((loc) => equalsCaseInsensitive(loc.name, name)) ?? null;
};

/**
 * Create a new location row. Caller is responsible for case-insensitive
 * duplicate checking against `listLocations` first — this helper assumes the
 * name is already known unique within the org.
 */
export const createLocation = async (
  storage: InventoryStorage,
  organizationId: string,
  name: string,
  sortOrder: number,
): Promise<InventoryLocation> => {
  const created: InventoryLocation = {
    id: randomUUID(),
    organizationId,
    module: "inventory",
    kind: "location",
    name,
    sortOrder,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: created }));
  return created;
};

export const renameLocation = async (
  storage: InventoryStorage,
  id: string,
  name: string,
): Promise<InventoryLocation | null> => {
  const existing = await getLocationById(storage, id);
  if (!existing) return null;
  if (existing.name === name) return existing;
  // Belt and suspenders: refuse to rewrite a row that isn't a location.
  // Without the kind condition, a malformed id could clobber a column row.
  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id },
      UpdateExpression: "SET #n = :n",
      ConditionExpression: "kind = :k",
      ExpressionAttributeNames: { "#n": "name" },
      ExpressionAttributeValues: { ":n": name, ":k": "location" },
    }),
  );
  return { ...existing, name };
};

export const deleteLocation = async (
  storage: InventoryStorage,
  id: string,
): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName: storage.columnTable,
      Key: { id },
      ConditionExpression: "kind = :k",
      ExpressionAttributeValues: { ":k": "location" },
    }),
  );
};
