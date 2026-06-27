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
import { findLocationByName, createLocation } from "../locations";
import { listLocations } from "../columns";
import { upsertVendorPricingFromReceive } from "./vendor-pricing";
import {
  pricePerCanonical as deriveCanonicalPrice,
  dimensionForUnit,
  type Dimension,
} from "../uom";

/** 1h.7: route an order line's purchase amount + unit onto the dual-axis
 *  pack schema for the (item, vendor) pricing row.
 *
 *  An order line carries:
 *   - `purchaseAmount` + `purchaseUnit` — what the user typed at compose
 *     time ("2.5 lb beef" or "1 ct bag"). Optional.
 *   - `packSize` — set when composed in pack mode; means "this line is
 *     ordering N count of items as one pack".
 *
 *  Mapping rules:
 *   - count-dimension `purchaseUnit` ("ct", "dozen") → `packCount`. We
 *     fold the dozen into 12 ct so the pricing row is always in singles.
 *   - weight or volume `purchaseUnit` → `packAmount` + `packAmountUnit`.
 *   - legacy pack-mode (`packSize` set, no purchaseUnit) → `packCount`.
 *
 *  Returns a partial object spreadable into the upsert input. Caller
 *  layers `packCost`/`reorderUrl` separately. */
const mapPurchaseToPackAxes = (
  orderItem: { purchaseAmount?: number; purchaseUnit?: string; packSize?: number },
): { packCount?: number; packAmount?: number; packAmountUnit?: string } => {
  const out: { packCount?: number; packAmount?: number; packAmountUnit?: string } = {};
  const unit = (orderItem.purchaseUnit ?? "").trim().toLowerCase();
  const amount = orderItem.purchaseAmount;
  if (unit && amount !== undefined && Number.isFinite(amount) && amount > 0) {
    const dim = dimensionForUnit(unit);
    if (dim === "count") {
      // Normalize "dozen" → 12 ct so the count axis is always in singles.
      // Anything else in the count dimension stays as is (just "ct" today).
      out.packCount = unit === "dozen" ? amount * 12 : amount;
    } else if (dim === "weight" || dim === "volume") {
      out.packAmount = amount;
      out.packAmountUnit = unit;
    }
    // Unknown dimension: leave both axes unset; the row records cost only.
  }
  // Pack-mode legacy path: packSize alone (no purchaseUnit) means
  // "ordering one pack of N items". Treat that as packCount unless we
  // already set packCount above (purchaseUnit took precedence).
  if (out.packCount === undefined && orderItem.packSize !== undefined) {
    out.packCount = orderItem.packSize;
  }
  return out;
};

/** Parse + validate the amount/UoM/price triplet off a raw order entry. The
 *  dimension family (count|weight|volume) is *inferred* from the unit string
 *  via uom.ts — the client doesn't send it (1f). Server derives
 *  pricePerCanonical so client and server can never disagree on the math.
 *  Returns either { error } for the caller to surface, or { fields } to
 *  spread onto the order item. */
