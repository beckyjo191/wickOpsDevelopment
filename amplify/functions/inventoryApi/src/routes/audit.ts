// ── Audit log handlers ──────────────────────────────────────────────────────

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json, parseNextToken, encodeNextToken } from "../http";
import { AUDIT_BY_TIMESTAMP_INDEX, AUDIT_BY_USER_INDEX } from "../config";
import { listAllItems } from "../items";
import { listLocations } from "../locations";

/** Build a predicate that returns true when an audit event was logged at the
 *  given location. Location is stamped per event-kind:
 *    - USAGE_APPROVE / ITEM_RETIRE: `details.location` (name string), set
 *      from the structural location at log time.
 *    - RESTOCK_RECEIVED / RESTOCK_ADDED: `details.locationId` (id), set
 *      from where the order line was received.
 *  Events that carry no location info are excluded under a filter — better
 *  to omit than to lie about per-station totals. */
const buildLocationFilter = (locationId: string | undefined, locationName: string | undefined) => {
  if (!locationId) return () => true;
  return (action: string, details: Record<string, unknown>): boolean => {
    if (action === "USAGE_APPROVE" || action === "ITEM_RETIRE") {
      const evtLocation = typeof details.location === "string" ? details.location.trim() : "";
      return Boolean(locationName) && evtLocation === locationName;
    }
    if (action === "RESTOCK_RECEIVED" || action === "RESTOCK_ADDED") {
      const evtLocationId = typeof details.locationId === "string" ? details.locationId.trim() : "";
      return evtLocationId === locationId;
    }
    return false;
  };
};

