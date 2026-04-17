// ── Shared: audit.ts ────────────────────────────────────────────────────────
// Audit event building and writing helpers.

import { randomUUID } from "node:crypto";
import { BatchWriteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { AUDIT_TTL_DAYS } from "./config";
import type { AccessContext, AuditAction } from "./types";

/** Window for coalescing rapid-fire edits by the same user into one event. */
const COALESCE_WINDOW_MS = 5 * 60 * 1000;

export const buildAuditEvent = (
  access: AccessContext,
  action: AuditAction,
  itemId: string | null,
  itemName: string | null,
  details: Record<string, unknown>,
) => {
  const eventId = randomUUID();
  const timestamp = new Date().toISOString();
  const pk = itemId ? `ITEM#${itemId}` : `ORG#${access.organizationId}`;
  const sk = `TS#${timestamp}#${eventId.slice(-8)}`;
  const ttl = Math.floor(Date.now() / 1000) + AUDIT_TTL_DAYS * 86400;

  return {
    pk,
    sk,
    eventId,
    action,
    timestamp,
    orgId: access.organizationId,
    userId: access.userId,
    userEmail: access.email,
    userName: access.displayName || access.email,
    ...(itemId ? { itemId } : {}),
    ...(itemName ? { itemName } : {}),
    detailsJson: JSON.stringify(details),
    ttl,
  };
};

export const writeAuditEvents = async (
  auditTable: string,
  events: Record<string, unknown>[],
): Promise<void> => {
  if (events.length === 0) return;
  // BatchWriteItem supports max 25 items per call
  for (let i = 0; i < events.length; i += 25) {
    const batch = events.slice(i, i + 25);
    try {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [auditTable]: batch.map((item) => ({
              PutRequest: { Item: item },
            })),
          },
        }),
      );
    } catch (err: any) {
      console.error("audit write failed", err);
    }
  }
};

/** Normalize a value for comparison: treat null, undefined, and "" as equivalent
 *  empty values, and compare numbers numerically so 0 !== "0" doesn't trigger. */
const normalizeForDiff = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  return String(v);
};

export const computeValuesDiff = (
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>,
): Array<{ field: string; from: unknown; to: unknown }> => {
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  const allKeys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  for (const key of allKeys) {
    const oldVal = oldValues[key] ?? null;
    const newVal = newValues[key] ?? null;
    if (normalizeForDiff(oldVal) !== normalizeForDiff(newVal)) {
      changes.push({ field: key, from: oldVal, to: newVal });
    }
  }
  return changes;
};

/**
 * Extract a quantity/minQuantity/expirationDate snapshot from a values record.
 * Only includes keys that are present and non-empty.
 */
export const buildQuantitySnapshot = (values: Record<string, unknown>): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {};
  for (const key of ["quantity", "minQuantity", "expirationDate"] as const) {
    const val = values[key];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      snapshot[key] = val;
    }
  }
  return snapshot;
};

type Change = { field: string; from: unknown; to: unknown };

/**
 * Merge two change arrays from consecutive edits on the same item+user. Later
 * writes-to the same field collapse the intermediate (e.g. exp: "" → "0002-01"
 * followed by exp: "0002-01" → "2026-01-01" becomes exp: "" → "2026-01-01").
 * Fields that end up with from===to (user typed and reverted) are dropped.
 */
const mergeChanges = (older: Change[], newer: Change[]): Change[] => {
  const byField = new Map<string, Change>();
  for (const c of older) byField.set(c.field, { ...c });
  for (const c of newer) {
    const existing = byField.get(c.field);
    if (existing) {
      // Preserve the original `from` (start of the window) and adopt the new `to`.
      byField.set(c.field, { field: c.field, from: existing.from, to: c.to });
    } else {
      byField.set(c.field, { ...c });
    }
  }
  return [...byField.values()].filter((c) => normalizeForDiff(c.from) !== normalizeForDiff(c.to));
};

/**
 * Find the most recent audit event on this item by this user within the
 * coalesce window. Returns the raw DDB item or null.
 */
const findRecentEventForCoalesce = async (
  auditTable: string,
  itemId: string,
  userId: string,
  cutoffIso: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: auditTable,
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "userId = :userId AND #ts >= :cutoff",
        ExpressionAttributeNames: { "#ts": "timestamp" },
        ExpressionAttributeValues: {
          ":pk": `ITEM#${itemId}`,
          ":userId": userId,
          ":cutoff": cutoffIso,
        },
        ScanIndexForward: false,
        Limit: 5,
      }),
    );
    const items = (result.Items ?? []) as Array<Record<string, unknown>>;
    return items[0] ?? null;
  } catch (err) {
    console.error("findRecentEventForCoalesce failed", err);
    return null;
  }
};

/**
 * Write ITEM_CREATE / ITEM_EDIT audit events with coalescing: if the same user
 * edited the same item within COALESCE_WINDOW_MS, merge into the existing event
 * instead of creating a new one. Other event types (restock, retire, usage)
 * fall through to a plain write since they already carry distinct semantics.
 *
 * Shape: the event object passed in is the same shape buildAuditEvent returns.
 */
