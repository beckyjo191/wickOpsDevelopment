// ── Audit log handlers ──────────────────────────────────────────────────────

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken, encodeNextToken } from "../http";
import { AUDIT_BY_TIMESTAMP_INDEX, AUDIT_BY_USER_INDEX } from "../config";

// Machine-managed valuesJson keys. ITEM_EDIT events whose only changes are in
// this set are pure noise — the one-time parentItemId backfill or retire-row
// markers that the dedicated ITEM_RETIRE / RESTOCK_* events already cover.
// Kept in sync with the client filter in AuditLogPage.tsx.
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
]);

/** True when every value is an empty string, zero, or null/undefined. */
const isAllDefaultsValues = (vals: Record<string, unknown>): boolean => {
  const entries = Object.entries(vals);
  if (entries.length === 0) return true;
  return entries.every(([, v]) => v === null || v === undefined || v === "" || v === 0);
};

/**
 * True when the raw DynamoDB audit item is pure noise and shouldn't appear in
 * the feed — either a system-field-only ITEM_EDIT (parentItemId backfill, etc.)
 * or a blank-row ITEM_DELETE (a blank row cleaned up before it ever had content
 * is an accident, not activity). Filters it out before it takes up a pagination
 * slot.
 */
const isNoiseAuditItem = (item: Record<string, unknown>): boolean => {
  let details: { changes?: unknown; deletedValues?: unknown } = {};
  try {
    details = JSON.parse(String(item.detailsJson ?? "{}"));
  } catch {
    return false;
  }
  if (item.action === "ITEM_EDIT") {
    const rawChanges = Array.isArray(details.changes)
      ? (details.changes as Array<{ field: string }>)
      : [];
    if (rawChanges.length === 0) return false;
    return rawChanges.every((c) => SYSTEM_FIELDS.has(c.field));
  }
  if (item.action === "ITEM_DELETE") {
    const hasItemName = typeof item.itemName === "string" && String(item.itemName).trim().length > 0;
    if (hasItemName) return false;
    const deletedValues = (details.deletedValues && typeof details.deletedValues === "object")
      ? (details.deletedValues as Record<string, unknown>)
      : null;
    if (!deletedValues) return true;
    return isAllDefaultsValues(deletedValues);
  }
  return false;
};

