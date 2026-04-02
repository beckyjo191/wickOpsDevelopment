// ── Shared: audit.ts ────────────────────────────────────────────────────────
// Audit event building and writing helpers.

import { randomUUID } from "node:crypto";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { AUDIT_TTL_DAYS } from "./config";
import type { AccessContext, AuditAction } from "./types";

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

export const computeValuesDiff = (
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>,
): Array<{ field: string; from: unknown; to: unknown }> => {
  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  const allKeys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
  for (const key of allKeys) {
    const oldVal = oldValues[key] ?? null;
    const newVal = newValues[key] ?? null;
    if (String(oldVal) !== String(newVal)) {
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
