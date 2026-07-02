// ── Usage submission handlers ───────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  AccessContext,
  InventoryStorage,
  PendingEntry,
  PendingSubmission,
  RouteContext,
} from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { buildAuditEvent, findAuditEventByEventId, writeAuditEvents } from "../audit";
import { listAllItems } from "../items";

/** Effective per-unit cost from an item's valuesJson. Prefers packCost /
 *  packSize when both are set (handles items priced per-box at the vendor),
 *  falls back to the stored unitCost, returns 0 when neither is available.
 *  Mirrors the same derivation used by the reorder list and audit analytics. */
const effectiveUnitCost = (values: Record<string, unknown>): number => {
  const packCost = Number(values.packCost ?? 0);
  const packSize = Number(values.packSize ?? 0);
  if (Number.isFinite(packCost) && Number.isFinite(packSize) && packSize > 0 && packCost > 0) {
    return packCost / packSize;
  }
  const unitCost = Number(values.unitCost ?? 0);
  if (Number.isFinite(unitCost) && unitCost > 0) return unitCost;
  return 0;
};

type AppliedUsageDetail = {
  itemId: string;
  itemName: string;
  quantityUsed: number;
  quantityBefore: number;
  quantityAfter: number;
  /** Per-unit cost at the moment of approval. Stamped into the USAGE_APPROVE
   *  audit event so analytics can value historical usage at then-current
   *  pricing rather than a moving "current" item cost. */
  unitCost: number;
  /** Item's structural locationId at the moment of approval, stamped on the
   *  audit event so per-station analytics filters can attribute the usage
   *  without falling back to the item's current location. */
  locationId?: string;
  /** Human-readable location name at the moment of approval, kept alongside
   *  locationId for display in the activity feed without a join. */
  locationName?: string;
  snapshot: Record<string, unknown>;
};

