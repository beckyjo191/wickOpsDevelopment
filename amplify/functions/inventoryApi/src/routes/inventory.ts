// ── Route handlers: inventory ───────────────────────────────────────────────
import { BatchGetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { RetireReason, RouteContext } from "../types";
import { RETIRE_REASONS } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken } from "../http";
import { getParentItemId, listAllItems, listItemsPage, validateNonNegativeField } from "../items";
import { buildAuditEvent, findAuditEventByEventId, writeAuditEvents, writeAuditEventsCoalesced, computeValuesDiff } from "../audit";
import { listLocations } from "../columns";

// Machine-managed fields in valuesJson. Changes to these shouldn't produce
// ITEM_EDIT audit events — they're either identity (parentItemId) or state
// already captured by a dedicated audit action (retire/restock). `orderedAt`
// is auto-flipped by the restock flow whenever an order is placed or received,
// so showing those edits alongside the RESTOCK_ORDER_CREATE / RESTOCK_RECEIVED
// events is pure noise.
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
  "orderedAt",
]);

export const handleListItems = async (ctx: RouteContext) => {
  const { storage, access, query } = ctx;
  const limit = Math.min(Math.max(Number(query.limit ?? 500), 1), 10_000);
  const start = parseNextToken(query.nextToken);
  const page = await listItemsPage(storage, access.organizationId, limit, start);
  return json(200, page);
};

/** True when every value is an empty string, zero, or null/undefined — i.e. a blank row. */
const isAllDefaults = (vals: Record<string, unknown>): boolean =>
  Object.values(vals).every((v) => v === null || v === undefined || v === "" || v === 0);