export const handleAuditFeed = async (ctx: RouteContext) => {
  const { access, storage, query } = ctx;
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const startAfter = query.startAfter;
  const endBefore = query.endBefore;
  const actionFilter = query.action?.split(",").filter(Boolean);
  const userIdFilter = query.userId;
  const cursor = parseNextToken(query.cursor);

  // EDITORs can only see their own events
  const effectiveUserId = access.canManageColumns ? userIdFilter : access.userId;

  let keyCondition = "orgId = :orgId";
  const exprValues: Record<string, unknown> = { ":orgId": access.organizationId };
  const exprNames: Record<string, string> = {};

  if (startAfter && endBefore) {
    keyCondition += " AND #ts BETWEEN :start AND :end";
    exprValues[":start"] = startAfter;
    exprValues[":end"] = endBefore;
    exprNames["#ts"] = "timestamp";
  } else if (startAfter) {
    keyCondition += " AND #ts > :start";
    exprValues[":start"] = startAfter;
    exprNames["#ts"] = "timestamp";
  } else if (endBefore) {
    keyCondition += " AND #ts < :end";
    exprValues[":end"] = endBefore;
    exprNames["#ts"] = "timestamp";
  }

  // If filtering by user, query ByUser GSI instead
  const useUserIndex = !!effectiveUserId;
  if (useUserIndex) {
    keyCondition = "userId = :userId";
    exprValues[":userId"] = effectiveUserId;
    delete exprValues[":orgId"];
    if (startAfter && endBefore) {
      keyCondition += " AND #ts BETWEEN :start AND :end";
    } else if (startAfter) {
      keyCondition += " AND #ts > :start";
    } else if (endBefore) {
      keyCondition += " AND #ts < :end";
    }
  }

  let filterExpression: string | undefined;
  if (actionFilter && actionFilter.length > 0) {
    const placeholders = actionFilter.map((_, i) => `:act${i}`);
    filterExpression = `#action IN (${placeholders.join(", ")})`;
    exprNames["#action"] = "action";
    actionFilter.forEach((a, i) => {
      exprValues[`:act${i}`] = a;
    });
  }

  // For non-user-filtered queries where EDITOR, also filter by orgId
  if (useUserIndex && !access.canManageColumns) {
    const orgFilter = "orgId = :orgId";
    exprValues[":orgId"] = access.organizationId;
    filterExpression = filterExpression ? `${filterExpression} AND ${orgFilter}` : orgFilter;
  }

  // Paginate through DynamoDB, dropping noise events (system-field-only ITEM_EDIT
  // rows from the one-time parentItemId backfill), until we've collected `limit`
  // real events or run out of data. Without this loop, a page full of noise
  // returns almost nothing and forces the UI to click "Load more" repeatedly to
  // reach real history — which users read as "my history disappeared".
  const MAX_ROUND_TRIPS = 6;
  const collected: Array<Record<string, unknown>> = [];
  // The key identifying the last RAW item we consumed from DDB (noise or not).
  // This is what we hand back as the cursor when we stop mid-page: DDB will
  // resume the next query strictly after this point.
  let lastConsumedKey: Record<string, unknown> | null = null;
  let exclusiveStartKey = cursor;
  let hasMorePages = true;
  let roundTrips = 0;

  outer: while (collected.length < limit && roundTrips < MAX_ROUND_TRIPS) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.auditTable,
        IndexName: useUserIndex ? AUDIT_BY_USER_INDEX : AUDIT_BY_TIMESTAMP_INDEX,
        KeyConditionExpression: keyCondition,
        ...(filterExpression ? { FilterExpression: filterExpression } : {}),
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length > 0 ? { ExpressionAttributeNames: exprNames } : {}),
        ScanIndexForward: false,
        // Over-fetch so noise-heavy windows still fill the requested page.
        Limit: Math.min(limit * 2, 200),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    roundTrips += 1;
    const items = (page.Items ?? []) as Array<Record<string, unknown>>;

    for (const it of items) {
      // Track every item we've consumed so the cursor is exact, even if we
      // stop mid-page after skipping noise.
      lastConsumedKey = useUserIndex
        ? { userId: it.userId, timestamp: it.timestamp, pk: it.pk, sk: it.sk }
        : { orgId: it.orgId, timestamp: it.timestamp, pk: it.pk, sk: it.sk };
      if (!isNoiseAuditItem(it)) collected.push(it);
      if (collected.length >= limit) {
        hasMorePages = page.LastEvaluatedKey != null
          || items.indexOf(it) < items.length - 1;
        break outer;
      }
    }

    const nextKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!nextKey) {
      hasMorePages = false;
      break;
    }
    exclusiveStartKey = nextKey;
  }

  const events = collected.map((item) => ({
    eventId: item.eventId,
    action: item.action,
    timestamp: item.timestamp,
    userId: item.userId,
    userEmail: item.userEmail,
    userName: item.userName,
    itemId: item.itemId,
    itemName: item.itemName,
    details: JSON.parse(String(item.detailsJson ?? "{}")),
  }));

  const nextCursor = hasMorePages && lastConsumedKey
    ? encodeNextToken(lastConsumedKey)
    : null;

  return json(200, { events, nextCursor });
};

