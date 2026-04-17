// ── Restock order handlers ──────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  RestockOrder,
  RestockOrderItem,
  RestockOrderStatus,
  RestockReceiveEvent,
  RestockReceiveLine,
  RouteContext,
} from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { buildAuditEvent, writeAuditEvents } from "../audit";
import { listAllItems } from "../items";

export const handleListRestockOrders = async (ctx: RouteContext) => {
  const { access, storage } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can view restock orders." });
  }

  const result = await ddb.send(
    new ScanCommand({
      TableName: storage.restockOrdersTable,
      FilterExpression: "orgId = :orgId",
      ExpressionAttributeValues: { ":orgId": access.organizationId },
    }),
  );

  const orders = (result.Items ?? []).map((item) => {
    let items: RestockOrderItem[] = [];
    let receives: RestockReceiveEvent[] = [];
    try { items = JSON.parse(String(item.itemsJson ?? "[]")); } catch { /* ignore */ }
    try { receives = JSON.parse(String(item.receivesJson ?? "[]")); } catch { /* ignore */ }
    return { ...(item as RestockOrder), items, receives };
  });

  // Sort: open first, then partial, then closed; within each group newest first
  const statusOrder: Record<RestockOrderStatus, number> = { open: 0, partial: 1, closed: 2 };
  orders.sort((a, b) => {
    const sd = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
    if (sd !== 0) return sd;
    return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
  });

  return json(200, { orders });
};

export const handleCreateRestockOrder = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can create restock orders." });
  }

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) {
    return json(400, { error: "At least one item is required." });
  }

  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));

  const orderItems: RestockOrderItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const entry = rawItems[i];
    const itemId = String(entry?.itemId ?? "").trim();
    const qtyOrdered = Number(entry?.qtyOrdered);
    if (!Number.isFinite(qtyOrdered) || qtyOrdered <= 0) {
      return json(400, { error: `Entry ${i + 1}: quantity must be greater than 0.` });
    }
    const unitCost = entry?.unitCost !== undefined && entry?.unitCost !== null && entry?.unitCost !== ""
      ? Number(entry.unitCost) : undefined;
    if (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) {
      return json(400, { error: `Entry ${i + 1}: unit cost must be a non-negative number.` });
    }

    if (!itemId) {
      // Freeform item — not yet in inventory
      const itemName = String(entry?.itemName ?? "").trim();
      if (!itemName) return json(400, { error: `Entry ${i + 1}: itemName is required for items not in inventory.` });
      const freeformId = `freeform-${randomUUID()}`;
      const reorderLink = String(entry?.reorderLink ?? "").trim() || undefined;
      const location = String(entry?.location ?? "").trim() || undefined;
      orderItems.push({
        itemId: freeformId,
        itemName,
        qtyOrdered,
        qtyReceived: 0,
        ...(unitCost !== undefined ? { unitCost } : {}),
        ...(reorderLink ? { reorderLink } : {}),
        ...(location ? { location } : {}),
      });
    } else {
      const item = byId.get(itemId);
      let itemName = String(entry?.itemName ?? "").trim();
      if (!itemName && item) {
        try {
          const vals = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, unknown>;
          itemName = String(vals.itemName ?? "").trim() || `Item ${itemId.slice(0, 8)}`;
        } catch { itemName = `Item ${itemId.slice(0, 8)}`; }
      }
      if (!itemName) itemName = `Item ${itemId.slice(0, 8)}`;
      orderItems.push({ itemId, itemName, qtyOrdered, qtyReceived: 0, ...(unitCost !== undefined ? { unitCost } : {}) });
    }
  }

  const orderId = randomUUID();
  const now = new Date().toISOString();
  const vendor = String(body?.vendor ?? "").trim() || undefined;
  const notes = String(body?.notes ?? "").trim() || undefined;

  const order: RestockOrder = {
    id: orderId,
    orgId: access.organizationId,
    status: "open",
    createdAt: now,
    createdByUserId: access.userId,
    createdByName: access.displayName || access.email,
    itemsJson: JSON.stringify(orderItems),
    receivesJson: JSON.stringify([]),
    ...(vendor ? { vendor } : {}),
    ...(notes ? { notes } : {}),
  };

  await ddb.send(new PutCommand({ TableName: storage.restockOrdersTable, Item: order }));

  // Audit: one event per item ordered. parentItemId lets phase 2 analytics
  // roll up cost/order history across lots sharing a logical item.
  const parentByItemId = new Map<string, string>();
  for (const item of items) {
    try {
      const vals = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, unknown>;
      const parent = typeof vals.parentItemId === "string" && vals.parentItemId.trim()
        ? String(vals.parentItemId).trim()
        : String(item.id);
      parentByItemId.set(String(item.id), parent);
    } catch {
      parentByItemId.set(String(item.id), String(item.id));
    }
  }
  const auditEvents = orderItems.map((oi) =>
    buildAuditEvent(access, "RESTOCK_ORDER_CREATE", oi.itemId, oi.itemName, {
      orderId,
      qtyOrdered: oi.qtyOrdered,
      parentItemId: parentByItemId.get(oi.itemId) ?? oi.itemId,
      ...(oi.unitCost !== undefined ? { unitCost: oi.unitCost } : {}),
      ...(vendor ? { vendor } : {}),
    }),
  );
  await writeAuditEvents(storage.auditTable, auditEvents);

  return json(200, { ok: true, orderId });
};