const parsePurchaseFields = (
  entry: Record<string, unknown> | undefined,
  idx: number,
): { error: string } | { fields: Partial<{
  purchaseAmount: number;
  purchaseUnit: string;
  purchasePrice: number;
  pricePerCanonical: number;
  dimension: Dimension;
}> } => {
  const rawAmount = entry?.purchaseAmount;
  const rawUnit = entry?.purchaseUnit;
  const rawPrice = entry?.purchasePrice;

  let purchaseAmount: number | undefined;
  if (rawAmount !== undefined && rawAmount !== null && rawAmount !== "") {
    purchaseAmount = Number(rawAmount);
    if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
      return { error: `Entry ${idx + 1}: purchase amount must be greater than 0.` };
    }
  }

  const purchaseUnit = typeof rawUnit === "string" ? rawUnit.trim() : "";

  let purchasePrice: number | undefined;
  if (rawPrice !== undefined && rawPrice !== null && rawPrice !== "") {
    purchasePrice = Number(rawPrice);
    if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
      return { error: `Entry ${idx + 1}: purchase price must be a non-negative number.` };
    }
  }

  // Infer dimension from the unit string — `unit` on the item is the single
  // source of truth post-1f. Unknown units (typed in error) get rejected
  // here so they can't poison the price-history view.
  let dimension: Dimension | undefined;
  if (purchaseUnit) {
    const inferred = dimensionForUnit(purchaseUnit);
    if (!inferred) {
      return { error: `Entry ${idx + 1}: unrecognized unit "${purchaseUnit}".` };
    }
    dimension = inferred;
  }

  let pricePerCanonical: number | undefined;
  if (purchaseAmount !== undefined && purchaseUnit && purchasePrice !== undefined) {
    const result = deriveCanonicalPrice(purchasePrice, purchaseAmount, purchaseUnit);
    if (!result) {
      return { error: `Entry ${idx + 1}: unrecognized unit "${purchaseUnit}".` };
    }
    pricePerCanonical = result.pricePerCanonical;
  }

  return {
    fields: {
      ...(purchaseAmount !== undefined ? { purchaseAmount } : {}),
      ...(purchaseUnit ? { purchaseUnit } : {}),
      ...(purchasePrice !== undefined ? { purchasePrice } : {}),
      ...(pricePerCanonical !== undefined ? { pricePerCanonical } : {}),
      ...(dimension ? { dimension } : {}),
    },
  };
};

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

    // 1b: parse optional amount/UoM/price triplet + dimension. Server derives
    // pricePerCanonical so client previews can't drift from persisted values.
    const purchaseParsed = parsePurchaseFields(entry as Record<string, unknown> | undefined, i);
    if ("error" in purchaseParsed) return json(400, { error: purchaseParsed.error });
    const purchaseFields = purchaseParsed.fields;

    if (!itemId) {
      // Freeform item — not yet in inventory
      const itemName = String(entry?.itemName ?? "").trim();
      if (!itemName) return json(400, { error: `Entry ${i + 1}: itemName is required for items not in inventory.` });
      const freeformId = `freeform-${randomUUID()}`;
      const reorderLink = String(entry?.reorderLink ?? "").trim() || undefined;
      // Prefer the structural locationId. Accept the legacy `location` name
      // for v0 client compat; the receive flow resolves it to an id later.
      const locationId = String(entry?.locationId ?? "").trim() || undefined;
      const location = String(entry?.location ?? "").trim() || undefined;
      const minQuantity = entry?.minQuantity !== undefined && entry?.minQuantity !== null && entry?.minQuantity !== ""
        ? Number(entry.minQuantity) : undefined;
      if (minQuantity !== undefined && (!Number.isFinite(minQuantity) || minQuantity < 0)) {
        return json(400, { error: `Entry ${i + 1}: minimum quantity must be a non-negative number.` });
      }
      const packSize = entry?.packSize !== undefined && entry?.packSize !== null && entry?.packSize !== ""
        ? Number(entry.packSize) : undefined;
      if (packSize !== undefined && (!Number.isFinite(packSize) || packSize <= 0)) {
        return json(400, { error: `Entry ${i + 1}: pack size must be greater than 0.` });
      }
      const packCost = entry?.packCost !== undefined && entry?.packCost !== null && entry?.packCost !== ""
        ? Number(entry.packCost) : undefined;
      if (packCost !== undefined && (!Number.isFinite(packCost) || packCost < 0)) {
        return json(400, { error: `Entry ${i + 1}: pack cost must be a non-negative number.` });
      }
      orderItems.push({
        itemId: freeformId,
        itemName,
        qtyOrdered,
        qtyReceived: 0,
        ...(unitCost !== undefined ? { unitCost } : {}),
        ...(reorderLink ? { reorderLink } : {}),
        ...(locationId ? { locationId } : {}),
        ...(location ? { location } : {}),
        ...(minQuantity !== undefined ? { minQuantity } : {}),
        ...(packSize !== undefined ? { packSize } : {}),
        ...(packCost !== undefined ? { packCost } : {}),
        ...purchaseFields,
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

      // Existing-item path also accepts pack/cost/link enrichment so the
      // order line carries the same metadata as freeform items, AND so we
      // can write any provided values back to the inventory row below.
      const reorderLinkExisting = String(entry?.reorderLink ?? "").trim() || undefined;
      const packSizeExisting = entry?.packSize !== undefined && entry?.packSize !== null && entry?.packSize !== ""
        ? Number(entry.packSize) : undefined;
      if (packSizeExisting !== undefined && (!Number.isFinite(packSizeExisting) || packSizeExisting <= 0)) {
        return json(400, { error: `Entry ${i + 1}: pack size must be greater than 0.` });
      }
      const packCostExisting = entry?.packCost !== undefined && entry?.packCost !== null && entry?.packCost !== ""
        ? Number(entry.packCost) : undefined;
      if (packCostExisting !== undefined && (!Number.isFinite(packCostExisting) || packCostExisting < 0)) {
        return json(400, { error: `Entry ${i + 1}: pack cost must be a non-negative number.` });
      }

      orderItems.push({
        itemId,
        itemName,
        qtyOrdered,
        qtyReceived: 0,
        ...(unitCost !== undefined ? { unitCost } : {}),
        ...(reorderLinkExisting ? { reorderLink: reorderLinkExisting } : {}),
        ...(packSizeExisting !== undefined ? { packSize: packSizeExisting } : {}),
        ...(packCostExisting !== undefined ? { packCost: packCostExisting } : {}),
        ...purchaseFields,
      });
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

  // Write the order line's pricing + reorder link back to the inventory row
  // for any existing item that carried provided values. Fills in missing
  // pricing for items that didn't have a unitCost/packCost yet so future
  // analytics see the up-to-date figures, and lets users correct stale
  // pricing when placing the next order. Only writes fields the user
  // actually supplied — empty fields don't clobber existing data.
  for (const oi of orderItems) {
    if (!oi.itemId || oi.itemId.startsWith("freeform-")) continue;
    const existing = byId.get(oi.itemId);
    if (!existing) continue;
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(String(existing.valuesJson ?? "{}")); } catch { /* ignore */ }
    const patch: Record<string, unknown> = {};
    if (oi.unitCost !== undefined) patch.unitCost = oi.unitCost;
    if (oi.packSize !== undefined) patch.packSize = oi.packSize;
    if (oi.packCost !== undefined) patch.packCost = oi.packCost;
    if (oi.reorderLink) patch.reorderLink = oi.reorderLink;
    if (Object.keys(patch).length === 0) continue;
    const nextValues = { ...values, ...patch };
    try {
      await ddb.send(new UpdateCommand({
        TableName: storage.itemTable,
        Key: { id: oi.itemId },
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
    } catch {
      // Non-critical: if write-back fails the order still records correctly.
      // The user can retry by editing the item directly. Don't surface as
      // a 500 because the order create itself succeeded.
    }
  }

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
    receiveLines.push({
      itemId,
      qtyThisReceive,
      ...(expirationDate ? { expirationDate } : {}),
      ...(unitCost !== undefined ? { unitCost } : {}),
      ...(addToInventory ? { addToInventory } : {}),
    });
  }

  // Update inventory quantities and expiration dates
  const allItems = await listAllItems(storage, access.organizationId);
  const byId = new Map(allItems.map((item) => [String(item.id), item]));
  const auditEvents: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  /** Per-line diagnostic of what the receive actually did. Returned to the
   *  client so symptoms like "qty didn't go up" can be debugged from the
   *  browser console without trawling CloudWatch. */
  const receiveTrace: Array<{
    itemId: string;
    path: "freeform-create" | "freeform-skip" | "update" | "skip-not-found";
    oldQty?: number;
    newQty?: number;
    qtyAdded: number;
  }> = [];
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
      receiveTrace.push({
        itemId: line.itemId,
        path: line.addToInventory ? "freeform-create" : "freeform-skip",
        qtyAdded: line.addToInventory ? line.qtyThisReceive : 0,
      });

      if (line.addToInventory) {
        // Resolve the structural locationId for the new inventory row.
        // Order item carries `locationId` (v1+) or legacy `location` (v0).
        // For legacy: look up by name; if missing, create the location on the
        // fly so we never block a receive on a typo. Falls back to the first
        // available location when both fields are absent (rare but possible
        // on a free-text row that didn't capture either).
        let resolvedLocationId: string;
        if (orderItem.locationId) {
          resolvedLocationId = orderItem.locationId;
        } else if (orderItem.location) {
          const existing = await findLocationByName(storage, orderItem.location);
          if (existing) {
            resolvedLocationId = existing.id;
          } else {
            const all = await listLocations(storage);
            const sortOrder = all.length > 0 ? Math.max(...all.map((l) => l.sortOrder ?? 0)) + 10 : 10;
            const created = await createLocation(storage, access.organizationId, orderItem.location, sortOrder);
            resolvedLocationId = created.id;
          }
        } else {
          const all = await listLocations(storage);
          if (all.length === 0) {
            return json(400, { error: "No locations exist; cannot materialize freeform item." });
          }
          resolvedLocationId = all[0].id;
        }

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
        // Cache the latest unit cost on the row so the (read-only) Unit Cost
        // column shows the most recent price paid. Authoritative history lives
        // in the RESTOCK_RECEIVED audit events.
        if (line.unitCost !== undefined) newValues.unitCost = line.unitCost;
        // Persist the reorder threshold the user entered at add-item time so
        // future reorder logic triggers correctly. Without this the new row
        // would never surface as low stock regardless of quantity consumed.
        if (orderItem.minQuantity !== undefined) newValues.minQuantity = orderItem.minQuantity;
        // Pack size + pack cost enable box-mode receiving and unit-cost
        // derivation on future restocks.
        if (orderItem.packSize !== undefined) newValues.packSize = orderItem.packSize;
        if (orderItem.packCost !== undefined) newValues.packCost = orderItem.packCost;
        await ddb.send(new PutCommand({
          TableName: storage.itemTable,
          Item: {
            id: newItemId,
            organizationId: access.organizationId,
            module: "inventory",
            position: allItems.length + 1,
            locationId: resolvedLocationId,
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

        // 1g.5 → 1h.7: cache the (item, vendor) pricing on the new
        // vendorPricing row so the i modal + Shop read latest data
        // without re-walking receipts. Last-write-wins (receipt is
        // newer than any user edit). Best-effort — receipt completes
        // regardless.
        //
        // Map the order line's `purchaseUnit` onto the dual-axis schema:
        //   - count units (ct/dozen) → `packCount`
        //   - weight or volume units → `packAmount` + `packAmountUnit`
        // packSize is the legacy "items per pack" field; when set it
        // means the user composed the order in pack mode and the
        // packSize is the pack's count. We forward it as packCount to
        // avoid losing that data on receive.
        if (orderVendor) {
          // 1h.8: freeform-new path seeds the vendor pricing row from
          // the order item's snapshot — that's the only path that
          // creates a new pricing row on receive. Pack-shape edits to
          // existing items happen via the i modal, not receive.
          const upsert = mapPurchaseToPackAxes(orderItem);
          await upsertVendorPricingFromReceive(storage, access, {
            itemId: newItemId,
            vendor: orderVendor,
            ...upsert,
            ...(orderItem.packCost !== undefined ? { packCost: orderItem.packCost } : {}),
            ...(orderItem.reorderLink ? { reorderUrl: orderItem.reorderLink } : {}),
          });
        }
      }
      continue;
    }

    const item = byId.get(line.itemId);
    if (!item) {
      // Order was created against this id, but the row no longer exists.
      // Most likely cause: the row was deleted between order and receive,
      // OR the order is from before the v1 migration and references a stale
      // id. Either way, log loudly so we can diagnose — silently skipping
      // looked successful to the user but never updated stock.
      console.warn(
        `restock receive: line.itemId=${line.itemId} not found in items table; skipping.` +
        ` Order=${orderId}, qty=${line.qtyThisReceive}.` +
        ` This typically means the inventory row was deleted between order and receive.`,
      );
      receiveTrace.push({
        itemId: line.itemId,
        path: "skip-not-found",
        qtyAdded: 0,
      });
      continue;
    }
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
    // Receiving stock against an item clears its "ordered" state. Without
    // this, a row that had orderedAt set when it was placed on order keeps
    // the marker after stock arrives, and the row stays hidden from the
    // reorder list even if the user already burned through the new stock.
    // Conversely, the user reported items reappearing on reorder after
    // receive — the most-likely explanation is the marker was cleared by
    // some other path (manual edit, autosave) and we never re-set it. Either
    // way, "stock just arrived" is the right moment to reset the ordered
    // state explicitly.
    delete nextValues.orderedAt;
    delete nextValues.reorderCheckedAt;

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
    receiveTrace.push({
      itemId: line.itemId,
      path: "update",
      oldQty,
      newQty,
      qtyAdded: line.qtyThisReceive,
    });

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

    // 1g.5 → 1h.8: refresh the (item, vendor) pricing row's
    // *price-history-related* fields from this receipt. We
    // intentionally DO NOT write packCount/packAmount back here —
    // those describe how the vendor sells, which is owned by the i
    // modal. Receive only updates packCost (the receipt's actual
    // total) and reorderUrl from the order line, leaving the pack
    // shape alone. If the user wants to record a different pack
    // count, they edit it in the modal (mid-receive even).
    if (orderVendor) {
      await upsertVendorPricingFromReceive(storage, access, {
        itemId: line.itemId,
        vendor: orderVendor,
        ...(orderItem.packCost !== undefined ? { packCost: orderItem.packCost } : {}),
        ...(orderItem.reorderLink ? { reorderUrl: orderItem.reorderLink } : {}),
      });
    }
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
      ...(orderVendor ? { vendor: orderVendor } : {}),
    }));
  }

  await writeAuditEvents(storage.auditTable, auditEvents);
  return json(200, { ok: true, status: newStatus, receiveTrace });
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

  const orderVendor = typeof result.Item.vendor === "string" && result.Item.vendor.trim()
    ? String(result.Item.vendor).trim()
    : "";

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

  // Clear the "ordered" marker on every inventory row this order placed, so a
  // closed/cancelled order's items rejoin the reorder list and stop showing the
  // "Ordered" pill. The receive flow already clears this per line; doing it here
  // makes close/cancel authoritative instead of relying on the client cleanup
  // (which could silently fail or race). Freeform items have no row yet — the
  // client materializes those separately. Best-effort per row: a single failure
  // must not fail the close.
  let closedItems: Array<{ itemId?: string }> = [];
  try { closedItems = JSON.parse(String(result.Item.itemsJson ?? "[]")) ?? []; } catch { /* ignore */ }
  const affectedRowIds = Array.from(new Set(
    closedItems
      .map((oi) => String(oi?.itemId ?? "").trim())
      .filter((id) => id && !id.startsWith("freeform-")),
  ));
  await Promise.all(affectedRowIds.map(async (rowId) => {
    try {
      const got = await ddb.send(new GetCommand({ TableName: storage.itemTable, Key: { id: rowId } }));
      if (!got.Item || got.Item.organizationId !== access.organizationId) return;
      let values: Record<string, unknown> = {};
      try { values = JSON.parse(String(got.Item.valuesJson ?? "{}")) ?? {}; } catch { return; }
      if (values.orderedAt === undefined && values.reorderCheckedAt === undefined) return;
      delete values.orderedAt;
      delete values.reorderCheckedAt;
      await ddb.send(new UpdateCommand({
        TableName: storage.itemTable,
        Key: { id: rowId },
        ConditionExpression: "organizationId = :org AND #module = :module",
        UpdateExpression: "SET valuesJson = :values, updatedAtCustom = :now",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":module": "inventory",
          ":values": JSON.stringify(values),
          ":now": now,
        },
      }));
    } catch { /* best-effort; never fail the close on a single row */ }
  }));

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "RESTOCK_ORDER_CLOSED", null, null, {
      orderId,
      closedManually: true,
      ...(orderVendor ? { vendor: orderVendor } : {}),
      ...(rawNote ? { note: rawNote } : {}),
    }),
  ]);

  return json(200, { ok: true });
};