export const applyUsageEntries = async (
  storage: InventoryStorage,
  access: AccessContext,
  pendingEntries: PendingEntry[],
): Promise<{ error?: string; appliedDetails?: AppliedUsageDetail[] }> => {
  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));
  // Resolve location names once so each USAGE_APPROVE event can stamp both
  // locationId (for analytics filtering) and a human-readable name (for the
  // activity feed). Failures here are non-fatal: the locationId still goes
  // on the event, the name is just omitted.
  const locationNameById = new Map<string, string>();
  try {
    const { listLocations } = await import("../locations");
    const locations = await listLocations(storage);
    for (const loc of locations) locationNameById.set(loc.id, loc.name);
  } catch { /* name lookup failed — locationId-only is still correct */ }

  for (let i = 0; i < pendingEntries.length; i += 1) {
    const entry = pendingEntries[i];
    const item = byId.get(entry.itemId);
    if (!item) {
      return { error: `Entry ${i + 1} (${entry.itemName}): item no longer exists.` };
    }
    let values: Record<string, string | number | boolean | null> = {};
    try {
      values = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, string | number | boolean | null>;
    } catch {
      values = {};
    }
    const currentQuantity = Number(values.quantity ?? 0);
    if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
      return { error: `Entry ${i + 1} (${entry.itemName}): current quantity is invalid.` };
    }
    if (entry.quantityUsed > currentQuantity) {
      return {
        error: `Entry ${i + 1} (${entry.itemName}): usage (${entry.quantityUsed}) exceeds available quantity (${currentQuantity}).`,
      };
    }
  }

  // All validated — apply deductions
  const appliedDetails: AppliedUsageDetail[] = [];
  for (const entry of pendingEntries) {
    const item = byId.get(entry.itemId)!;
    let values: Record<string, string | number | boolean | null> = {};
    try {
      values = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, string | number | boolean | null>;
    } catch {
      values = {};
    }
    const quantityBefore = Number(values.quantity ?? 0);
    const nextQuantity = quantityBefore - entry.quantityUsed;
    const unitCost = effectiveUnitCost(values as Record<string, unknown>);
    const nextValues = { ...values, quantity: nextQuantity };
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
      const snap: Record<string, unknown> = { quantity: nextQuantity };
      if (values.minQuantity !== undefined && values.minQuantity !== null) snap.minQuantity = values.minQuantity;
      if (values.expirationDate !== undefined && values.expirationDate !== null && values.expirationDate !== "") snap.expirationDate = values.expirationDate;
      const itemLocationId = typeof (item as { locationId?: unknown }).locationId === "string"
        ? String((item as { locationId?: unknown }).locationId).trim()
        : "";
      appliedDetails.push({
        itemId: entry.itemId,
        itemName: entry.itemName,
        quantityUsed: entry.quantityUsed,
        quantityBefore,
        quantityAfter: nextQuantity,
        unitCost,
        ...(itemLocationId ? { locationId: itemLocationId } : {}),
        ...(itemLocationId && locationNameById.get(itemLocationId)
          ? { locationName: locationNameById.get(itemLocationId) }
          : {}),
        snapshot: snap,
      });
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        return { error: `Item (${entry.itemName}): does not belong to organization.` };
      }
      throw err;
    }
  }

  // ── Collapse emptied lots ────────────────────────────────────────────────
  // After deductions a lot may have hit 0. Within each (locationId + itemName)
  // group this usage touched:
  //   - if any lot still has stock → delete the now-empty lots (a stocked lot
  //     already represents the item; empty duplicates are clutter);
  //   - if every lot is empty → keep exactly ONE skeleton row (so the item
  //     never vanishes from that leaf and stays reorderable) and delete the
  //     rest, preferring to keep one that carries a reorder threshold.
  // Mirrors the retire-path skeleton rule, keyed on leaf + name. Retired rows
  // are history and are never touched. Housekeeping only — a failure here must
  // not fail the approval.
  try {
    const newQtyById = new Map<string, number>();
    for (const d of appliedDetails) newQtyById.set(String(d.itemId), d.quantityAfter);

    const parseVals = (it: (typeof items)[number]): Record<string, unknown> => {
      try { return JSON.parse(String(it.valuesJson ?? "{}")); } catch { return {}; }
    };
    const locOf = (it: (typeof items)[number]): string =>
      typeof (it as { locationId?: unknown }).locationId === "string"
        ? String((it as { locationId?: unknown }).locationId).trim()
        : "";
    const groupKey = (locId: string, nameLower: string) => `${locId}\x00${nameLower}`;

    // Only groups touched by this usage can have newly emptied lots.
    const affected = new Set<string>();
    for (const d of appliedDetails) {
      const it = byId.get(String(d.itemId));
      if (!it) continue;
      const name = String(parseVals(it).itemName ?? "").trim().toLowerCase();
      if (name) affected.add(groupKey(locOf(it), name));
    }

    const idsToDelete: string[] = [];
    for (const key of affected) {
      // All non-retired lots of this (location + name) group, with the
      // post-deduction quantity applied to the lots we just touched.
      const lots = items
        .map((it) => {
          const v = parseVals(it);
          if (v.retiredAt) return null;
          const name = String(v.itemName ?? "").trim().toLowerCase();
          if (groupKey(locOf(it), name) !== key) return null;
          const qty = newQtyById.has(String(it.id))
            ? Number(newQtyById.get(String(it.id)))
            : Number(v.quantity ?? 0);
          const min = Number(v.minQuantity ?? 0);
          return { id: String(it.id), qty: Number.isFinite(qty) ? qty : 0, hasMin: Number.isFinite(min) && min > 0 };
        })
        .filter((x): x is { id: string; qty: number; hasMin: boolean } => x !== null);

      const zeros = lots.filter((l) => l.qty <= 0);
      if (zeros.length === 0) continue; // nothing emptied in this group
      if (lots.some((l) => l.qty > 0)) {
        // Stock remains → drop every empty lot.
        for (const z of zeros) idsToDelete.push(z.id);
      } else {
        // Fully depleted → keep one skeleton (prefer one with a reorder
        // threshold so it still flags as low), delete the rest.
        const keep = zeros.find((z) => z.hasMin) ?? zeros[0];
        for (const z of zeros) if (z.id !== keep.id) idsToDelete.push(z.id);
      }
    }

    for (const id of idsToDelete) {
      await ddb.send(new DeleteCommand({
        TableName: storage.itemTable,
        Key: { id },
        ConditionExpression: "organizationId = :org AND #module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":org": access.organizationId, ":module": "inventory" },
      }));
    }
  } catch (err) {
    console.warn("usage lot-collapse prune failed (non-fatal):", err);
  }

  return { appliedDetails };
};