export const handleAuditItemHistory = async (ctx: RouteContext) => {
  const { access, storage, path, query } = ctx;
  const match = path.match(/\/inventory\/audit\/item\/([^/]+)$/);
  const itemId = match?.[1];
  if (!itemId) return json(400, { error: "Missing item ID." });

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const cursor = parseNextToken(query.cursor);

  // Same noise-filtering loop as the main feed — see handleAuditFeed for
  // rationale. Without it, an item with 50 parentItemId-backfill events in its
  // history would render an empty first page.
  const MAX_ROUND_TRIPS = 6;
  const collected: Array<Record<string, unknown>> = [];
  let lastConsumedKey: Record<string, unknown> | null = null;
  let exclusiveStartKey = cursor;
  let hasMorePages = true;
  let roundTrips = 0;

  outer: while (collected.length < limit && roundTrips < MAX_ROUND_TRIPS) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.auditTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ITEM#${itemId}` },
        ScanIndexForward: false,
        Limit: Math.min(limit * 2, 200),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    roundTrips += 1;
    const items = (page.Items ?? []) as Array<Record<string, unknown>>;
    for (const it of items) {
      lastConsumedKey = { pk: it.pk, sk: it.sk };
      if (!isNoiseAuditItem(it)) collected.push(it);
      if (collected.length >= limit) {
        hasMorePages = page.LastEvaluatedKey != null
          || items.indexOf(it) < items.length - 1;
        break outer;
      }
    }
    const nextKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!nextKey) { hasMorePages = false; break; }
    exclusiveStartKey = nextKey;
  }

  const events = collected.map((item) => ({
    eventId: item.eventId,
    action: item.action,
    timestamp: item.timestamp,
    userId: item.userId,
    userEmail: item.userEmail,
    userName: item.userName,
    itemId: item.itemId,
    itemName: item.itemName,
    details: JSON.parse(String(item.detailsJson ?? "{}")),
  }));

  const nextCursor = hasMorePages && lastConsumedKey
    ? encodeNextToken(lastConsumedKey)
    : null;

  return json(200, { events, nextCursor });
};

