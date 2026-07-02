// ── Route handlers: locations ────────────────────────────────────────────────
// Post-restructure: locations are first-class id-keyed entities. Renames are
// O(1) (one row update), deletes don't fan out across items (the row keeps its
// locationId until explicitly moved), and listing is a single GSI query.

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { InventoryLocation, RouteContext } from "../types";
import { json } from "../http";
import { ddb } from "../clients";
import { listLocations, createLocation, getLocationById, renameLocation, deleteLocation, findLocationByName, setLocationParent, reorderLocations, getOrCreateDefaultBucket } from "../locations";
import { listAllItems, parseValuesJson } from "../items";
import { buildAuditEvent, writeAuditEvents } from "../audit";

const collator = new Intl.Collator("en", { sensitivity: "base" });

const isCaseInsensitiveEqual = (a: string, b: string): boolean =>
  collator.compare(a.trim(), b.trim()) === 0;

const isRoot = (loc: InventoryLocation): boolean =>
  !(loc.parentLocationId && loc.parentLocationId.trim());

/**
 * Validate that `parentId` may serve as a parent for a (new or existing) child.
 * Any location can hold stock, so the only invariant is the two-level cap: the
 * parent must itself be a top-level (primary) location, never already a
 * sublocation. Returns a ready-to-send error response, or null when valid.
 */
const validateParent = (
  all: InventoryLocation[],
  parentId: string,
): ReturnType<typeof json> | null => {
  const parent = all.find((l) => l.id === parentId);
  if (!parent) return json(404, { error: "Parent location not found" });
  if (!isRoot(parent)) {
    return json(409, {
      error: `"${parent.name}" is already a sublocation. Locations can only be two levels deep.`,
      code: "PARENT_NOT_ROOT",
    });
  }
  return null;
};

/**
 * When a primary gains its FIRST sublocation, any stock it was holding directly
 * would become invisible-as-a-set — rolled up under the station's "all" view
 * with no leaf of its own. Sweep those items into the station's default bucket
 * child so the "stock lives on a leaf" invariant holds and the items keep a
 * selectable home. No-op when the parent holds no direct items. Emits one
 * ITEM_MOVE per item. `allLocations` should be a list that still contains the
 * parent (the bucket is created lazily inside getOrCreateDefaultBucket).
 */
const sweepDirectItemsIntoBucket = async (
  ctx: RouteContext,
  parentId: string,
  allLocations: InventoryLocation[],
): Promise<void> => {
  const { storage, access } = ctx;
  const items = await listAllItems(storage, access.organizationId);
  const direct = items.filter(
    (i) => (i as { locationId?: string }).locationId === parentId,
  );
  if (direct.length === 0) return;

  const bucket = await getOrCreateDefaultBucket(storage, access.organizationId, parentId, allLocations);
  const parentName = allLocations.find((l) => l.id === parentId)?.name ?? null;
  const now = new Date().toISOString();
  const auditEvents: Record<string, unknown>[] = [];
  for (const item of direct) {
    const id = String((item as { id: unknown }).id);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id },
          UpdateExpression: "SET locationId = :loc, updatedAtCustom = :now",
          ConditionExpression: "organizationId = :org AND #module = :module",
          ExpressionAttributeNames: { "#module": "module" },
          ExpressionAttributeValues: {
            ":loc": bucket.id,
            ":now": now,
            ":org": access.organizationId,
            ":module": "inventory",
          },
        }),
      );
      const values = parseValuesJson(String((item as { valuesJson?: string }).valuesJson ?? "{}"));
      const itemName = String(values.itemName ?? "").trim() || `Item ${id.slice(0, 8)}`;
      auditEvents.push(
        buildAuditEvent(access, "ITEM_MOVE", id, itemName, {
          fromLocationId: parentId,
          fromLocationName: parentName,
          toLocationId: bucket.id,
          toLocationName: bucket.name,
          reason: "auto-bucket on first sublocation",
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }
  if (auditEvents.length > 0) await writeAuditEvents(storage.auditTable, auditEvents);
};

export const handleListLocations = async (ctx: RouteContext) => {
  const { storage } = ctx;
  const locations = await listLocations(storage);
  return json(200, { locations });
};

export const handleAddLocation = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const name = String(body?.name ?? "").trim();
  if (!name) return json(400, { error: "Location name is required" });
  if (name.length > 100) return json(400, { error: "Location name too long" });

  const existing = await listLocations(storage);

  // Optional parent: create this as a sublocation of an existing primary.
  const parentId = String(body?.parentLocationId ?? "").trim();
  if (parentId) {
    const invalid = validateParent(existing, parentId);
    if (invalid) return invalid;
  }

  // Names are unique only WITHIN a parent — different primaries can each have
  // an "EMS Cabinet". Conflict = same name among siblings sharing this parent.
  const dup = existing.find(
    (l) => (l.parentLocationId ?? "") === parentId && isCaseInsensitiveEqual(l.name, name),
  );
  if (dup) return json(409, { error: `A location named "${dup.name}" already exists here` });

  const nextSortOrder = existing.length > 0
    ? Math.max(...existing.map((l) => l.sortOrder ?? 0)) + 10
    : 10;
  const created = await createLocation(storage, access.organizationId, name, nextSortOrder, parentId || undefined);

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "LOCATION_CREATE", null, null, {
      locationId: created.id,
      name: created.name,
      ...(parentId ? { parentLocationId: parentId } : {}),
    }),
  ]);

  // If this is the parent's FIRST sublocation, relocate any stock the parent was
  // holding directly into its default bucket (keeps items on a leaf).
  if (parentId) {
    const isFirstChild = !existing.some(
      (l) => (l.parentLocationId ?? "").trim() === parentId,
    );
    if (isFirstChild) {
      await sweepDirectItemsIntoBucket(ctx, parentId, [...existing, created]);
    }
  }

  const updated = await listLocations(storage);
  return json(200, { location: created, locations: updated });
};