export const handleSubmitUsage = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return json(400, { error: "At least one usage entry is required." });
  }

  // Validate and deduplicate entries.
  // Post-restructure: clients no longer send `location` per entry — the item's
  // structural locationId is authoritative. We accept and ignore an incoming
  // `location` field for one deploy cycle's worth of v0 client compatibility.
  const usageByItemId = new Map<string, { quantityUsed: number; notes?: string }>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const itemId = String(entry?.itemId ?? "").trim();
    if (!itemId) {
      return json(400, { error: `Entry ${i + 1}: itemId is required.` });
    }
    const quantityUsed = Number(entry?.quantityUsed);
    if (!Number.isFinite(quantityUsed) || quantityUsed < 0) {
      return json(400, { error: "Used quantity must be 0 or greater." });
    }
    const notes = String(entry?.notes ?? "").trim();
    const existing = usageByItemId.get(itemId);
    if (!existing) {
      usageByItemId.set(itemId, { quantityUsed, notes: notes || undefined });
      continue;
    }
    existing.quantityUsed += quantityUsed;
    usageByItemId.set(itemId, existing);
  }

  // Validate items exist and denormalize names for the pending record
  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));

  const pendingEntries: PendingEntry[] = [];
  let itemCounter = 0;
  for (const [itemId, entry] of usageByItemId) {
    itemCounter += 1;
    const item = byId.get(itemId);
    if (!item) {
      return json(404, { error: `Entry ${itemCounter}: item not found.` });
    }
    let values: Record<string, string | number | boolean | null> = {};
    try {
      values = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, string | number | boolean | null>;
    } catch {
      values = {};
    }
    const itemName = String(values.itemName ?? "").trim() || `Item ${itemId.slice(0, 8)}`;
    pendingEntries.push({
      itemId,
      itemName,
      quantityUsed: entry.quantityUsed,
      notes: entry.notes,
    });
  }

  // Direct decrement: the previous two-step pending approval flow has been
  // collapsed into a single submit-and-decrement. Mistakes are recoverable via
  // the Undo button on the resulting USAGE_APPROVE event in the Activity feed.
  const applyResult = await applyUsageEntries(storage, access, pendingEntries);
  if (applyResult.error) {
    return json(409, { error: applyResult.error });
  }

  // Group all items from this single submission under one id. Stored on every
  // resulting audit event's metadata; useful for grouping in analytics and as
  // a hook for a future "undo whole submission" affordance.
  const submissionId = randomUUID();
  const notesByItemId = new Map(pendingEntries.map((e) => [e.itemId, e.notes]));

  const auditEvents: Record<string, unknown>[] = [];
  for (const detail of applyResult.appliedDetails ?? []) {
    const notes = notesByItemId.get(detail.itemId);
    auditEvents.push(buildAuditEvent(access, "USAGE_APPROVE", detail.itemId, detail.itemName, {
      submissionId,
      quantityUsed: detail.quantityUsed,
      quantityBefore: detail.quantityBefore,
      quantityAfter: detail.quantityAfter,
      // Then-current per-unit cost. Lets analytics value historical usage at
      // the price we paid at the time, not whatever the item costs today.
      ...(detail.unitCost > 0 ? { unitCost: detail.unitCost } : {}),
      ...(notes ? { notes } : {}),
      // Stamp location so per-station analytics filters can attribute this
      // event without having to look up the item's current location.
      ...(detail.locationId ? { locationId: detail.locationId } : {}),
      ...(detail.locationName ? { location: detail.locationName } : {}),
      snapshot: detail.snapshot,
    }));
  }
  await writeAuditEvents(storage.auditTable, auditEvents);

  return json(200, { ok: true, submissionId, entryCount: pendingEntries.length });
};

export const handleListPendingSubmissions = async (ctx: RouteContext) => {
  const { access, storage } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can review usage submissions." });
  }

  const result = await ddb.send(
    new ScanCommand({ TableName: storage.pendingTable }),
  );

  const submissions = ((result.Items ?? []) as PendingSubmission[])
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));

  return json(200, { submissions });
};