export const handleAuditAnalytics = async (ctx: RouteContext) => {
  const { access, storage, query } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can view analytics." });
  }

  const period = query.period ?? "30d";
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Fetch all audit events in the period (oldest → newest so the last-known
  // unit cost map can accumulate chronologically before ITEM_RETIRE events
  // consume it for loss valuation).
  let allEvents: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: storage.auditTable,
        IndexName: AUDIT_BY_TIMESTAMP_INDEX,
        KeyConditionExpression: "orgId = :orgId AND #ts >= :since",
        ExpressionAttributeValues: { ":orgId": access.organizationId, ":since": since },
        ExpressionAttributeNames: { "#ts": "timestamp" },
        ScanIndexForward: true,
        Limit: 1000,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    allEvents = allEvents.concat(result.Items ?? []);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey && allEvents.length < 10000);

  // Aggregation buckets. All group by parentItemId (fallback to itemId) so
  // multi-lot items roll up as one logical SKU in every view.
  const usageByDay = new Map<string, number>();
  const usageByItem = new Map<string, { itemName: string; qtyUsed: number }>();
  const vendorSpend = new Map<string, { spend: number; orderIds: Set<string>; restockCount: number }>();
  const itemSpend = new Map<string, { itemName: string; spend: number; qtyReceived: number }>();
  const lossByReason = new Map<string, { qty: number; value: number }>();
  /** itemKey → most recent unitCost seen so far (within period). Drives loss valuation. */
  const lastUnitCost = new Map<string, number>();

  let totalQtyUsed = 0;
  let totalSpend = 0;
  let totalLossQty = 0;
  let totalLossValue = 0;
  let restockQtyAll = 0;
  let donationQty = 0;

  for (const evt of allEvents) {
    const action = String(evt.action ?? "");
    const day = String(evt.timestamp ?? "").slice(0, 10);
    const itemId = String(evt.itemId ?? "");
    const itemName = String(evt.itemName ?? "");

    let details: Record<string, unknown> = {};
    try { details = JSON.parse(String(evt.detailsJson ?? "{}")); } catch { /* ignore */ }

    const parentItemId = typeof details.parentItemId === "string" && details.parentItemId.trim()
      ? String(details.parentItemId).trim()
      : itemId;
    const itemKey = parentItemId || itemName || itemId;
    if (!itemKey) continue;

    if (action === "USAGE_APPROVE") {
      const qty = Number(details.quantityUsed ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      totalQtyUsed += qty;
      usageByDay.set(day, (usageByDay.get(day) ?? 0) + qty);
      const bucket = usageByItem.get(itemKey) ?? { itemName, qtyUsed: 0 };
      bucket.qtyUsed += qty;
      if (!bucket.itemName && itemName) bucket.itemName = itemName;
      usageByItem.set(itemKey, bucket);
      continue;
    }

    if (action === "RESTOCK_RECEIVED" || action === "RESTOCK_ADDED") {
      // RESTOCK_ORDER_CREATE is intentionally skipped — it represents intent
      // to purchase. Actual spend is realized when the order is RECEIVED (or
      // when stock is fast-added outside the order flow). Counting both would
      // double-count the same restock.
      const qty = Number(
        action === "RESTOCK_RECEIVED" ? details.qtyReceived ?? 0 : details.qtyDelta ?? 0,
      );
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const unitCost = Number(details.unitCost ?? 0);
      const vendor = typeof details.vendor === "string" ? details.vendor.trim() : "";
      const source = typeof details.source === "string" ? details.source : "";
      const isDonation = source === "donation";

      restockQtyAll += qty;
      if (isDonation) donationQty += qty;

      // Remember the latest unit cost even for donations — it's useful for
      // loss valuation later (we still value a lost donated item at its
      // implied market price if we know it).
      if (Number.isFinite(unitCost) && unitCost > 0) {
        lastUnitCost.set(itemKey, unitCost);
      }

      // Donations don't contribute to spend totals, by definition.
      if (isDonation || !Number.isFinite(unitCost) || unitCost <= 0) continue;

      const spend = qty * unitCost;
      totalSpend += spend;

      if (vendor) {
        const v = vendorSpend.get(vendor)
          ?? { spend: 0, orderIds: new Set<string>(), restockCount: 0 };
        v.spend += spend;
        const orderId = typeof details.orderId === "string" ? details.orderId : "";
        if (orderId) v.orderIds.add(orderId);
        else v.restockCount += 1;
        vendorSpend.set(vendor, v);
      }

      const bucket = itemSpend.get(itemKey) ?? { itemName, spend: 0, qtyReceived: 0 };
      bucket.spend += spend;
      bucket.qtyReceived += qty;
      if (!bucket.itemName && itemName) bucket.itemName = itemName;
      itemSpend.set(itemKey, bucket);
      continue;
    }

    if (action === "ITEM_RETIRE") {
      const qty = Number(details.qty ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const reason = typeof details.reason === "string" ? details.reason : "unknown";
      const unitCost = lastUnitCost.get(itemKey) ?? 0;
      const value = qty * unitCost;
      totalLossQty += qty;
      totalLossValue += value;
      const bucket = lossByReason.get(reason) ?? { qty: 0, value: 0 };
      bucket.qty += qty;
      bucket.value += value;
      lossByReason.set(reason, bucket);
    }
  }

  const usageOverTime = [...usageByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, totalUsed]) => ({ date, totalUsed }));

  const byVendor = [...vendorSpend.entries()]
    .map(([vendor, v]) => ({
      vendor,
      spend: v.spend,
      orderCount: v.orderIds.size + v.restockCount,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const bySpendItem = [...itemSpend.values()]
    .map((v) => ({ itemName: v.itemName || "Unnamed item", spend: v.spend, qtyReceived: v.qtyReceived }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const byUsageItem = [...usageByItem.values()]
    .map((v) => ({ itemName: v.itemName || "Unnamed item", qtyUsed: v.qtyUsed }))
    .sort((a, b) => b.qtyUsed - a.qtyUsed)
    .slice(0, 10);

  const lossByReasonArr = [...lossByReason.entries()]
    .map(([reason, v]) => ({ reason, qty: v.qty, value: v.value }))
    .sort((a, b) => b.qty - a.qty);

  const donationPct = restockQtyAll > 0 ? (donationQty / restockQtyAll) * 100 : 0;

  return json(200, {
    period,
    days,
    totals: {
      qtyUsed: totalQtyUsed,
      spend: totalSpend,
      lossQty: totalLossQty,
      lossValue: totalLossValue,
      donationPct,
    },
    usageOverTime,
    byVendor,
    bySpendItem,
    byUsageItem,
    lossByReason: lossByReasonArr,
  });
};
