// ── Route handlers: inventory ───────────────────────────────────────────────
import { BatchGetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken } from "../http";
import { listItemsPage, validateNonNegativeField } from "../items";
import { buildAuditEvent, writeAuditEvents, computeValuesDiff } from "../audit";

export const handleListItems = async (ctx: RouteContext) => {
  const { storage, access, query } = ctx;
  const limit = Math.min(Math.max(Number(query.limit ?? 500), 1), 10_000);
  const start = parseNextToken(query.nextToken);
  const page = await listItemsPage(storage, access.organizationId, limit, start);
  return json(200, page);
};

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

  // Batch-read existing rows for audit diff
  const allIds = [
    ...rows.map((r: any) => String(r?.id ?? "").trim()).filter((id: string) => id.length > 0),
    ...deletedRowIds,
  ];
  const oldValuesMap = new Map<string, Record<string, unknown>>();
  if (allIds.length > 0) {
    for (let i = 0; i < allIds.length; i += 100) {
      const chunk = allIds.slice(i, i + 100);
      try {
        const batchResult = await ddb.send(
          new BatchGetCommand({
            RequestItems: {
              [storage.itemTable]: {
                Keys: chunk.map((id: string) => ({ id })),
                ProjectionExpression: "id, valuesJson",
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
        }
      } catch {
        // Non-critical: audit diffs will be unavailable but save proceeds
      }
    }
  }

  const auditEvents: Record<string, unknown>[] = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const rowId = String(row?.id ?? "").trim() || randomUUID();
    const values = (row?.values ?? {}) as Record<string, unknown>;
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
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: rowId },
          ConditionExpression:
            "attribute_not_exists(id) OR (organizationId = :org AND #module = :module)",
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, updatedAtCustom = :updatedAtCustom, createdAt = if_not_exists(createdAt, :createdAt)",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":position": Number(row?.position ?? idx),
            ":values": JSON.stringify(values),
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

    /** True when every value is an empty string, zero, or null/undefined — i.e. a blank row. */
    const isAllDefaults = (vals: Record<string, unknown>): boolean =>
      Object.values(vals).every((v) => v === null || v === undefined || v === "" || v === 0);

    if (oldValues) {
      const changes = computeValuesDiff(oldValues, values as Record<string, unknown>);
      if (changes.length > 0) {
        // If old values were all defaults, this is the first meaningful edit —
        // treat it as the real "create" event with the actual item name.
        const action = isAllDefaults(oldValues) ? "ITEM_CREATE" as const : "ITEM_EDIT" as const;
        auditEvents.push(buildAuditEvent(access, action, rowId, itemName, action === "ITEM_CREATE"
          ? { initialValues: values, snapshot }
          : { changes, snapshot }));
      }
    } else {
      // Brand new row — only log creation if it has actual content
      if (!isAllDefaults(values as Record<string, unknown>)) {
        auditEvents.push(buildAuditEvent(access, "ITEM_CREATE", rowId, itemName, { initialValues: values, snapshot }));
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
        };
        if (m.unitCost !== undefined && m.unitCost !== null && m.unitCost !== "") {
          const uc = Number(m.unitCost);
          if (Number.isFinite(uc) && uc >= 0) meta.unitCost = uc;
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
      auditEvents.push(buildAuditEvent(access, "ITEM_DELETE", deletedId, deletedName, {
        deletedValues: oldValues ?? {},
      }));
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }

  await writeAuditEvents(storage.auditTable, auditEvents);
  return json(200, { ok: true });
};
