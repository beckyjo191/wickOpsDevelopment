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

/** Name of the auto-created child bucket that holds stock saved to a station
 *  (a primary that has sublocations). Items can't live on a parent directly —
 *  see resolveStockLocation — so they land here instead. User-renamable like
 *  any sublocation; we match it back by name when resolving. */
export const DEFAULT_BUCKET_NAME = "General";

const collator = new Intl.Collator("en", { sensitivity: "base" });

const equalsCaseInsensitive = (a: string, b: string): boolean =>
  collator.compare(a.trim(), b.trim()) === 0;

const parentIdOf = (loc: InventoryLocation): string =>
  (loc.parentLocationId ?? "").trim();

/** True when `id` has at least one sublocation in `all`. */
export const locationHasChildren = (
  all: InventoryLocation[],
  id: string,
): boolean => all.some((l) => parentIdOf(l) === id);

/**
 * Get — or lazily create — the default stock bucket child of a parent station.
 * Idempotent: reuses an existing child named DEFAULT_BUCKET_NAME (the one a
 * previous resolve/sweep made, or one the user renamed something else and back)
 * before creating a new one. Pass `all` to avoid a redundant listLocations.
 */
export const getOrCreateDefaultBucket = async (
  storage: InventoryStorage,
  organizationId: string,
  parentId: string,
  all?: InventoryLocation[],
): Promise<InventoryLocation> => {
  const locations = all ?? (await listLocations(storage));
  const existing = locations.find(
    (l) => parentIdOf(l) === parentId && equalsCaseInsensitive(l.name, DEFAULT_BUCKET_NAME),
  );
  if (existing) return existing;
  const sortOrder = locations.length > 0
    ? Math.max(...locations.map((l) => l.sortOrder ?? 0)) + 10
    : 10;
  return createLocation(storage, organizationId, DEFAULT_BUCKET_NAME, sortOrder, parentId);
};

/**
 * Resolve a requested stock locationId to a LEAF location id. Stock can only
 * live on a leaf, so if the requested location has children it can't hold items
 * directly — route into its default bucket child (created on demand). A leaf
 * (flat primary or real sublocation) is returned unchanged. Returns null when
 * the requested id doesn't exist. Pass `all` to share an already-fetched list.
 */
export const resolveStockLocation = async (
  storage: InventoryStorage,
  organizationId: string,
  requestedId: string,
  all?: InventoryLocation[],
): Promise<string | null> => {
  const locations = all ?? (await listLocations(storage));
  const target = locations.find((l) => l.id === requestedId);
  if (!target) return null;
  if (!locationHasChildren(locations, requestedId)) return requestedId;
  const bucket = await getOrCreateDefaultBucket(storage, organizationId, requestedId, locations);
  return bucket.id;
};

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
  parentLocationId?: string,
): Promise<InventoryLocation> => {
  const created: InventoryLocation = {
    id: randomUUID(),
    organizationId,
    module: "inventory",
    kind: "location",
    name,
    sortOrder,
    createdAt: new Date().toISOString(),
    // Only persist the attribute when set — keeps root rows clean and matches
    // how readers treat absent as "top-level".
    ...(parentLocationId ? { parentLocationId } : {}),
  };
  await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: created }));
  return created;
};

/** Set or clear a location's parent. Passing null/empty removes the pointer
 *  (promotes the location back to top-level). Caller is responsible for the
 *  2-level / cycle / leaves-only validation — this helper just writes. */
export const setLocationParent = async (
  storage: InventoryStorage,
  id: string,
  parentLocationId: string | null,
): Promise<InventoryLocation | null> => {
  const existing = await getLocationById(storage, id);
  if (!existing) return null;
  const next = parentLocationId?.trim() || null;
  if (next) {
    await ddb.send(
      new UpdateCommand({
        TableName: storage.columnTable,
        Key: { id },
        UpdateExpression: "SET parentLocationId = :p",
        ConditionExpression: "kind = :k",
        ExpressionAttributeValues: { ":p": next, ":k": "location" },
      }),
    );
    return { ...existing, parentLocationId: next };
  }
  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id },
      UpdateExpression: "REMOVE parentLocationId",
      ConditionExpression: "kind = :k",
      ExpressionAttributeValues: { ":k": "location" },
    }),
  );
  const { parentLocationId: _drop, ...rest } = existing;
  return rest;
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

/** Persist a new ordering by stamping sortOrder = (index + 1) * 10 on each id
 *  in `orderedIds`. Mirrors the column reorder helper. Caller validates that
 *  the ids are all locations and form the complete set. */
export const reorderLocations = async (
  storage: InventoryStorage,
  orderedIds: string[],
): Promise<void> => {
  await Promise.all(
    orderedIds.map((id, index) =>
      ddb.send(
        new UpdateCommand({
          TableName: storage.columnTable,
          Key: { id },
          UpdateExpression: "SET sortOrder = :s",
          ConditionExpression: "kind = :k",
          ExpressionAttributeValues: { ":s": (index + 1) * 10, ":k": "location" },
        }),
      ),
    ),
  );
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