export const handleSaveItems = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Insufficient permissions" });
  }

  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const deletedRowIds = Array.isArray(body?.deletedRowIds)
    ? body.deletedRowIds
        .map((value: unknown) => String(value ?? "").trim())
        .filter((value: string) => value.length > 0)
    : [];

  // Batch-read existing rows for audit diff. Also project locationId so save
  // can preserve the structural pointer when the client doesn't supply one.
  const allIds = [
    ...rows.map((r: any) => String(r?.id ?? "").trim()).filter((id: string) => id.length > 0),
    ...deletedRowIds,
  ];
  const oldValuesMap = new Map<string, Record<string, unknown>>();
  const oldLocationMap = new Map<string, string | undefined>();
  if (allIds.length > 0) {
    for (let i = 0; i < allIds.length; i += 100) {
      const chunk = allIds.slice(i, i + 100);
      try {
        const batchResult = await ddb.send(
          new BatchGetCommand({
            RequestItems: {
              [storage.itemTable]: {
                Keys: chunk.map((id: string) => ({ id })),
                ProjectionExpression: "id, valuesJson, locationId",
              },
            },
          }),
        );
        const items = batchResult.Responses?.[storage.itemTable] ?? [];
        for (const item of items) {
          try {
            oldValuesMap.set(String(item.id), JSON.parse(String(item.valuesJson ?? "{}")));
          } catch {
            oldValuesMap.set(String(item.id), {});
          }
          if (typeof item.locationId === "string") {
            oldLocationMap.set(String(item.id), String(item.locationId));
          }
        }
      } catch {
        // Non-critical: audit diffs will be unavailable but save proceeds
      }
    }
  }

  // Validate any new locationId values against the current locations list.
  // Reject up-front rather than letting a typo land a row in a non-existent
  // location. Also build a name map for audit-event denormalization so the
  // activity feed can render "added at <Location>" without a join.
  const allLocationsForSave = await listLocations(storage);
  const knownLocationIds = new Set(allLocationsForSave.map((l) => l.id));
  const locationNameById = new Map(allLocationsForSave.map((l) => [l.id, l.name]));

  const auditEvents: Record<string, unknown>[] = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const rowId = String(row?.id ?? "").trim() || randomUUID();
    const values = (row?.values ?? {}) as Record<string, unknown>;
    // Strip any legacy location field — location is now structural. Defensive
    // because v0 clients may still send `values.location` for a deploy cycle
    // (we accept it but never persist it).
    delete values.location;
    // Stamp the logical-item id. Preserves an existing link if the client sent one
    // (e.g. when adding a new lot under an existing parent); otherwise defaults to
    // the row's own id so every row is at minimum its own logical item.
    values.parentItemId = getParentItemId(rowId, values);
    const quantityValidation = validateNonNegativeField(values, "quantity");
    if (!quantityValidation.ok) {
      const reason = "error" in quantityValidation ? quantityValidation.error : "invalid quantity";
      return json(400, { error: `Row ${idx + 1}: ${reason}` });
    }
    const minQuantityValidation = validateNonNegativeField(values, "minQuantity");
    if (!minQuantityValidation.ok) {
      const reason = "error" in minQuantityValidation ? minQuantityValidation.error : "invalid minQuantity";
      return json(400, { error: `Row ${idx + 1}: ${reason}` });
    }

    // Resolve the structural locationId. Three paths:
    //  1. Client sends `locationId` → validate + use
    //  2. Existing row → keep its current locationId
    //  3. Brand-new row with no locationId → reject (the client always knows
    //     which location it's adding into; absence is a bug worth surfacing)
    const requestedLocationId =
      typeof row?.locationId === "string" && row.locationId.trim().length > 0
        ? row.locationId.trim()
        : null;
    const existingLocationId = oldLocationMap.get(rowId);
    let locationId: string;
    if (requestedLocationId) {
      if (!knownLocationIds.has(requestedLocationId)) {
        return json(400, {
          error: `Row ${idx + 1}: locationId '${requestedLocationId}' does not exist`,
        });
      }
      locationId = requestedLocationId;
    } else if (existingLocationId && knownLocationIds.has(existingLocationId)) {
      locationId = existingLocationId;
    } else {
      return json(400, {
        error: `Row ${idx + 1}: locationId is required for new rows`,
      });
    }

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: rowId },
          ConditionExpression:
            "attribute_not_exists(id) OR (organizationId = :org AND #module = :module)",
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, locationId = :locationId, updatedAtCustom = :updatedAtCustom, createdAt = if_not_exists(createdAt, :createdAt)",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":position": Number(row?.position ?? idx),
            ":values": JSON.stringify(values),
            ":locationId": locationId,
            ":updatedAtCustom": new Date().toISOString(),
            ":createdAt": String(row?.createdAt ?? new Date().toISOString()),
          },
        }),
      );
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        return json(403, { error: `Row ${idx + 1} does not belong to organization` });
      }
      throw err;
    }

    // Build audit event — defer ITEM_CREATE until the row has meaningful
    // content so the activity log shows the real item name, not "Item 07ec…"
    const itemName = String(values.itemName ?? "").trim() || `Item ${rowId.slice(0, 8)}`;
    const oldValues = oldValuesMap.get(rowId);
    const snapshot: Record<string, unknown> = {};
    if (values.quantity !== undefined && values.quantity !== null) snapshot.quantity = values.quantity;
    if (values.minQuantity !== undefined && values.minQuantity !== null) snapshot.minQuantity = values.minQuantity;
    if (values.expirationDate !== undefined && values.expirationDate !== null && values.expirationDate !== "") snapshot.expirationDate = values.expirationDate;

    // Retire metadata: when present, the qty-to-zero change on this row is a
    // retirement, not a generic edit. Emit ITEM_RETIRE with reason + parent link
    // and suppress the generic ITEM_EDIT so analytics don't double-count.
    const retireMeta = (body?.retireMetadata as Record<string, unknown> | undefined)?.[rowId];
    const retire = retireMeta && typeof retireMeta === "object" ? (retireMeta as Record<string, unknown>) : null;
    const retireReason: RetireReason | null = retire && typeof retire.reason === "string" && (RETIRE_REASONS as string[]).includes(retire.reason)
      ? (retire.reason as RetireReason)
      : null;

    if (retireReason && oldValues) {
      const qtyBefore = Number(oldValues.quantity ?? 0);
      const qtyAfter = Number(values.quantity ?? 0);
      const qtyDelta = Number.isFinite(qtyBefore) && Number.isFinite(qtyAfter)
        ? Math.max(0, qtyBefore - qtyAfter)
        : Number(retire?.qty ?? 0);
      const notes = typeof retire?.notes === "string" && retire.notes.trim() ? String(retire.notes).trim() : undefined;
      auditEvents.push(buildAuditEvent(access, "ITEM_RETIRE", rowId, itemName, {
        reason: retireReason,
        qty: qtyDelta,
        qtyBefore,
        qtyAfter,
        parentItemId: String(values.parentItemId ?? rowId),
        ...(notes ? { notes } : {}),
        snapshot,
      }));
    } else if (oldValues) {
      const allChanges = computeValuesDiff(oldValues, values as Record<string, unknown>);
      // System fields are machine-managed — they'd flood the activity feed with
      // noise the first time every row gets stamped with parentItemId or when
      // retire/restock flows touch their markers. The dedicated RESTOCK_ADDED /
      // ITEM_RETIRE events already carry that context, so we strip them from
      // the generic ITEM_EDIT diff.
      const userChanges = allChanges.filter((c) => !SYSTEM_FIELDS.has(c.field));
      if (userChanges.length > 0) {
        // If old values were all defaults, this is the first meaningful edit —
        // treat it as the real "create" event with the actual item name.
        const action = isAllDefaults(oldValues) ? "ITEM_CREATE" as const : "ITEM_EDIT" as const;
        auditEvents.push(buildAuditEvent(access, action, rowId, itemName, action === "ITEM_CREATE"
          ? { initialValues: values, snapshot }
          : { changes: userChanges, snapshot }));
      }
    } else {
      // Brand new row — only log creation if it has actual content. Stamp
      // location info so the activity feed can render "added at <Location>".
      if (!isAllDefaults(values as Record<string, unknown>)) {
        auditEvents.push(
          buildAuditEvent(access, "ITEM_CREATE", rowId, itemName, {
            initialValues: values,
            snapshot,
            locationId,
            locationName: locationNameById.get(locationId) ?? null,
          }),
        );
      }
    }

    // Restock metadata (from Fast Restock): emit a separate RESTOCK_ADDED audit
    // event with the structured metadata so analytics can distinguish restock
    // deltas from ordinary edits — including source (donation vs supplier), the
    // qty delta captured at the time, and the unit cost paid per unit.
    const restockMeta = (body?.restockMetadata as Record<string, unknown> | undefined)?.[rowId];
    if (restockMeta && typeof restockMeta === "object") {
      const m = restockMeta as Record<string, unknown>;
      const qtyDelta = Number(m.qtyDelta);
      if (Number.isFinite(qtyDelta) && qtyDelta > 0) {
        const meta: Record<string, unknown> = {
          source: String(m.source ?? "other"),
          qtyDelta,
          // parentItemId lets phase 2 analytics aggregate cost/usage across lots
          // of the same logical item without relying on itemName string matching.
          parentItemId: String(values.parentItemId ?? rowId),
        };
        if (m.unitCost !== undefined && m.unitCost !== null && m.unitCost !== "") {
          const uc = Number(m.unitCost);
          if (Number.isFinite(uc) && uc >= 0) meta.unitCost = uc;
        }
        if (typeof m.vendor === "string" && m.vendor.trim()) {
          meta.vendor = m.vendor.trim();
        }
        if (typeof m.reorderLink === "string" && m.reorderLink.trim()) {
          meta.reorderLink = m.reorderLink.trim();
        }
        if (typeof m.location === "string" && m.location.trim()) {
          meta.location = m.location.trim();
        }
        auditEvents.push(buildAuditEvent(access, "RESTOCK_ADDED", rowId, itemName, meta));
      }
    }
  }

  // Delete guard: block deletion of items that still have stock on hand. The
  // user must consume (Log Usage) or retire that stock first so loss analytics
  // stay accurate. Once qty == 0 the SKU is fair game to delete — the audit
  // events live in their own table keyed by ITEM#<id> and survive the row.
  if (deletedRowIds.length > 0) {
    const protectedRows = deletedRowIds
      .map((id: string) => {
        const vals = oldValuesMap.get(id);
        const qty = Number(vals?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) return null;
        return {
          id,
          itemName: String(vals?.itemName ?? "").trim() || `Item ${id.slice(0, 8)}`,
        };
      })
      .filter((r: { id: string; itemName: string } | null): r is { id: string; itemName: string } => r !== null);
    if (protectedRows.length > 0) {
      return json(409, {
        error: "Some items still have stock and can't be deleted. Log usage or retire first.",
        code: "DELETE_BLOCKED_HAS_STOCK",
        protectedRows,
      });
    }
  }

  for (const deletedId of deletedRowIds) {
    const oldValues = oldValuesMap.get(deletedId);
    const deletedName = oldValues ? String(oldValues.itemName ?? "") : "";
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: storage.itemTable,
          Key: { id: deletedId },
          ConditionExpression: "organizationId = :org AND #module = :module",
          ExpressionAttributeNames: {
            "#module": "module",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
          },
        }),
      );
      // Suppress ITEM_DELETE for rows that were never populated — a blank row
      // created and then cleaned up is accidental noise, not activity worth
      // logging. Rows with any populated value get a delete event so the audit
      // log captures the SKU's removal even after its row is gone.
      const isBlankRow = !oldValues || isAllDefaults(oldValues);
      if (!isBlankRow) {
        auditEvents.push(buildAuditEvent(access, "ITEM_DELETE", deletedId, deletedName, {
          deletedValues: oldValues ?? {},
        }));
      }
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  // Split events: ITEM_CREATE/ITEM_EDIT go through the coalescing path so rapid
  // edits by the same user within a 5-minute window merge into one event.
  // Everything else (restock, retire, delete, etc.) writes straight through.
  const coalescibleEvents = auditEvents.filter(
    (e) => e.action === "ITEM_CREATE" || e.action === "ITEM_EDIT",
  );
  const otherEvents = auditEvents.filter(
    (e) => e.action !== "ITEM_CREATE" && e.action !== "ITEM_EDIT",
  );
  await Promise.all([
    writeAuditEventsCoalesced(storage.auditTable, coalescibleEvents),
    writeAuditEvents(storage.auditTable, otherEvents),
  ]);
  return json(200, { ok: true });
};