export const handleRenameLocation = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const id = String(body?.id ?? "").trim();
  const newName = String(body?.newName ?? "").trim();
  if (!id || !newName) return json(400, { error: "Both id and newName are required" });
  if (newName.length > 100) return json(400, { error: "Location name too long" });

  const existing = await listLocations(storage);
  const target = existing.find((l) => l.id === id);
  if (!target) return json(404, { error: "Location not found" });
  if (target.name === newName) return json(200, { location: target, locations: existing });

  // Uniqueness is scoped to the target's own parent (siblings only).
  const targetParent = target.parentLocationId ?? "";
  const dup = existing.find(
    (l) => l.id !== id && (l.parentLocationId ?? "") === targetParent && isCaseInsensitiveEqual(l.name, newName),
  );
  if (dup) return json(409, { error: `A location named "${dup.name}" already exists here` });

  const updated = await renameLocation(storage, id, newName);
  if (!updated) return json(404, { error: "Location not found" });

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "LOCATION_RENAME", null, null, {
      locationId: id,
      from: target.name,
      to: newName,
    }),
  ]);

  const updatedList = await listLocations(storage);
  return json(200, { location: updated, locations: updatedList });
};

/**
 * Nest a location under a primary, or un-nest it (parentLocationId = null) back
 * to top-level. Enforces the two-level cap via validateParent, refuses to nest
 * a location that itself has sublocations (would be three levels), and rejects
 * a move that would collide with an existing sibling's name in the destination.
 */
export const handleSetLocationParent = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const id = String(body?.id ?? "").trim();
  if (!id) return json(400, { error: "Location id is required" });
  const rawParent = body?.parentLocationId;
  const parentId = rawParent == null ? "" : String(rawParent).trim();

  const all = await listLocations(storage);
  const target = all.find((l) => l.id === id);
  if (!target) return json(404, { error: "Location not found" });
  const fromParentId = target.parentLocationId?.trim() || "";

  if (parentId) {
    if (parentId === id) return json(400, { error: "A location can't be its own parent" });
    // The location being nested must not itself be a station (have children),
    // or we'd end up three levels deep.
    const hasChildren = all.some((l) => l.parentLocationId === id);
    if (hasChildren) {
      return json(409, {
        error: `"${target.name}" has sub-locations of its own. Un-nest those first, then it can move under a station.`,
        code: "CHILD_HAS_CHILDREN",
      });
    }
    const invalid = validateParent(all, parentId);
    if (invalid) return invalid;
  }

  // Names are unique within a parent — block a move that would duplicate a
  // sibling's name in the destination (either a primary, parentId="").
  const destSiblingDup = all.find(
    (l) => l.id !== id && (l.parentLocationId ?? "") === parentId && isCaseInsensitiveEqual(l.name, target.name),
  );
  if (destSiblingDup) {
    return json(409, {
      error: `A location named "${target.name}" already exists ${parentId ? "there" : "at the top level"}.`,
      code: "NAME_CONFLICT",
    });
  }

  if (fromParentId === (parentId || "")) {
    // No-op change; return current state without an audit event.
    return json(200, { location: target, locations: all });
  }

  const updated = await setLocationParent(storage, id, parentId || null);
  if (!updated) return json(404, { error: "Location not found" });

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "LOCATION_REPARENT", null, null, {
      locationId: id,
      name: target.name,
      fromParentId: fromParentId || null,
      toParentId: parentId || null,
    }),
  ]);

  // Nesting under a primary that previously had no children makes it a station
  // for the first time — sweep its directly-held stock into the default bucket.
  if (parentId) {
    const parentHadChildren = all.some(
      (l) => l.id !== id && (l.parentLocationId ?? "").trim() === parentId,
    );
    if (!parentHadChildren) {
      await sweepDirectItemsIntoBucket(ctx, parentId, all);
    }
  }

  const updatedList = await listLocations(storage);
  return json(200, { location: updated, locations: updatedList });
};