export const handleReceiveRestockOrder = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can receive restock orders." });
  }

  const orderId = path.split("/").at(-2) ?? "";
  const result = await ddb.send(new GetCommand({ TableName: storage.restockOrdersTable, Key: { id: orderId } }));
  if (!result.Item || result.Item.orgId !== access.organizationId) {
    return json(404, { error: "Restock order not found." });
  }
  const order = result.Item as RestockOrder;
  if (order.status === "closed") {
    return json(409, { error: "This order is already closed." });
  }

  let orderItems: RestockOrderItem[] = [];
  let receives: RestockReceiveEvent[] = [];
  try { orderItems = JSON.parse(String(order.itemsJson ?? "[]")); } catch { /* ignore */ }
  try { receives = JSON.parse(String(order.receivesJson ?? "[]")); } catch { /* ignore */ }

  const rawLines = Array.isArray(body?.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    return json(400, { error: "At least one receive line is required." });
  }
  const closeOrder = body?.closeOrder === true;

  const receiveLines: RestockReceiveLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const itemId = String(line?.itemId ?? "").trim();
    if (!itemId) return json(400, { error: `Line ${i + 1}: itemId is required.` });
    const orderItem = orderItems.find((oi) => oi.itemId === itemId);
    if (!orderItem) return json(400, { error: `Line ${i + 1}: item not found in order.` });
    const qtyThisReceive = Number(line?.qtyThisReceive);
    if (!Number.isFinite(qtyThisReceive) || qtyThisReceive <= 0) {
      return json(400, { error: `Line ${i + 1}: received quantity must be greater than 0.` });
    }
    const expirationDate = String(line?.expirationDate ?? "").trim() || undefined;
    const unitCost = line?.unitCost !== undefined && line?.unitCost !== null && line?.unitCost !== ""
      ? Number(line.unitCost) : undefined;
    if (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) {
      return json(400, { error: `Line ${i + 1}: unit cost must be a non-negative number.` });
    }
    const addToInventory = line?.addToInventory === true;
    receiveLines.push({ itemId, qtyThisReceive, ...(expirationDate ? { expirationDate } : {}), ...(unitCost !== undefined ? { unitCost } : {}), ...(addToInventory ? { addToInventory } : {}) });
  }

  // Update inventory quantities and expiration dates
  const allItems = await listAllItems(storage, access.organizationId);
  const byId = new Map(allItems.map((item) => [String(item.id), item]));
  const auditEvents: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  // Vendor captured at order time — propagates onto every RESTOCK_RECEIVED event
  // so phase 2 "spend by vendor" analytics can query audit alone.
  const orderVendor = typeof order.vendor === "string" && order.vendor.trim()
    ? String(order.vendor).trim()
    : undefined;

  for (const line of receiveLines) {
    const isFreeform = line.itemId.startsWith("freeform-");
    const orderItem = orderItems.find((oi) => oi.itemId === line.itemId)!;

    if (isFreeform) {
      orderItem.qtyReceived += line.qtyThisReceive;
      if (line.unitCost !== undefined) orderItem.unitCost = line.unitCost;

      if (line.addToInventory) {
        // Create a new inventory item from this freeform receive
        const newItemId = randomUUID();
        const newValues: Record<string, unknown> = {
          itemName: orderItem.itemName,
          quantity: line.qtyThisReceive,
          parentItemId: newItemId,
        };
        if (line.expirationDate) newValues.expirationDate = line.expirationDate;
        // Persist the vendor link captured at order time so future reorders
        // route the item back to the right vendor card automatically.
        if (orderItem.reorderLink) newValues.reorderLink = orderItem.reorderLink;
        // Persist location so location-filtered inventory views pick it up.
        if (orderItem.location) newValues.location = orderItem.location;
        // Cache the latest unit cost on the row so the (read-only) Unit Cost
        // column shows the most recent price paid. Authoritative history lives
        // in the RESTOCK_RECEIVED audit events.
        if (line.unitCost !== undefined) newValues.unitCost = line.unitCost;
        await ddb.send(new PutCommand({
          TableName: storage.itemTable,
          Item: {
            id: newItemId,
            organizationId: access.organizationId,
            module: "inventory",
            position: allItems.length + 1,
            valuesJson: JSON.stringify(newValues),
            createdAt: now,
            updatedAtCustom: now,
          },
        }));
        auditEvents.push(buildAuditEvent(access, "ITEM_CREATE", newItemId, orderItem.itemName, {
          orderId,
          source: "restock_receive",
          initialValues: newValues,
        }));
        // Update the order item to reference the real inventory ID
        orderItem.itemId = newItemId;
        auditEvents.push(buildAuditEvent(access, "RESTOCK_RECEIVED", newItemId, orderItem.itemName, {
          orderId,
          qtyReceived: line.qtyThisReceive,
          addedToInventory: true,
          parentItemId: newItemId,
          ...(line.expirationDate ? { expirationDate: line.expirationDate } : {}),
          ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
          ...(orderVendor ? { vendor: orderVendor } : {}),
        }));
      }
      continue;
    }

    const item = byId.get(line.itemId);
    if (!item) continue;
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(String(item.valuesJson ?? "{}")); } catch { /* ignore */ }
    const oldQty = Number(values.quantity ?? 0);
    const newQty = oldQty + line.qtyThisReceive;
    const nextValues: Record<string, unknown> = { ...values, quantity: newQty };
    if (line.expirationDate) nextValues.expirationDate = line.expirationDate;
    // Cache the latest unit cost on the row so the (read-only) Unit Cost
    // column shows the most recent price paid. Authoritative history lives in
    // the RESTOCK_RECEIVED audit events.
    if (line.unitCost !== undefined) nextValues.unitCost = line.unitCost;

    await ddb.send(new UpdateCommand({
      TableName: storage.itemTable,
      Key: { id: item.id },
      ConditionExpression: "organizationId = :org AND #module = :module",
      UpdateExpression: "SET valuesJson = :values, updatedAtCustom = :updatedAtCustom",
      ExpressionAttributeNames: { "#module": "module" },
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":module": "inventory",
        ":values": JSON.stringify(nextValues),
        ":updatedAtCustom": now,
      },
    }));

    orderItem.qtyReceived += line.qtyThisReceive;
    if (line.unitCost !== undefined) orderItem.unitCost = line.unitCost;

    const snapshot: Record<string, unknown> = { quantity: newQty };
    if (values.minQuantity !== undefined) snapshot.minQuantity = values.minQuantity;
    if (line.expirationDate) snapshot.expirationDate = line.expirationDate;
    const parentItemId = typeof values.parentItemId === "string" && values.parentItemId.trim()
      ? String(values.parentItemId).trim()
      : line.itemId;
    auditEvents.push(buildAuditEvent(access, "RESTOCK_RECEIVED", line.itemId, orderItem.itemName, {
      orderId,
      qtyReceived: line.qtyThisReceive,
      qtyBefore: oldQty,
      qtyAfter: newQty,
      parentItemId,
      ...(line.expirationDate ? { expirationDate: line.expirationDate } : {}),
      ...(line.unitCost !== undefined ? { unitCost: line.unitCost } : {}),
      ...(orderVendor ? { vendor: orderVendor } : {}),
      snapshot,
    }));
  }

  // Determine new order status
  const allFullyReceived = orderItems.every((oi) => oi.qtyReceived >= oi.qtyOrdered);
  const newStatus: RestockOrderStatus = closeOrder || allFullyReceived ? "closed" : "partial";

  const receiveEvent: RestockReceiveEvent = {
    receivedAt: now,
    receivedByUserId: access.userId,
    receivedByName: access.displayName || access.email,
    lines: receiveLines,
    closedOrder: newStatus === "closed",
  };
  receives.push(receiveEvent);

  const updateExpr = newStatus === "closed"
    ? "SET itemsJson = :items, receivesJson = :receives, #status = :status, closedAt = :closedAt, closedByUserId = :closedByUserId, closedByName = :closedByName"
    : "SET itemsJson = :items, receivesJson = :receives, #status = :status";
  const updateVals: Record<string, unknown> = {
    ":items": JSON.stringify(orderItems),
    ":receives": JSON.stringify(receives),
    ":status": newStatus,
  };
  if (newStatus === "closed") {
    updateVals[":closedAt"] = now;
    updateVals[":closedByUserId"] = access.userId;
    updateVals[":closedByName"] = access.displayName || access.email;
  }

  await ddb.send(new UpdateCommand({
    TableName: storage.restockOrdersTable,
    Key: { id: orderId },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: updateVals,
  }));

  // Only emit an explicit ORDER_CLOSED event when the close is user-driven
  // (a partial receive closed manually). A natural close from fully receiving
  // the order is already implied by the RESTOCK_RECEIVED events — emitting a
  // separate "Order closed" row here would be redundant noise in the feed.
  const closedManually = closeOrder && !allFullyReceived;
  if (newStatus === "closed" && closedManually) {
    auditEvents.push(buildAuditEvent(access, "RESTOCK_ORDER_CLOSED", null, null, {
      orderId,
      closedManually: true,
    }));
  }

  await writeAuditEvents(storage.auditTable, auditEvents);
  return json(200, { ok: true, status: newStatus });
};

