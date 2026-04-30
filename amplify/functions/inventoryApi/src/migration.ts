// ── Migration: v0 → v1 (DDB wrapper) ────────────────────────────────────────
// Pure planner logic lives in migration-planner.ts (so the test file can
// `node --test` it without bundling AWS SDK code). This file is the thin
// DynamoDB-bound wrapper that:
//   1. Reads a "world" snapshot from DDB
//   2. Calls planMigration
//   3. Applies the resulting writes
//
// See docs/RESTRUCTURE_SPEC.md §4 for the full migration story.

import { randomUUID } from "node:crypto";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { INVENTORY_COLUMN_BY_MODULE_INDEX } from "./config";
import { listAllItems } from "./items";
import { writeAuditEvents, buildAuditEvent } from "./audit";
import {
  planMigration,
  TARGET_MIGRATION_VERSION,
  MIGRATION_META_ID,
  LEGACY_LOCATIONS_REGISTRY_ID,
  DEFAULT_LOCATION_NAME,
  type ColumnTableRow,
  type ItemTableRow,
  type MigrationPlan,
} from "./migration-planner.js";
import type { AccessContext, InventoryStorage } from "./types";

export {
  TARGET_MIGRATION_VERSION,
  MIGRATION_META_ID,
  LEGACY_LOCATIONS_REGISTRY_ID,
  DEFAULT_LOCATION_NAME,
  planMigration,
};
export type { ColumnTableRow, ItemTableRow, MigrationPlan };

/** Read the migration meta row to determine the org's current schema version. */
export const getMigrationVersion = async (storage: InventoryStorage): Promise<number> => {
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: storage.columnTable, Key: { id: MIGRATION_META_ID } }),
    );
    const v = result.Item?.migrationVersion;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

const readAllColumnTableRows = async (storage: InventoryStorage): Promise<ColumnTableRow[]> => {
  const out: ColumnTableRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.columnTable,
        IndexName: INVENTORY_COLUMN_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(...((page.Items ?? []) as ColumnTableRow[]));
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  // The legacy meta singleton may predate the GSI hash key (`module`), so the
  // GSI query above could miss it. Direct GetCommand catches that case.
  if (!out.find((r) => r.id === LEGACY_LOCATIONS_REGISTRY_ID)) {
    try {
      const direct = await ddb.send(
        new GetCommand({
          TableName: storage.columnTable,
          Key: { id: LEGACY_LOCATIONS_REGISTRY_ID },
        }),
      );
      if (direct.Item) out.push(direct.Item as ColumnTableRow);
    } catch { /* ignore */ }
  }
  return out;
};

/** Apply a migration plan to DynamoDB. Each individual write is idempotent
 *  via primary key, so the aggregate is safe to retry on failure. */
const applyPlan = async (
  storage: InventoryStorage,
  plan: MigrationPlan,
  access: AccessContext,
): Promise<void> => {
  // Whole-row writes (new columns, locations, kind-stamped legacy rows, meta).
  for (let i = 0; i < plan.rowWrites.length; i += 25) {
    const chunk = plan.rowWrites.slice(i, i + 25);
    if (chunk.length === 0) break;
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [storage.columnTable]: chunk.map((row) => ({ PutRequest: { Item: row } })),
        },
      }),
    );
  }

  // Column patches.
  for (const patch of plan.columnPatches) {
    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    if (patch.isCore !== undefined) {
      sets.push("isCore = :isCore");
      values[":isCore"] = patch.isCore;
    }
    if (patch.isGroupable !== undefined) {
      sets.push("isGroupable = :isGroupable");
      values[":isGroupable"] = patch.isGroupable;
    }
    if (patch.attachedLocationIds !== undefined) {
      sets.push("attachedLocationIds = :att");
      values[":att"] = patch.attachedLocationIds;
    }
    if (patch.kind !== undefined) {
      sets.push("#kind = :kind");
      names["#kind"] = "kind";
      values[":kind"] = patch.kind;
    }
    if (sets.length === 0) continue;
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.columnTable,
          Key: { id: patch.id },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      console.warn(`migration: failed to patch column ${patch.id}`, err);
    }
  }

  // Column deletes (the legacy `inventory-core-location` row).
  for (const id of plan.columnDeletes) {
    try {
      await ddb.send(new DeleteCommand({ TableName: storage.columnTable, Key: { id } }));
    } catch (err) {
      console.warn(`migration: failed to delete column ${id}`, err);
    }
  }

  // Item patches.
  for (const patch of plan.itemPatches) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: patch.id },
          UpdateExpression: "SET locationId = :lid, valuesJson = :vj, updatedAtCustom = :now",
          ExpressionAttributeValues: {
            ":lid": patch.locationId,
            ":vj": patch.nextValuesJson,
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      console.warn(`migration: failed to patch item ${patch.id}`, err);
    }
  }

  // Audit events.
  if (plan.auditEvents.length > 0) {
    const built = plan.auditEvents.map((stub) =>
      buildAuditEvent(access, stub.action, stub.itemId, stub.itemName, stub.details),
    );
    await writeAuditEvents(storage.auditTable, built);
  }
};

/**
 * Top-level entry point. Idempotent; cheap on the warm path (one GetCommand).
 */
export const ensureSchemaUpToDate = async (
  storage: InventoryStorage,
  access: AccessContext,
): Promise<{ ranMigration: boolean; toastMessage: string | null }> => {
  const currentVersion = await getMigrationVersion(storage);
  if (currentVersion >= TARGET_MIGRATION_VERSION) {
    return { ranMigration: false, toastMessage: null };
  }

  const [columnTableRows, items] = await Promise.all([
    readAllColumnTableRows(storage),
    listAllItems(storage, access.organizationId),
  ]);
  const itemRows: ItemTableRow[] = items.map((item) => ({
    id: String(item.id),
    valuesJson: String(item.valuesJson ?? "{}"),
    locationId: typeof (item as { locationId?: string }).locationId === "string"
      ? String((item as { locationId?: string }).locationId)
      : undefined,
    position: Number(item.position ?? 0),
    createdAt: item.createdAt,
    updatedAtCustom: item.updatedAtCustom,
  }));

  const plan = planMigration(
    {
      organizationId: access.organizationId,
      migrationVersion: currentVersion,
      columnTableRows,
      itemRows,
    },
    {
      now: () => new Date().toISOString(),
      uuid: () => randomUUID(),
    },
  );

  if (plan.reason === "already-migrated") {
    return { ranMigration: false, toastMessage: null };
  }

  await applyPlan(storage, plan, access);
  return { ranMigration: true, toastMessage: plan.toastMessage };
};