export const writeAuditEventsCoalesced = async (
  auditTable: string,
  events: Record<string, unknown>[],
): Promise<void> => {
  if (events.length === 0) return;
  const cutoffIso = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
  const passthrough: Record<string, unknown>[] = [];

  for (const event of events) {
    const action = event.action as AuditAction;
    const itemId = event.itemId as string | undefined;
    const userId = event.userId as string | undefined;
    const isCoalescible = (action === "ITEM_CREATE" || action === "ITEM_EDIT") && !!itemId && !!userId;
    if (!isCoalescible) {
      passthrough.push(event);
      continue;
    }

    const recent = await findRecentEventForCoalesce(auditTable, itemId!, userId!, cutoffIso);
    const recentAction = recent?.action as AuditAction | undefined;
    const canMerge = recent
      && (recentAction === "ITEM_CREATE" || recentAction === "ITEM_EDIT")
      // ITEM_CREATE absorbs subsequent ITEM_EDIT. ITEM_EDIT never upgrades to
      // ITEM_CREATE — once the create event exists we preserve its identity.
      && !(recentAction === "ITEM_EDIT" && action === "ITEM_CREATE");

    if (!canMerge || !recent) {
      passthrough.push(event);
      continue;
    }

    // Merge details into the recent event and UpdateItem in place.
    let recentDetails: Record<string, unknown> = {};
    try { recentDetails = JSON.parse(String(recent.detailsJson ?? "{}")); } catch { recentDetails = {}; }
    let newDetails: Record<string, unknown> = {};
    try { newDetails = JSON.parse(String(event.detailsJson ?? "{}")); } catch { newDetails = {}; }

    const mergedDetails: Record<string, unknown> = { ...recentDetails };

    if (recentAction === "ITEM_CREATE") {
      // Keep the CREATE semantic; merge snapshot/initialValues to the latest.
      // New event might be ITEM_EDIT with `changes` — apply those changes onto
      // the stored initialValues so the create event always reflects the
      // current end-state of the row.
      const prevInitial = (recentDetails.initialValues as Record<string, unknown>) ?? {};
      const newInitial = (newDetails.initialValues as Record<string, unknown>) ?? null;
      const newChanges = (newDetails.changes as Change[] | undefined) ?? [];
      const mergedInitial: Record<string, unknown> = newInitial ? { ...newInitial } : { ...prevInitial };
      if (!newInitial) {
        for (const c of newChanges) mergedInitial[c.field] = c.to;
      }
      mergedDetails.initialValues = mergedInitial;
      if (newDetails.snapshot) mergedDetails.snapshot = newDetails.snapshot;
    } else {
      // Both events are ITEM_EDIT: merge changes arrays.
      const prevChanges = (recentDetails.changes as Change[] | undefined) ?? [];
      const newChanges = (newDetails.changes as Change[] | undefined) ?? [];
      const merged = mergeChanges(prevChanges, newChanges);
      if (merged.length === 0) {
        // Net no-op after merge — skip writing entirely. The existing event
        // stays untouched (represents the last meaningful state).
        continue;
      }
      mergedDetails.changes = merged;
      if (newDetails.snapshot) mergedDetails.snapshot = newDetails.snapshot;
    }

    // Refresh itemName in case it was renamed, and bump timestamp so the feed
    // sorts the coalesced event at the user's most recent activity.
    const newItemName = event.itemName as string | undefined;
    const newTimestamp = event.timestamp as string;
    const newTtl = event.ttl as number;

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: auditTable,
          Key: { pk: recent.pk, sk: recent.sk },
          UpdateExpression: "SET detailsJson = :d, #ts = :ts, #tt = :ttl"
            + (newItemName ? ", itemName = :nm" : ""),
          ExpressionAttributeNames: {
            "#ts": "timestamp",
            "#tt": "ttl",
          },
          ExpressionAttributeValues: {
            ":d": JSON.stringify(mergedDetails),
            ":ts": newTimestamp,
            ":ttl": newTtl,
            ...(newItemName ? { ":nm": newItemName } : {}),
          },
        }),
      );
    } catch (err) {
      console.error("coalesce update failed, falling back to new write", err);
      passthrough.push(event);
    }
  }

  if (passthrough.length > 0) await writeAuditEvents(auditTable, passthrough);
};

/**
 * Returns true if the item has any audit event beyond ITEM_CREATE — meaning real
 * operational history (edits, usage, restocks, retirements). Such items must be
 * retired instead of deleted so their history stays attached.
 */
export const hasProtectedHistory = async (
  auditTable: string,
  itemId: string,
): Promise<boolean> => {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: auditTable,
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "#action <> :create",
        ExpressionAttributeNames: { "#action": "action" },
        ExpressionAttributeValues: {
          ":pk": `ITEM#${itemId}`,
          ":create": "ITEM_CREATE",
        },
        Limit: 1,
      }),
    );
    return (result.Items?.length ?? 0) > 0;
  } catch (err) {
    // Fail closed: if the audit table can't be queried, allow delete rather than
    // blocking the user indefinitely — the audit log still captures ITEM_DELETE.
    console.error("hasProtectedHistory query failed", err);
    return false;
  }
};
