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
import { buildAuditEvent, writeAuditEvents } from "../audit";
import { listAllItems } from "../items";

export const applyUsageEntries = async (
  storage: InventoryStorage,
  access: AccessContext,
  pendingEntries: PendingEntry[],
): Promise<{ error?: string; appliedDetails?: Array<{ itemId: string; itemName: string; quantityUsed: number; quantityBefore: number; quantityAfter: number; snapshot: Record<string, unknown> }> }> => {
  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));

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
  const appliedDetails: Array<{ itemId: string; itemName: string; quantityUsed: number; quantityBefore: number; quantityAfter: number; snapshot: Record<string, unknown> }> = [];
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
      appliedDetails.push({
        itemId: entry.itemId,
        itemName: entry.itemName,
        quantityUsed: entry.quantityUsed,
        quantityBefore,
        quantityAfter: nextQuantity,
        snapshot: snap,
      });
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        return { error: `Item (${entry.itemName}): does not belong to organization.` };
      }
      throw err;
    }
  }
  return { appliedDetails };
};

export const handleSubmitUsage = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return json(400, { error: "At least one usage entry is required." });
  }

  // Validate and deduplicate entries
  const usageByItemId = new Map<string, { quantityUsed: number; notes?: string; location?: string }>();
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
    const location = String(entry?.location ?? "").trim();
    const notes = String(entry?.notes ?? "").trim();
    const existing = usageByItemId.get(itemId);
    if (!existing) {
      usageByItemId.set(itemId, { quantityUsed, notes: notes || undefined, location: location || undefined });
      continue;
    }
    if (existing.location && location && existing.location !== location) {
      return json(400, { error: `Entry ${i + 1}: conflicting locations for the same item.` });
    }
    existing.quantityUsed += quantityUsed;
    if (!existing.location && location) existing.location = location;
    usageByItemId.set(itemId, existing);
  }

  // Validate items exist and denormalize names for the pending record
  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));

  const pendingEntries: PendingEntry[] = [];
  const usageSnapshotMap = new Map<string, Record<string, unknown>>();
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
    const itemLocation = String(values.location ?? "").trim();
    if (entry.location && itemLocation && entry.location !== itemLocation) {
      return json(400, { error: `Entry ${itemCounter}: location does not match inventory.` });
    }
    const snap: Record<string, unknown> = {};
    if (values.quantity !== undefined && values.quantity !== null) snap.quantity = values.quantity;
    if (values.minQuantity !== undefined && values.minQuantity !== null) snap.minQuantity = values.minQuantity;
    if (values.expirationDate !== undefined && values.expirationDate !== null && values.expirationDate !== "") snap.expirationDate = values.expirationDate;
    usageSnapshotMap.set(itemId, snap);
    pendingEntries.push({
      itemId,
      itemName,
      quantityUsed: entry.quantityUsed,
      notes: entry.notes,
      location: entry.location,
    });
  }

  const submissionId = randomUUID();
  const submission: PendingSubmission = {
    id: submissionId,
    submittedAt: new Date().toISOString(),
    submittedByUserId: access.userId,
    submittedByEmail: access.email,
    submittedByName: access.displayName || access.email,
    status: "pending",
    entriesJson: JSON.stringify(pendingEntries),
  };

  await ddb.send(new PutCommand({ TableName: storage.pendingTable, Item: submission }));

  // Write per-item audit events so each item's history reflects the pending checkout
  const submitAuditEvents = pendingEntries.map((e) =>
    buildAuditEvent(access, "USAGE_SUBMIT", e.itemId, e.itemName, {
      submissionId,
      quantityUsed: e.quantityUsed,
      ...(e.notes ? { notes: e.notes } : {}),
      snapshot: usageSnapshotMap.get(e.itemId) ?? {},
    }),
  );
  await writeAuditEvents(storage.auditTable, submitAuditEvents);

  return json(200, { ok: true, pending: true, submissionId, entryCount: pendingEntries.length });
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