// Machine-managed valuesJson keys. ITEM_EDIT events whose only changes are in
// this set are pure noise — the one-time parentItemId backfill, retire-row
// markers, or orderedAt flips that the dedicated ITEM_RETIRE / RESTOCK_*
// events already cover. Kept in sync with the client filter in AuditLogPage.
const SYSTEM_FIELDS = new Set<string>([
  "parentItemId",
  "retiredAt",
  "retiredQty",
  "retirementReason",
  "orderedAt",
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
  let details: { changes?: unknown; deletedValues?: unknown; closedManually?: unknown } = {};
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
  if (item.action === "RESTOCK_ORDER_CLOSED") {
    // Hide auto-close events (fully-received orders); keep deliberate closes.
    return details.closedManually !== true;
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

/** ms-per-year approximation used for YoY shifting. 365 days is fine for the
 *  comparisons we care about (year-over-year of a sliding window); leap-year
 *  off-by-one days don't materially change a 30-day-vs-30-day comparison. */
const YEAR_MS = 365 * 86400000;

export const handleAuditAnalytics = async (ctx: RouteContext) => {
  const { access, storage, query } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can view analytics." });
  }

  const period = query.period ?? "30d";
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const nowMs = Date.now();
  const periodSinceMs = nowMs - days * 86400000;
  const compareYoY = query.compareYoY === "1" || query.compareYoY === "true";
  // Previous-period window: the same N days, shifted back one year. We use
  // [prevSinceMs, prevUntilMs) as a half-open range so events at the boundary
  // attribute to exactly one period.
  const prevSinceMs = periodSinceMs - YEAR_MS;
  const prevUntilMs = nowMs - YEAR_MS;

  // Day / 7-day / YTD windows for the usage-spend cards. Anchored to the
  // user's LOCAL calendar boundaries — passed in as query params from the
  // browser so a user in MDT doesn't see yesterday-evening events leaking
  // into "today UTC". Falls back to a UTC-based midnight if the client
  // didn't send boundaries (older clients pre-fix), which preserves the
  // previous-but-imperfect behavior rather than crashing.
  const now = new Date();
  const fallbackDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const fallbackYearStart = new Date(now.getFullYear(), 0, 1).getTime();
  const parseMs = (raw: string | undefined): number | null => {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const dayStartMs = parseMs(query.dayStartMs) ?? fallbackDayStart;
  const weekStartMs = parseMs(query.weekStartMs) ?? (dayStartMs - 6 * 86400000);
  const yearStartMs = parseMs(query.yearStartMs) ?? fallbackYearStart;

  // Per-location scoping. Resolve id → name once so USAGE_APPROVE /
  // ITEM_RETIRE matching (which uses the stamped location name) doesn't
  // re-lookup per event. Unknown id falls back to "no events match" rather
  // than silently widening to org-wide.
  const requestedLocationId = String(query.locationId ?? "").trim() || undefined;
  let requestedLocationName: string | undefined;
  if (requestedLocationId) {
    try {
      const locations = await listLocations(storage);
      const match = locations.find((l) => l.id === requestedLocationId);
      requestedLocationName = match?.name;
    } catch { /* if locations read fails, name stays undefined; USAGE events won't match */ }
  }
  const locationFilter = buildLocationFilter(requestedLocationId, requestedLocationName);

  // Scan window has to reach the oldest of (period start, year start, prev
  // year period start when compareYoY is on) so every aggregation has the
  // events it needs in a single pass.
  const scanSinceMs = Math.min(
    periodSinceMs,
    yearStartMs,
    compareYoY ? prevSinceMs : Number.POSITIVE_INFINITY,
  );
  const scanSince = new Date(scanSinceMs).toISOString();

  // Fetch all audit events in the scan window (oldest → newest so the
  // last-known unit cost map can accumulate chronologically before ITEM_RETIRE
  // events consume it for loss valuation).
  let allEvents: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: storage.auditTable,
        IndexName: AUDIT_BY_TIMESTAMP_INDEX,
        KeyConditionExpression: "orgId = :orgId AND #ts >= :since",
        ExpressionAttributeValues: { ":orgId": access.organizationId, ":since": scanSince },
        ExpressionAttributeNames: { "#ts": "timestamp" },
        ScanIndexForward: true,
        Limit: 1000,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }),
    );
    allEvents = allEvents.concat(result.Items ?? []);
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey && allEvents.length < 10000);

  // Build itemKey → current unit cost map from the items table. Used to value
  // USAGE_APPROVE events (which don't carry their own cost). Approximation:
  // values use the most recent cost on the item, not the cost at the time of
  // usage. Reasonable for items with stable pricing; if temporal accuracy ever
  // matters we can stamp unitCost into USAGE_APPROVE event details and prefer
  // that.
  const itemUnitCost = new Map<string, number>();
  // Items missing pricing — surfaced on the Analytics tab so the user can
  // backfill quickly. Keyed by parentItemId (preferred) or itemId so
  // duplicate lots collapse to one row in the picker. We track the
  // highest-stocked lot's name for display.
  type MissingPriceItem = {
    itemId: string;
    parentItemId: string;
    itemName: string;
    quantity: number;
  };
  const missingPriceMap = new Map<string, MissingPriceItem>();
  try {
    const allItems = await listAllItems(storage, access.organizationId);
    for (const item of allItems) {
      let values: Record<string, unknown> = {};
      try {
        values = JSON.parse(String((item as { valuesJson?: string }).valuesJson ?? "{}"));
      } catch { /* ignore */ }
      const cost = Number(values.unitCost ?? 0);
      const packCost = Number(values.packCost ?? 0);
      const parentId = typeof values.parentItemId === "string" && values.parentItemId.trim()
        ? String(values.parentItemId).trim()
        : item.id;
      const itemNameRaw = String(values.itemName ?? "").trim();
      const isRetired = values.retiredAt !== undefined && values.retiredAt !== null && String(values.retiredAt).trim() !== "";

      if (Number.isFinite(cost) && cost > 0) {
        // Prefer the highest unitCost across lots — defensible default when
        // one lot was bought cheaply long ago and a recent restock came in
        // pricier.
        const existing = itemUnitCost.get(parentId) ?? 0;
        if (cost > existing) itemUnitCost.set(parentId, cost);
        // Also key by raw item id so events with no parentItemId still resolve.
        const idExisting = itemUnitCost.get(item.id) ?? 0;
        if (cost > idExisting) itemUnitCost.set(item.id, cost);
      } else if (!isRetired && itemNameRaw) {
        // No unit cost AND no pack cost → flag for the missing-prices panel.
        // Skip items missing a name entirely (system rows, blank drafts).
        const hasAnyPrice = (Number.isFinite(cost) && cost > 0)
          || (Number.isFinite(packCost) && packCost > 0);
        if (!hasAnyPrice) {
          const qty = Number(values.quantity ?? 0);
          const safeQty = Number.isFinite(qty) ? qty : 0;
          const existing = missingPriceMap.get(parentId);
          if (!existing || safeQty > existing.quantity) {
            missingPriceMap.set(parentId, {
              itemId: item.id,
              parentItemId: parentId,
              itemName: itemNameRaw,
              quantity: safeQty,
            });
          }
        }
      }
    }
  } catch { /* if items table read fails, usage spend silently degrades to 0 */ }
  const missingPriceItems = [...missingPriceMap.values()]
    .sort((a, b) => b.quantity - a.quantity);

  // Run the period-bound aggregation for the current window.
  const currentSlice = aggregatePeriodSlice(allEvents, periodSinceMs, Number.POSITIVE_INFINITY, itemUnitCost, locationFilter);
  // YoY: same shape, shifted back one year. Half-open [prevSinceMs, prevUntilMs).
  const previousSlice = compareYoY
    ? aggregatePeriodSlice(allEvents, prevSinceMs, prevUntilMs, itemUnitCost, locationFilter)
    : null;

  // Calendar-anchored usage spend (Today / 7d / YTD) — independent of the
  // period selector. Single pass over USAGE_APPROVE events.
  let usageSpendToday = 0;
  let usageSpendWeek = 0;
  let usageSpendYTD = 0;
  for (const evt of allEvents) {
    const action = String(evt.action ?? "");
    if (action !== "USAGE_APPROVE") continue;
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(String(evt.detailsJson ?? "{}")); } catch { /* ignore */ }
    if (details.undone) continue;
    if (!locationFilter(action, details)) continue;
    const qty = Number(details.quantityUsed ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const itemId = String(evt.itemId ?? "");
    const parentItemId = typeof details.parentItemId === "string" && details.parentItemId.trim()
      ? String(details.parentItemId).trim()
      : itemId;
    const itemKey = parentItemId || itemId;
    const stampedCost = Number(details.unitCost ?? 0);
    const cost = Number.isFinite(stampedCost) && stampedCost > 0
      ? stampedCost
      : (itemUnitCost.get(itemKey) ?? itemUnitCost.get(itemId) ?? 0);
    if (cost <= 0) continue;
    const evtTimeMs = Date.parse(String(evt.timestamp ?? "")) || 0;
    const spend = qty * cost;
    if (evtTimeMs >= yearStartMs) usageSpendYTD += spend;
    if (evtTimeMs >= weekStartMs) usageSpendWeek += spend;
    if (evtTimeMs >= dayStartMs) usageSpendToday += spend;
  }

  return json(200, {
    period,
    days,
    ...currentSlice,
    usageSpend: {
      today: usageSpendToday,
      week: usageSpendWeek,
      ytd: usageSpendYTD,
    },
    // Items currently missing both unit cost and pack cost. Surfaced on the
    // Analytics tab so the user can backfill quickly — every price they set
    // here automatically values past usage events via the analytics fallback.
    missingPriceItems,
    ...(previousSlice ? { previous: previousSlice } : {}),
  });
};

