// ── Column management handlers ──────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  InventoryColumn,
  InventoryColumnType,
  RouteContext,
} from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { CORE_KEYS, ENABLE_PER_ORG_TABLES } from "../config";
import { normalizeOrgId, toKey } from "../normalize";
import { buildAuditEvent, writeAuditEvents } from "../audit";
import { ensureColumns } from "../columns";
import { deleteStorageForOrganization } from "../storage";

export const handleCreateColumn = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const label = String(body?.label ?? "").trim();
  const type = String(body?.type ?? "text").trim() as InventoryColumnType;
  if (!label) return json(400, { error: "Column label is required" });
  if (!["text", "number", "date", "link", "boolean"].includes(type)) {
    return json(400, { error: "Invalid column type" });
  }

  const columns = await ensureColumns(access.organizationId);
  const baseKey = toKey(label) || "custom_column";
  let key = baseKey;
  let suffix = 2;
  while (columns.some((column) => column.key === key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  const lastColumn = columns.length > 0 ? columns[columns.length - 1] : undefined;
  const sortOrder = (lastColumn?.sortOrder ?? 0) + 10;
  const created: InventoryColumn = {
    id: randomUUID(),
    organizationId: access.organizationId,
    module: "inventory",
    key,
    label,
    type,
    isCore: false,
    isRequired: false,
    isVisible: true,
    isEditable: true,
    sortOrder,
    createdAt: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: created }));

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_CREATE", null, null, {
      columnId: created.id,
      columnKey: key,
      columnLabel: label,
      columnType: type,
    }),
  ]);

  return json(200, { column: created });
};

export const handleDeleteColumn = async (ctx: RouteContext) => {
  const { access, storage, path } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const columnRes = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isCore || CORE_KEYS.has(column.key)) {
    return json(400, { error: "Core columns cannot be deleted" });
  }

  await ddb.send(new DeleteCommand({ TableName: storage.columnTable, Key: { id: columnId } }));

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_DELETE", null, null, {
      columnId,
      columnKey: column.key,
      columnLabel: column.label,
      // Full row snapshot so the column can be recreated faithfully if the
      // user undoes the delete from the activity feed.
      columnSnapshot: column,
    }),
  ]);

  return json(200, { ok: true });
};

/**
 * Reverse a previous COLUMN_DELETE: recreates the column row from the snapshot
 * stamped on the original event. Per-row values for that column were never
 * scrubbed from items' valuesJson, so the data reappears automatically once
 * the column metadata is back.
 *
 * Body: { eventId } — column events live under ORG#<orgId> so we don't need
 * an extra partition hint. We rely on the audit row carrying the snapshot.
 *
 * Edge cases:
 *  - If a same-key column has been recreated since the delete, we 409.
 *  - Old delete events without `columnSnapshot` are recoverable using the
 *    stamped key/label/columnId (type/sortOrder fall back to defaults).
 */
export const handleRestoreColumn = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const eventId = String(body?.eventId ?? "").trim();
  if (!eventId) return json(400, { error: "eventId is required." });

  const queryRes = await ddb.send(
    new QueryCommand({
      TableName: storage.auditTable,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "eventId = :eid",
      ExpressionAttributeValues: { ":pk": `ORG#${access.organizationId}`, ":eid": eventId },
      Limit: 1,
    }),
  );
  const original = (queryRes.Items ?? [])[0] as Record<string, unknown> | undefined;
  if (!original) return json(404, { error: "Column delete event not found." });
  if (original.action !== "COLUMN_DELETE") {
    return json(400, { error: "Only column-delete events can be restored." });
  }
  if (original.undoneAt) {
    return json(409, { error: "This column has already been restored." });
  }

  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(original.detailsJson ?? "{}")); } catch { details = {}; }
  const snapshot = (details.columnSnapshot && typeof details.columnSnapshot === "object")
    ? (details.columnSnapshot as Partial<InventoryColumn>)
    : null;
  const columnId = String(snapshot?.id ?? details.columnId ?? "").trim();
  const key = String(snapshot?.key ?? details.columnKey ?? "").trim();
  const label = String(snapshot?.label ?? details.columnLabel ?? "").trim();
  if (!columnId || !key || !label) {
    return json(400, { error: "Original event is missing column metadata; cannot restore." });
  }

  // Reject restore if a column with the same key was recreated after the
  // original delete. Restoring would shadow the new column or steal its values.
  const existingColumns = await ensureColumns(access.organizationId);
  if (existingColumns.some((c) => c.key === key)) {
    return json(409, {
      error: `A column with the key "${key}" already exists. Rename or delete it before restoring this one.`,
    });
  }

  const restored: InventoryColumn = {
    id: columnId,
    organizationId: access.organizationId,
    module: "inventory",
    key,
    label,
    type: (snapshot?.type as InventoryColumnType | undefined) ?? "text",
    isCore: snapshot?.isCore ?? false,
    isRequired: snapshot?.isRequired ?? false,
    isVisible: snapshot?.isVisible ?? true,
    isEditable: snapshot?.isEditable ?? true,
    sortOrder: typeof snapshot?.sortOrder === "number"
      ? snapshot.sortOrder
      : (existingColumns[existingColumns.length - 1]?.sortOrder ?? 0) + 10,
    createdAt: typeof snapshot?.createdAt === "string" ? snapshot.createdAt : new Date().toISOString(),
  };

  await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: restored }));

  // Mark the original delete event as undone so the Undo button hides.
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
      return json(409, { error: "This column has already been restored." });
    }
    throw err;
  }

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_RESTORE", null, null, {
      undoneEventId: eventId,
      columnId,
      columnKey: key,
      columnLabel: label,
    }),
  ]);

  return json(200, { column: restored });
};