/**
 * Persist a new location ordering. Expects the COMPLETE set of location ids in
 * the desired order; assigns sortOrder = (index + 1) * 10. Reordering is purely
 * cosmetic — it never changes parentage (that's handleSetLocationParent).
 */
export const handleReorderLocations = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });

  const locationOrder = body?.locationOrder;
  if (!Array.isArray(locationOrder) || locationOrder.length === 0) {
    return json(400, { error: "locationOrder must be a non-empty array of location ids" });
  }
  if (!locationOrder.every((id: unknown) => typeof id === "string")) {
    return json(400, { error: "locationOrder must contain only string ids" });
  }

  const existing = await listLocations(storage);
  const existingIds = new Set(existing.map((l) => l.id));
  const requestedIds = new Set(locationOrder as string[]);
  if (requestedIds.size !== locationOrder.length) {
    return json(400, { error: "locationOrder contains duplicate ids" });
  }
  for (const id of locationOrder as string[]) {
    if (!existingIds.has(id)) return json(400, { error: `Location id not found: ${id}` });
  }
  if (requestedIds.size !== existingIds.size) {
    return json(400, { error: "locationOrder must include all location ids" });
  }

  await reorderLocations(storage, locationOrder as string[]);

  const updated = await listLocations(storage);
  return json(200, { locations: updated });
};

export const handleRemoveLocation = async (ctx: RouteContext) => {
  const { storage, access, body, query } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const id = String(body?.id ?? query?.id ?? "").trim();
  if (!id) return json(400, { error: "Location id is required" });

  const target = await getLocationById(storage, id);
  if (!target) return json(404, { error: "Location not found" });

  // A station can't be deleted while it still has sub-locations, or those
  // children would dangle with a parentLocationId pointing at nothing. Caller
  // must un-nest (or delete) the children first.
  const allLocations = await listLocations(storage);
  const childCount = allLocations.filter((l) => l.parentLocationId === id).length;
  if (childCount > 0) {
    return json(409, {
      error: `"${target.name}" has ${childCount} sub-location${childCount === 1 ? "" : "s"}. Move or remove ${childCount === 1 ? "it" : "them"} before deleting this station.`,
      code: "LOCATION_HAS_CHILDREN",
      childCount,
    });
  }

  // Reject deletion if items still live in this location, unless the caller
  // explicitly opted in. Frontend surfaces a ConfirmDialog with the count
  // before passing force=true.
  const force = String(body?.force ?? query?.force ?? "").toLowerCase() === "true";
  const items = await listAllItems(storage, access.organizationId);
  const itemsInLocation = items.filter(
    (i) => (i as { locationId?: string }).locationId === id,
  );
  if (itemsInLocation.length > 0 && !force) {
    return json(409, {
      error: `Location "${target.name}" still has ${itemsInLocation.length} item${itemsInLocation.length === 1 ? "" : "s"}.`,
      code: "LOCATION_NOT_EMPTY",
      itemCount: itemsInLocation.length,
    });
  }

  // If force=true, we'd ideally re-home items to a "Default" location here,
  // but cross-location moves are explicit user actions today. The frontend
  // is expected to call /inventory/items/move in bulk before calling delete
  // with force=true. Defensive: if any items remain at force=true, refuse —
  // the client violated the contract. This avoids silently orphaning rows.
  if (itemsInLocation.length > 0 && force) {
    return json(409, {
      error: `Location "${target.name}" still has ${itemsInLocation.length} item${itemsInLocation.length === 1 ? "" : "s"}. Move them out before deleting.`,
      code: "LOCATION_NOT_EMPTY",
      itemCount: itemsInLocation.length,
    });
  }

  await deleteLocation(storage, id);

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "LOCATION_DELETE", null, null, {
      locationId: id,
      name: target.name,
    }),
  ]);

  const updated = await listLocations(storage);
  return json(200, { locations: updated });
};

/**
 * Resolve a location name to its id, creating the location if missing. Used
 * by the CSV import path (which still receives a free-text "where to import"
 * picker that allows new names) and by legacy-data restock receive flows
 * that captured a location name at order time.
 */
export const ensureLocationByName = async (
  ctx: RouteContext,
  name: string,
): Promise<string> => {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Location name is required");
  const existing = await findLocationByName(ctx.storage, trimmed);
  if (existing) return existing.id;
  const all = await listLocations(ctx.storage);
  const sortOrder = all.length > 0 ? Math.max(...all.map((l) => l.sortOrder ?? 0)) + 10 : 10;
  const created = await createLocation(ctx.storage, ctx.access.organizationId, trimmed, sortOrder);
  await writeAuditEvents(ctx.storage.auditTable, [
    buildAuditEvent(ctx.access, "LOCATION_CREATE", null, null, {
      locationId: created.id,
      name: created.name,
    }),
  ]);
  return created.id;
};