/**
 * Reverse a previous ITEM_RETIRE event: clear the retire markers on the row,
 * additively restore the retired quantity, and mark the original event as
 * undone so the Undo button stops appearing for it. Mirrors the USAGE_UNDO
 * shape (audit update is conditional, then row update — order matters under
 * concurrent undos so only one wins).
 *
 * Body: { eventId, itemId } — itemId is required because audit events are
 * partitioned by ITEM#<itemId>.
 */
export const handleUndoRetire = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can undo retire events." });
  }

  const eventId = String(body?.eventId ?? "").trim();
  const itemId = String(body?.itemId ?? "").trim();
  if (!eventId || !itemId) {
    return json(400, { error: "eventId and itemId are required." });
  }

  const original = await findAuditEventByEventId(
    storage.auditTable,
    `ITEM#${itemId}`,
    eventId,
  );
  if (!original) return json(404, { error: "Retire event not found." });
  if (original.action !== "ITEM_RETIRE") {
    return json(400, { error: "Only retire events can be undone." });
  }
  if (original.undoneAt) {
    return json(409, { error: "This retire event has already been undone." });
  }

  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(original.detailsJson ?? "{}")); } catch { details = {}; }
  const retiredQty = Number(details.qty ?? 0);
  if (!Number.isFinite(retiredQty) || retiredQty < 0) {
    return json(400, { error: "Original event metadata is invalid; cannot undo." });
  }

  const items = await listAllItems(storage, access.organizationId);
  const item = items.find((i) => String(i.id) === itemId);
  if (!item) return json(404, { error: "Item no longer exists." });

  let values: Record<string, string | number | boolean | null> = {};
  try {
    values = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, string | number | boolean | null>;
  } catch {
    values = {};
  }
  const itemName = String(values.itemName ?? "").trim() || `Item ${itemId.slice(0, 8)}`;
  const currentQuantity = Number(values.quantity ?? 0);
  const restoredQuantity = (Number.isFinite(currentQuantity) ? currentQuantity : 0) + retiredQty;

  const undoneAt = new Date().toISOString();
  const undoEventId = randomUUID();
  const updatedDetails = {
    ...details,
    undone: true,
    undoneAt,
    undoneByUserId: access.userId,
    undoneByEventId: undoEventId,
  };
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: storage.auditTable,
        Key: { pk: original.pk as string, sk: original.sk as string },
        UpdateExpression: "SET detailsJson = :d, undoneAt = :ua",
        ConditionExpression: "attribute_not_exists(undoneAt)",
        ExpressionAttributeValues: {
          ":d": JSON.stringify(updatedDetails),
          ":ua": undoneAt,
        },
      }),
    );
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return json(409, { error: "This retire event has already been undone." });
    }
    throw err;
  }

  // Strip retire markers and restore quantity. We delete the marker keys rather
  // than set them empty so the row leaves the "retired" filter cleanly.
  const nextValues: Record<string, string | number | boolean | null> = { ...values };
  delete nextValues.retiredAt;
  delete nextValues.retiredQty;
  delete nextValues.retirementReason;
  nextValues.quantity = restoredQuantity;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: storage.itemTable,
        Key: { id: item.id },
        ConditionExpression: "organizationId = :org AND #module = :module",
        UpdateExpression: "SET valuesJson = :values, updatedAtCustom = :updatedAtCustom",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":module": "inventory",
          ":values": JSON.stringify(nextValues),
          ":updatedAtCustom": new Date().toISOString(),
        },
      }),
    );
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return json(409, { error: "Item does not belong to organization." });
    }
    throw err;
  }

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "ITEM_UNRETIRE", itemId, itemName, {
      undoneEventId: eventId,
      reason: details.reason,
      quantityRestored: retiredQty,
      quantityBefore: currentQuantity,
      quantityAfter: restoredQuantity,
    }),
  ]);

  return json(200, { ok: true });
};