export const handleDeleteSubmission = async (ctx: RouteContext) => {
  const { access, storage, path } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can delete usage submissions." });
  }

  const match = path.match(/\/inventory\/usage\/pending\/([^/]+)$/);
  const submissionId = match?.[1];
  if (!submissionId) return json(400, { error: "Missing submission ID." });

  const res = await ddb.send(new GetCommand({ TableName: storage.pendingTable, Key: { id: submissionId } }));
  const submission = res.Item as PendingSubmission | undefined;
  if (!submission) return json(404, { error: "Submission not found." });

  await ddb.send(new DeleteCommand({ TableName: storage.pendingTable, Key: { id: submissionId } }));
  return json(200, { ok: true });
};

export const handleApproveSubmission = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can approve usage submissions." });
  }

  const match = path.match(/\/inventory\/usage\/pending\/([^/]+)\/approve$/);
  const submissionId = match?.[1];
  if (!submissionId) return json(400, { error: "Missing submission ID." });

  const res = await ddb.send(new GetCommand({ TableName: storage.pendingTable, Key: { id: submissionId } }));
  const submission = res.Item as PendingSubmission | undefined;
  if (!submission) return json(404, { error: "Submission not found." });
  if (submission.status !== "pending") {
    return json(409, { error: `Submission is already ${submission.status}.` });
  }

  // Accept optional override entries from the request body (for inline edits by reviewer)
  let pendingEntries: PendingEntry[] = [];
  const overrideEntries = Array.isArray(body?.entries) ? (body.entries as PendingEntry[]) : null;
  if (overrideEntries && overrideEntries.length > 0) {
    // Validate override entries to prevent injection of arbitrary data
    const validated: PendingEntry[] = [];
    for (const e of overrideEntries) {
      const itemId = String(e?.itemId ?? "").trim();
      const itemName = String(e?.itemName ?? "").trim();
      const quantityUsed = Number(e?.quantityUsed);
      if (!itemId || !itemName || !Number.isFinite(quantityUsed) || quantityUsed < 0) {
        return json(400, { error: `Invalid override entry for item "${itemName || itemId}".` });
      }
      validated.push({
        itemId,
        itemName,
        quantityUsed,
        notes: e?.notes ? String(e.notes).slice(0, 500) : undefined,
        location: e?.location ? String(e.location).slice(0, 200) : undefined,
      });
    }
    pendingEntries = validated;
  } else {
    try {
      pendingEntries = JSON.parse(submission.entriesJson) as PendingEntry[];
    } catch {
      return json(400, { error: "Submission data is corrupt." });
    }
  }

  const applyResult = await applyUsageEntries(storage, access, pendingEntries);
  if (applyResult.error) {
    return json(409, { error: applyResult.error });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: storage.pendingTable,
      Key: { id: submissionId },
      UpdateExpression: "SET #status = :status, reviewedAt = :reviewedAt, reviewedByUserId = :uid, reviewedByEmail = :email",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "approved",
        ":reviewedAt": new Date().toISOString(),
        ":uid": access.userId,
        ":email": access.email,
      },
    }),
  );

  // Write audit events for each item affected
  const auditEvents: Record<string, unknown>[] = [];
  for (const detail of applyResult.appliedDetails ?? []) {
    auditEvents.push(buildAuditEvent(access, "USAGE_APPROVE", detail.itemId, detail.itemName, {
      submissionId,
      submittedByEmail: submission.submittedByEmail,
      quantityUsed: detail.quantityUsed,
      quantityBefore: detail.quantityBefore,
      quantityAfter: detail.quantityAfter,
      // Then-current per-unit cost. Lets analytics value historical usage at
      // the price we paid at the time, not whatever the item costs today.
      ...(detail.unitCost > 0 ? { unitCost: detail.unitCost } : {}),
      // Stamp location for per-station analytics filters.
      ...(detail.locationId ? { locationId: detail.locationId } : {}),
      ...(detail.locationName ? { location: detail.locationName } : {}),
      snapshot: detail.snapshot,
    }));
  }
  await writeAuditEvents(storage.auditTable, auditEvents);

  return json(200, { ok: true, updatedCount: pendingEntries.length });
};