/** Period-bound slice of analytics — extracted so we can run it twice
 *  (current + previous-year) on the same already-loaded event stream. */
function aggregatePeriodSlice(
  allEvents: Record<string, unknown>[],
  periodSinceMs: number,
  periodUntilMs: number,
  itemUnitCost: Map<string, number>,
  locationFilter: (action: string, details: Record<string, unknown>) => boolean = () => true,
) {
  const usageByDay = new Map<string, number>();
  const spendByDay = new Map<string, number>();
  const usageByItem = new Map<string, { itemName: string; itemId: string; qtyUsed: number; cost: number }>();
  const vendorSpend = new Map<string, { spend: number; orderIds: Set<string>; restockCount: number }>();
  const itemSpend = new Map<string, { itemName: string; itemId: string; spend: number; qtyReceived: number }>();
  const lossByReason = new Map<string, { qty: number; value: number }>();
  /** itemKey → most recent unitCost seen within this slice. Drives loss valuation. */
  const lastUnitCost = new Map<string, number>();

  let totalQtyUsed = 0;
  let totalSpend = 0;
  let totalLossQty = 0;
  let totalLossValue = 0;

  for (const evt of allEvents) {
    const evtTimeMs = Date.parse(String(evt.timestamp ?? "")) || 0;
    if (evtTimeMs < periodSinceMs || evtTimeMs >= periodUntilMs) continue;

    const action = String(evt.action ?? "");
    const day = String(evt.timestamp ?? "").slice(0, 10);
    const itemId = String(evt.itemId ?? "");
    const itemName = String(evt.itemName ?? "");

    let details: Record<string, unknown> = {};
    try { details = JSON.parse(String(evt.detailsJson ?? "{}")); } catch { /* ignore */ }

    // Per-location scoping: drop events that don't match before any work.
    if (!locationFilter(action, details)) continue;

    const parentItemId = typeof details.parentItemId === "string" && details.parentItemId.trim()
      ? String(details.parentItemId).trim()
      : itemId;
    const itemKey = parentItemId || itemName || itemId;
    if (!itemKey) continue;

    if (action === "USAGE_APPROVE") {
      if (details.undone) continue;
      const qty = Number(details.quantityUsed ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const stampedCost = Number(details.unitCost ?? 0);
      const cost = Number.isFinite(stampedCost) && stampedCost > 0
        ? stampedCost
        : (itemUnitCost.get(itemKey) ?? itemUnitCost.get(itemId) ?? 0);
      totalQtyUsed += qty;
      usageByDay.set(day, (usageByDay.get(day) ?? 0) + qty);
      if (cost > 0) spendByDay.set(day, (spendByDay.get(day) ?? 0) + qty * cost);
      const bucket = usageByItem.get(itemKey) ?? { itemName, itemId: itemId || itemKey, qtyUsed: 0, cost: 0 };
      bucket.qtyUsed += qty;
      if (cost > 0) bucket.cost += qty * cost;
      if (!bucket.itemName && itemName) bucket.itemName = itemName;
      if (!bucket.itemId && itemId) bucket.itemId = itemId;
      usageByItem.set(itemKey, bucket);
      continue;
    }

    if (action === "RESTOCK_RECEIVED" || action === "RESTOCK_ADDED") {
      const qty = Number(
        action === "RESTOCK_RECEIVED" ? details.qtyReceived ?? 0 : details.qtyDelta ?? 0,
      );
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const unitCost = Number(details.unitCost ?? 0);
      const vendor = typeof details.vendor === "string" ? details.vendor.trim() : "";
      const source = typeof details.source === "string" ? details.source : "";
      const isDonation = source === "donation";
      if (Number.isFinite(unitCost) && unitCost > 0) {
        lastUnitCost.set(itemKey, unitCost);
      }
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
      const bucket = itemSpend.get(itemKey) ?? { itemName, itemId: itemId || itemKey, spend: 0, qtyReceived: 0 };
      bucket.spend += spend;
      bucket.qtyReceived += qty;
      if (!bucket.itemName && itemName) bucket.itemName = itemName;
      if (!bucket.itemId && itemId) bucket.itemId = itemId;
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
    .map(([date, totalUsed]) => ({
      date,
      totalUsed,
      totalSpend: spendByDay.get(date) ?? 0,
    }));

  const byVendor = [...vendorSpend.entries()]
    .map(([vendor, v]) => ({
      vendor,
      spend: v.spend,
      orderCount: v.orderIds.size + v.restockCount,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const bySpendItem = [...itemSpend.values()]
    .map((v) => ({
      itemId: v.itemId,
      itemName: v.itemName || "Unnamed item",
      spend: v.spend,
      qtyReceived: v.qtyReceived,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  // Union of top 10 by qty + top 10 by cost — so a client-side toggle between
  // "Used (qty)" and "Used ($)" always has a fully-populated list to render.
  const usageMapped = [...usageByItem.values()].map((v) => ({
    itemId: v.itemId,
    itemName: v.itemName || "Unnamed item",
    qtyUsed: v.qtyUsed,
    cost: v.cost,
  }));
  const topByQty = [...usageMapped].sort((a, b) => b.qtyUsed - a.qtyUsed).slice(0, 10);
  const topByCost = [...usageMapped].sort((a, b) => b.cost - a.cost).slice(0, 10);
  const seen = new Set<string>();
  const byUsageItem: typeof usageMapped = [];
  for (const row of [...topByQty, ...topByCost]) {
    const key = row.itemId || row.itemName;
    if (seen.has(key)) continue;
    seen.add(key);
    byUsageItem.push(row);
  }

  const lossByReasonArr = [...lossByReason.entries()]
    .map(([reason, v]) => ({ reason, qty: v.qty, value: v.value }))
    .sort((a, b) => b.qty - a.qty);

  return {
    totals: {
      qtyUsed: totalQtyUsed,
      spend: totalSpend,
      lossQty: totalLossQty,
      lossValue: totalLossValue,
    },
    usageOverTime,
    byVendor,
    bySpendItem,
    byUsageItem,
    lossByReason: lossByReasonArr,
  };
}

/** Slice C: per-vendor breakdown for the drill-in drawer. Returns each item
 *  bought from the vendor in the period with qty, spend, and unit-cost
 *  range so the user can spot drift across orders ($0.50 → $0.69 → $0.85). */
export const handleVendorBreakdown = async (ctx: RouteContext) => {
  const { access, storage, query } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can view analytics." });
  }
  const vendor = String(query.vendor ?? "").trim();
  if (!vendor) return json(400, { error: "Missing vendor parameter." });

  const period = query.period ?? "30d";
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const periodSinceMs = Date.now() - days * 86400000;
  const since = new Date(periodSinceMs).toISOString();

  // Per-location scoping mirrors the main analytics endpoint.
  const requestedLocationId = String(query.locationId ?? "").trim() || undefined;
  let requestedLocationName: string | undefined;
  if (requestedLocationId) {
    try {
      const locations = await listLocations(storage);
      const match = locations.find((l) => l.id === requestedLocationId);
      requestedLocationName = match?.name;
    } catch { /* ignore */ }
  }
  const locationFilter = buildLocationFilter(requestedLocationId, requestedLocationName);

  // Single pass over the period — query orgId index filtered by timestamp.
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

  type Bucket = {
    itemId: string;
    itemName: string;
    spend: number;
    qty: number;
    minUnitCost: number;
    maxUnitCost: number;
    /** Weighted average accumulator — sum(qty × unitCost) / totalQty at end. */
    weightedCostSum: number;
    weightedQty: number;
  };
  const items = new Map<string, Bucket>();
  const orderIds = new Set<string>();
  let standaloneRestocks = 0;

  for (const evt of allEvents) {
    const action = String(evt.action ?? "");
    if (action !== "RESTOCK_RECEIVED" && action !== "RESTOCK_ADDED") continue;
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(String(evt.detailsJson ?? "{}")); } catch { /* ignore */ }
    const evtVendor = typeof details.vendor === "string" ? details.vendor.trim() : "";
    if (evtVendor !== vendor) continue;
    if (!locationFilter(action, details)) continue;
    const source = typeof details.source === "string" ? details.source : "";
    if (source === "donation") continue;
    const qty = Number(
      action === "RESTOCK_RECEIVED" ? details.qtyReceived ?? 0 : details.qtyDelta ?? 0,
    );
    const unitCost = Number(details.unitCost ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(unitCost) || unitCost <= 0) continue;

    const itemId = String(evt.itemId ?? "");
    const itemName = String(evt.itemName ?? "") || "Unnamed item";
    const parentItemId = typeof details.parentItemId === "string" && details.parentItemId.trim()
      ? String(details.parentItemId).trim()
      : itemId;
    const itemKey = parentItemId || itemId || itemName;

    const orderId = typeof details.orderId === "string" ? details.orderId : "";
    if (orderId) orderIds.add(orderId);
    else standaloneRestocks += 1;

    const bucket = items.get(itemKey) ?? {
      itemId: itemId || itemKey,
      itemName,
      spend: 0,
      qty: 0,
      minUnitCost: Number.POSITIVE_INFINITY,
      maxUnitCost: 0,
      weightedCostSum: 0,
      weightedQty: 0,
    };
    bucket.spend += qty * unitCost;
    bucket.qty += qty;
    bucket.weightedCostSum += qty * unitCost;
    bucket.weightedQty += qty;
    if (unitCost < bucket.minUnitCost) bucket.minUnitCost = unitCost;
    if (unitCost > bucket.maxUnitCost) bucket.maxUnitCost = unitCost;
    if (!bucket.itemName || bucket.itemName === "Unnamed item") bucket.itemName = itemName;
    if (!bucket.itemId && itemId) bucket.itemId = itemId;
    items.set(itemKey, bucket);
  }

  const itemsArr = [...items.values()]
    .map((b) => ({
      itemId: b.itemId,
      itemName: b.itemName,
      spend: b.spend,
      qty: b.qty,
      avgUnitCost: b.weightedQty > 0 ? b.weightedCostSum / b.weightedQty : 0,
      minUnitCost: b.minUnitCost === Number.POSITIVE_INFINITY ? 0 : b.minUnitCost,
      maxUnitCost: b.maxUnitCost,
    }))
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = itemsArr.reduce((sum, i) => sum + i.spend, 0);

  return json(200, {
    vendor,
    period,
    totals: {
      spend: totalSpend,
      orderCount: orderIds.size + standaloneRestocks,
      itemCount: itemsArr.length,
    },
    items: itemsArr,
  });
};