export const handleUpdateColumnVisibility = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)\/visibility$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const isVisible = body?.isVisible;
  if (typeof isVisible !== "boolean") {
    return json(400, { error: "isVisible boolean is required" });
  }

  const columnRes = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET isVisible = :isVisible",
      ExpressionAttributeValues: {
        ":isVisible": isVisible,
      },
    }),
  );

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_UPDATE", null, null, {
      columnId,
      columnKey: column.key,
      changeType: "visibility",
      from: column.isVisible,
      to: isVisible,
    }),
  ]);

  return json(200, { ok: true, columnId, isVisible });
};

export const handleUpdateColumnLabel = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)\/label$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const label = String(body?.label ?? "").trim();
  if (!label) {
    return json(400, { error: "Column label is required" });
  }

  const columnRes = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isRequired) {
    return json(400, { error: "Required columns cannot be renamed" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET #label = :label",
      ExpressionAttributeNames: {
        "#label": "label",
      },
      ExpressionAttributeValues: {
        ":label": label,
      },
    }),
  );

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_UPDATE", null, null, {
      columnId,
      columnKey: column.key,
      changeType: "label",
      from: column.label,
      to: label,
    }),
  ]);

  return json(200, { ok: true, columnId, label });
};

export const handleUpdateColumnType = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)\/type$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const type = String(body?.type ?? "").trim() as InventoryColumnType;
  if (!["text", "number", "date", "link", "boolean"].includes(type)) {
    return json(400, { error: "Invalid column type" });
  }

  const columnRes = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isCore) {
    return json(400, { error: "Core column type cannot be changed" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET #type = :type",
      ExpressionAttributeNames: {
        "#type": "type",
      },
      ExpressionAttributeValues: {
        ":type": type,
      },
    }),
  );

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "COLUMN_UPDATE", null, null, {
      columnId,
      columnKey: column.key,
      changeType: "type",
      from: column.type,
      to: type,
    }),
  ]);

  return json(200, { ok: true, columnId, type });
};

export const handleReorderColumns = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const columnOrder = body?.columnOrder;
  if (!Array.isArray(columnOrder) || columnOrder.length === 0) {
    return json(400, { error: "columnOrder must be a non-empty array of column IDs" });
  }
  if (!columnOrder.every((id: unknown) => typeof id === "string")) {
    return json(400, { error: "columnOrder must contain only string IDs" });
  }

  const existing = await ensureColumns(access.organizationId);
  const existingIds = new Set(existing.map((c) => c.id));
  const requestedIds = new Set(columnOrder as string[]);

  if (requestedIds.size !== columnOrder.length) {
    return json(400, { error: "columnOrder contains duplicate IDs" });
  }
  for (const id of columnOrder) {
    if (!existingIds.has(id)) {
      return json(400, { error: `Column ID not found: ${id}` });
    }
  }
  if (requestedIds.size !== existingIds.size) {
    return json(400, { error: "columnOrder must include all column IDs" });
  }

  await Promise.all(
    (columnOrder as string[]).map((id, index) =>
      ddb.send(
        new UpdateCommand({
          TableName: storage.columnTable,
          Key: { id },
          UpdateExpression: "SET sortOrder = :s",
          ExpressionAttributeValues: { ":s": (index + 1) * 10 },
        }),
      ),
    ),
  );

  return json(200, { ok: true });
};

export const handleDeleteOrganizationStorage = async (ctx: RouteContext) => {
  const { access, query } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can delete organization storage" });
  }
  if (!ENABLE_PER_ORG_TABLES) {
    return json(400, { error: "Per-organization table mode is disabled" });
  }
  if (String(query.confirm ?? "").toUpperCase() !== "DELETE") {
    return json(400, { error: "Missing confirmation. Use ?confirm=DELETE" });
  }

  await deleteStorageForOrganization(access.organizationId);
  return json(200, { ok: true });
};