/**
 * Structural location move. Body: `{ rowIds: string[], locationId }`.
 * Updates each row's `locationId` and emits one ITEM_MOVE audit event per
 * row. Replaces the prior pattern of moves being recorded as ordinary
 * ITEM_EDIT events whose `changes` array happened to contain `field:
 * "location"`.
 */
export const handleMoveItems = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });

  const rowIds = Array.isArray(body?.rowIds)
    ? body.rowIds
        .map((v: unknown) => String(v ?? "").trim())
        .filter((v: string) => v.length > 0)
    : [];
  const locationId = String(body?.locationId ?? "").trim();
  if (rowIds.length === 0) return json(400, { error: "rowIds is required" });
  if (!locationId) return json(400, { error: "locationId is required" });

  // Validate the destination exists.
  const locations = await listLocations(storage);
  const dest = locations.find((l) => l.id === locationId);
  if (!dest) return json(400, { error: `locationId '${locationId}' does not exist` });
  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));

  // Snapshot existing rows so the audit events can record the from-side.
  const oldByIdMap = new Map<string, { locationId?: string; itemName: string }>();
  for (let i = 0; i < rowIds.length; i += 100) {
    const chunk = rowIds.slice(i, i + 100);
    try {
      const batchResult = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [storage.itemTable]: {
              Keys: chunk.map((id: string) => ({ id })),
              ProjectionExpression: "id, valuesJson, locationId",
            },
          },
        }),
      );
      const items = batchResult.Responses?.[storage.itemTable] ?? [];
      for (const item of items) {
        let parsedValues: Record<string, unknown> = {};
        try { parsedValues = JSON.parse(String(item.valuesJson ?? "{}")); } catch { /* ignore */ }
        const id = String(item.id);
        oldByIdMap.set(id, {
          locationId: typeof item.locationId === "string" ? String(item.locationId) : undefined,
          itemName: String(parsedValues.itemName ?? "").trim() || `Item ${id.slice(0, 8)}`,
        });
      }
    } catch {
      // Audit will be incomplete but moves still proceed.
    }
  }

  const auditEvents: Record<string, unknown>[] = [];
  let movedCount = 0;
  const now = new Date().toISOString();
  for (const id of rowIds) {
    const old = oldByIdMap.get(id);
    if (!old) continue; // not found — silently skip rather than 404 the whole batch
    if (old.locationId === locationId) continue; // no-op move
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id },
          UpdateExpression: "SET locationId = :loc, updatedAtCustom = :now",
          ConditionExpression: "organizationId = :org AND #module = :module",
          ExpressionAttributeNames: { "#module": "module" },
          ExpressionAttributeValues: {
            ":loc": locationId,
            ":now": now,
            ":org": access.organizationId,
            ":module": "inventory",
          },
        }),
      );
      auditEvents.push(
        buildAuditEvent(access, "ITEM_MOVE", id, old.itemName, {
          fromLocationId: old.locationId ?? null,
          fromLocationName: old.locationId ? locationNameById.get(old.locationId) ?? null : null,
          toLocationId: locationId,
          toLocationName: dest.name,
        }),
      );
      movedCount += 1;
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  if (auditEvents.length > 0) {
    await writeAuditEvents(storage.auditTable, auditEvents);
  }

  return json(200, { ok: true, movedCount });
};
