// ── Audit log handlers ──────────────────────────────────────────────────────

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken, encodeNextToken } from "../http";
import { AUDIT_BY_TIMESTAMP_INDEX, AUDIT_BY_USER_INDEX } from "../config";

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

  const result = await ddb.send(
    new QueryCommand({
      TableName: storage.auditTable,
      IndexName: useUserIndex ? AUDIT_BY_USER_INDEX : AUDIT_BY_TIMESTAMP_INDEX,
      KeyConditionExpression: keyCondition,
      ...(filterExpression ? { FilterExpression: filterExpression } : {}),
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length > 0 ? { ExpressionAttributeNames: exprNames } : {}),
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }),
  );

  const events = (result.Items ?? []).map((item) => ({
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

  const nextCursor = result.LastEvaluatedKey
    ? encodeNextToken(result.LastEvaluatedKey as Record<string, unknown>)
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

  const result = await ddb.send(
    new QueryCommand({
      TableName: storage.auditTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ITEM#${itemId}` },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }),
  );

  const events = (result.Items ?? []).map((item) => ({
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

  const nextCursor = result.LastEvaluatedKey
    ? encodeNextToken(result.LastEvaluatedKey as Record<string, unknown>)
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
