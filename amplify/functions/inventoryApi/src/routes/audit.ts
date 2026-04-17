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

  // Fetch all audit events in the time range
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

  // Usage over time: group USAGE_APPROVE events by day
  const usageByDay = new Map<string, number>();
  // User comparison: count events per user
  const userActivity = new Map<string, { email: string; name: string; edits: number; approvals: number; submissions: number }>();
  // Top items: count changes per item
  const itemActivity = new Map<string, { itemName: string; changeCount: number; totalUsed: number }>();

  for (const evt of allEvents) {
    const action = String(evt.action ?? "");
    const day = String(evt.timestamp ?? "").slice(0, 10);
    const userId = String(evt.userId ?? "");
    const itemId = String(evt.itemId ?? "");
    const itemName = String(evt.itemName ?? "");

    // User activity tracking
    if (!userActivity.has(userId)) {
      userActivity.set(userId, {
        email: String(evt.userEmail ?? ""),
        name: String(evt.userName ?? ""),
        edits: 0,
        approvals: 0,
        submissions: 0,
      });
    }
    const ua = userActivity.get(userId)!;

    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(String(evt.detailsJson ?? "{}"));
    } catch { /* ignore */ }

    if (action === "USAGE_APPROVE") {
      const qtyUsed = Number(details.quantityUsed ?? 0);
      usageByDay.set(day, (usageByDay.get(day) ?? 0) + qtyUsed);
      ua.approvals += 1;
      if (itemId) {
        const ia = itemActivity.get(itemId) ?? { itemName, changeCount: 0, totalUsed: 0 };
        ia.totalUsed += qtyUsed;
        ia.changeCount += 1;
        itemActivity.set(itemId, ia);
      }
    } else if (action === "ITEM_EDIT") {
      ua.edits += 1;
      if (itemId) {
        const ia = itemActivity.get(itemId) ?? { itemName, changeCount: 0, totalUsed: 0 };
        ia.changeCount += 1;
        itemActivity.set(itemId, ia);
      }
    } else if (action === "USAGE_SUBMIT") {
      ua.submissions += 1;
    } else if (action === "ITEM_CREATE" || action === "ITEM_DELETE") {
      ua.edits += 1;
    }
  }

  // Build usage-over-time sorted by day
  const usageOverTime = [...usageByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, totalUsed]) => ({ date, totalUsed }));

  // Build user comparison sorted by total activity descending
  const userComparison = [...userActivity.entries()]
    .map(([userId, data]) => ({ userId, ...data, total: data.edits + data.approvals + data.submissions }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  // Build top items sorted by change count descending
  const topItems = [...itemActivity.entries()]
    .map(([itemId, data]) => ({ itemId, ...data }))
    .sort((a, b) => b.changeCount - a.changeCount)
    .slice(0, 20);

  return json(200, {
    period,
    days,
    totalEvents: allEvents.length,
    usageOverTime,
    userComparison,
    topItems,
  });
};