export const handleCloseRestockOrder = async (ctx: RouteContext) => {
  const { access, storage, path, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can close restock orders." });
  }

  const orderId = path.split("/").at(-2) ?? "";
  const result = await ddb.send(new GetCommand({ TableName: storage.restockOrdersTable, Key: { id: orderId } }));
  if (!result.Item || result.Item.orgId !== access.organizationId) {
    return json(404, { error: "Restock order not found." });
  }
  if (result.Item.status === "closed") {
    return json(409, { error: "Order is already closed." });
  }

  // Optional cancellation note appended to existing notes (or set if empty).
  const rawNote = String(body?.note ?? "").trim();
  const existingNotes = String(result.Item.notes ?? "").trim();
  const nextNotes = rawNote
    ? (existingNotes ? `${existingNotes}\n${rawNote}` : rawNote)
    : existingNotes;

  const now = new Date().toISOString();
  const updateExpr = rawNote
    ? "SET #status = :status, closedAt = :closedAt, closedByUserId = :uid, closedByName = :name, notes = :notes"
    : "SET #status = :status, closedAt = :closedAt, closedByUserId = :uid, closedByName = :name";
  const updateVals: Record<string, unknown> = {
    ":status": "closed",
    ":closedAt": now,
    ":uid": access.userId,
    ":name": access.displayName || access.email,
  };
  if (rawNote) updateVals[":notes"] = nextNotes;

  await ddb.send(new UpdateCommand({
    TableName: storage.restockOrdersTable,
    Key: { id: orderId },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: updateVals,
  }));

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "RESTOCK_ORDER_CLOSED", null, null, {
      orderId,
      closedManually: true,
      ...(rawNote ? { note: rawNote } : {}),
    }),
  ]);

  return json(200, { ok: true });
};