export const handleRejectSubmission = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can reject usage submissions." });
  }

  const match = path.match(/\/inventory\/usage\/pending\/([^/]+)\/reject$/);
  const submissionId = match?.[1];
  if (!submissionId) return json(400, { error: "Missing submission ID." });

  const res = await ddb.send(new GetCommand({ TableName: storage.pendingTable, Key: { id: submissionId } }));
  const submission = res.Item as PendingSubmission | undefined;
  if (!submission) return json(404, { error: "Submission not found." });
  if (submission.status !== "pending") {
    return json(409, { error: `Submission is already ${submission.status}.` });
  }

  const rejectionReason = String(body?.reason ?? "").trim();

  const updateExpr = rejectionReason
    ? "SET #status = :status, reviewedAt = :reviewedAt, reviewedByUserId = :uid, reviewedByEmail = :email, rejectionReason = :reason"
    : "SET #status = :status, reviewedAt = :reviewedAt, reviewedByUserId = :uid, reviewedByEmail = :email";
  const exprValues: Record<string, unknown> = {
    ":status": "rejected",
    ":reviewedAt": new Date().toISOString(),
    ":uid": access.userId,
    ":email": access.email,
  };
  if (rejectionReason) exprValues[":reason"] = rejectionReason;

  await ddb.send(
    new UpdateCommand({
      TableName: storage.pendingTable,
      Key: { id: submissionId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: exprValues,
    }),
  );

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "USAGE_REJECT", null, null, {
      submissionId,
      submittedByEmail: submission.submittedByEmail,
      reason: rejectionReason || undefined,
    }),
  ]);

  return json(200, { ok: true });
};

/**
 * Reverse a previous USAGE_APPROVE: re-add the decremented quantity to the
 * item, mark the original event as undone, and write a USAGE_UNDO event linked
 * back to it. The original event keeps its place in the feed; the Undo button
 * disappears once `details.undone` is set.
 *
 * Body: { eventId, itemId } — itemId is required because audit events are
 * partitioned by ITEM#<itemId>, so we'd otherwise have to scan to find the row.
 */
export const handleUndoUsage = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can undo usage events." });
  }

  const eventId = String(body?.eventId ?? "").trim();
  const itemId = String(body?.itemId ?? "").trim();
  if (!eventId || !itemId) {
    return json(400, { error: "eventId and itemId are required." });
  }

  // Locate the audit event by querying the item's history and matching eventId.
  // We can't Get by eventId directly — pk/sk are (ITEM#<id>, TS#<ts>#<short>).
  // findAuditEventByEventId paginates the partition; a naive Query with
  // Limit:1 + FilterExpression is broken because Limit applies before the
  // filter (you'd only see the matching event when it happens to be the first
  // item DynamoDB scans).
  const original = await findAuditEventByEventId(
    storage.auditTable,
    `ITEM#${itemId}`,
    eventId,
  );
  if (!original) return json(404, { error: "Usage event not found." });
  if (original.action !== "USAGE_APPROVE") {
    return json(400, { error: "Only usage events can be undone." });
  }
  if (original.undoneAt) {
    return json(409, { error: "This usage event has already been undone." });
  }

  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(original.detailsJson ?? "{}")); } catch { details = {}; }
  const quantityUsed = Number(details.quantityUsed ?? 0);
  if (!Number.isFinite(quantityUsed) || quantityUsed < 0) {
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
  const restoredQuantity = (Number.isFinite(currentQuantity) ? currentQuantity : 0) + quantityUsed;

  // Order matters: stamp the audit event first with a conditional check, then
  // restore the item quantity. If two undos race, only one wins the conditional
  // and only one quantity restore runs. (If the second step fails after the
  // first succeeds, the event is marked undone but quantity isn't restored —
  // rare, surfaces as an inventory diff, and the user can adjust manually.)
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
      return json(409, { error: "This usage event has already been undone." });
    }
    throw err;
  }

  // Re-add the quantity additively so concurrent restocks/usage between the
  // original decrement and the undo are preserved (we don't restore the exact
  // prior value, only the delta).
  const nextValues = { ...values, quantity: restoredQuantity };
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
    buildAuditEvent(access, "USAGE_UNDO", itemId, itemName, {
      undoneEventId: eventId,
      submissionId: details.submissionId,
      quantityRestored: quantityUsed,
      quantityBefore: currentQuantity,
      quantityAfter: restoredQuantity,
    }),
  ]);

  return json(200, { ok: true });
};
