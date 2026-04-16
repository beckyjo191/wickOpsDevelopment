// ── Route handlers: inventory ───────────────────────────────────────────────
import { BatchGetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { RetireReason, RouteContext } from "../types";
import { RETIRE_REASONS } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken } from "../http";
import { getParentItemId, listItemsPage, validateNonNegativeField } from "../items";
import { buildAuditEvent, writeAuditEvents, computeValuesDiff, hasProtectedHistory } from "../audit";

// Machine-managed fields in valuesJson. Changes to these shouldn't produce
// ITEM_EDIT audit events — they're either identity (parentItemId) or state
// already captured by a dedicated audit action (retire/restock).
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
]);

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

  // Delete guard: block deletion of items that have operational history (edits,
  // usage, restocks, retirements). Those must go through the retire flow so
  // their history stays attached to a surviving row.
  if (deletedRowIds.length > 0) {
    const protectionChecks = await Promise.all(
      deletedRowIds.map(async (id: string) => ({
        id,
        protected: await hasProtectedHistory(storage.auditTable, id),
      })),
    );
    const protectedRows = protectionChecks
      .filter((r) => r.protected)
      .map(({ id }) => ({
        id,
        itemName: String(oldValuesMap.get(id)?.itemName ?? "").trim() || `Item ${id.slice(0, 8)}`,
      }));
    if (protectedRows.length > 0) {
      return json(409, {
        error: "Some items have operational history and must be retired instead of deleted.",
        code: "DELETE_BLOCKED_HAS_HISTORY",
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
