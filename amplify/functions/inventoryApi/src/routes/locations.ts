// ── Route handlers: locations ────────────────────────────────────────────────
// Post-restructure: locations are first-class id-keyed entities. Renames are
// O(1) (one row update), deletes don't fan out across items (the row keeps its
// locationId until explicitly moved), and listing is a single GSI query.

import type { RouteContext } from "../types";
import { json } from "../http";
import { listLocations, createLocation, getLocationById, renameLocation, deleteLocation, findLocationByName } from "../locations";
import { listAllItems } from "../items";
import { buildAuditEvent, writeAuditEvents } from "../audit";

const collator = new Intl.Collator("en", { sensitivity: "base" });

const isCaseInsensitiveEqual = (a: string, b: string): boolean =>
  collator.compare(a.trim(), b.trim()) === 0;

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
  const dup = existing.find((l) => isCaseInsensitiveEqual(l.name, name));
  if (dup) return json(409, { error: `A location named "${dup.name}" already exists` });

  const nextSortOrder = existing.length > 0
    ? Math.max(...existing.map((l) => l.sortOrder ?? 0)) + 10
    : 10;
  const created = await createLocation(storage, access.organizationId, name, nextSortOrder);

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "LOCATION_CREATE", null, null, {
      locationId: created.id,
      name: created.name,
    }),
  ]);

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

  const dup = existing.find((l) => l.id !== id && isCaseInsensitiveEqual(l.name, newName));
  if (dup) return json(409, { error: `A location named "${dup.name}" already exists` });

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

export const handleRemoveLocation = async (ctx: RouteContext) => {
  const { storage, access, body, query } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const id = String(body?.id ?? query?.id ?? "").trim();
  if (!id) return json(400, { error: "Location id is required" });

  const target = await getLocationById(storage, id);
  if (!target) return json(404, { error: "Location not found" });

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
