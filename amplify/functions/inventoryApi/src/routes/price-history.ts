// ── Price history aggregation ───────────────────────────────────────────────
// Reads restock orders within a recency window and rolls them up into
// per-(itemName, vendor) latest-price entries. Grouping by lowercased item
// name (not itemId) handles two realities: (1) freeform purchases each get a
// new `freeform-uuid`, so the same "Apples" bought twice has two different
// itemIds; (2) the same item bought from multiple vendors should still
// compare side-by-side on the shopping-list view.
//
// "Latest wins" — we don't average. Prices move with sales and seasons; the
// most recent observation is the most useful for a "what would I pay
// tomorrow?" estimate. The sample count is returned so the client can show
// confidence ("3 receipts" vs "1 sample") instead of pretending every entry
// is equally trustworthy.

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../clients";
import { json } from "../http";
import type { RouteContext, RestockOrder, RestockOrderItem } from "../types";
import { canonicalUnitFor, dimensionForUnit, type Dimension } from "../uom";

/** How far back the per-vendor "current best price" view looks. Older
 *  receipts aren't deleted — they just stop powering the comparison badge.
 *  See conversation history for the recency-window decision. */
const RECENCY_WINDOW_DAYS = 180;

export type PriceHistoryEntry = {
  /** Lowercased item name — the cross-vendor grouping key. */
  itemKey: string;
  /** Display casing from the most recent observation. */
  itemName: string;
  /** Most recent non-freeform itemId, when one exists across the lines. The
   *  client can use this to link "the apples I have on the inventory row"
   *  to "every apple receipt across vendors." Absent if every observation
   *  for this itemKey came from a freeform purchase. */
  itemId?: string;
  vendor: string;
  /** Most recent price, expressed in the canonical unit of the line's
   *  dimension ($/ct for count, $/oz for weight, $/fl oz for volume). */
  pricePerCanonical: number;
  canonicalUnit: string;
  dimension: Dimension;
  sampleCount: number;
  /** ISO timestamp of the most recent observation. */
  lastPurchasedAt: string;
  /** True when the most recent observation is a migration-injected line
   *  (1e). Lets the client mark sparse synthetic-only data as low-confidence. */
  synthetic: boolean;
};

/** Derive a `pricePerCanonical` for a line that lacks the new field. Used to
 *  keep pre-1c orders visible in the comparison view. Returns null when the
 *  line has no usable price data. Only count-dimension lines back-fill from
 *  legacy unitCost / packCost — for weight or volume the legacy unitCost
 *  semantics aren't well-defined ($/ct vs $/oz), so we skip rather than
 *  invent a number.
 *
 *  Dimension precedence: persisted `line.dimension` > inferred from
 *  `line.purchaseUnit` > "count" fallback (1f assumes legacy is count). */
const derivePricePerCanonical = (line: RestockOrderItem): { value: number; dimension: Dimension } | null => {
  const inferredFromUnit = line.purchaseUnit ? dimensionForUnit(line.purchaseUnit) : null;
  const dimension: Dimension = line.dimension ?? inferredFromUnit ?? "count";

  if (typeof line.pricePerCanonical === "number" && Number.isFinite(line.pricePerCanonical)) {
    return { value: line.pricePerCanonical, dimension };
  }
  // Legacy back-fill is count-only — see function comment above.
  if (dimension !== "count") return null;
  const unitCost = typeof line.unitCost === "number" ? line.unitCost : undefined;
  if (unitCost !== undefined && Number.isFinite(unitCost) && unitCost >= 0) {
    return { value: unitCost, dimension: "count" };
  }
  const packSize = typeof line.packSize === "number" ? line.packSize : 0;
  const packCost = typeof line.packCost === "number" ? line.packCost : undefined;
  if (packSize > 0 && packCost !== undefined && Number.isFinite(packCost) && packCost >= 0) {
    return { value: packCost / packSize, dimension: "count" };
  }
  return null;
};

export const handleGetPriceHistory = async (ctx: RouteContext) => {
  const { storage, access, query } = ctx;
  if (!access.allowedModules?.includes("inventory")) {
    return json(403, { error: "Inventory access required." });
  }

  const filterItemId = String(query?.itemId ?? "").trim() || undefined;
  const filterItemName = String(query?.itemName ?? "").trim().toLowerCase() || undefined;

  const cutoff = new Date(Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Scan org orders newer than cutoff. The orders table is small relative to
  // items (one row per receipt event, not per stock unit), so a Scan with
  // FilterExpression is acceptable for v1. If this becomes hot we can add a
  // GSI on (orgId, createdAt) — leaving as a follow-up.
  const result = await ddb.send(
    new ScanCommand({
      TableName: storage.restockOrdersTable,
      FilterExpression: "orgId = :orgId AND createdAt >= :cutoff",
      ExpressionAttributeValues: {
        ":orgId": access.organizationId,
        ":cutoff": cutoff,
      },
    }),
  );

  const aggMap = new Map<string, PriceHistoryEntry>();

  for (const orderRaw of (result.Items ?? [])) {
    const order = orderRaw as unknown as RestockOrder;
    const vendor = String(order.vendor ?? "").trim();
    // Without a vendor we can't compare across stores — skip.
    if (!vendor) continue;

    let items: RestockOrderItem[] = [];
    try {
      items = JSON.parse(String(order.itemsJson ?? "[]")) as RestockOrderItem[];
    } catch {
      continue;
    }

    for (const line of items) {
      const itemName = String(line.itemName ?? "").trim();
      if (!itemName) continue;
      const itemKey = itemName.toLowerCase();

      if (filterItemName && itemKey !== filterItemName) continue;
      if (filterItemId && String(line.itemId ?? "") !== filterItemId) continue;

      const derived = derivePricePerCanonical(line);
      if (!derived) continue;

      const aggKey = `${itemKey}|${vendor.toLowerCase()}`;
      const at = String(order.createdAt ?? "");
      const existing = aggMap.get(aggKey);
      const isRealId = line.itemId && !line.itemId.startsWith("freeform-");

      if (!existing) {
        aggMap.set(aggKey, {
          itemKey,
          itemName,
          ...(isRealId ? { itemId: line.itemId } : {}),
          vendor,
          pricePerCanonical: derived.value,
          canonicalUnit: canonicalUnitFor(derived.dimension),
          dimension: derived.dimension,
          sampleCount: 1,
          lastPurchasedAt: at,
          synthetic: Boolean(line.synthetic),
        });
      } else {
        existing.sampleCount += 1;
        // Latest observation wins on price + display fields. itemId sticks to
        // any non-freeform id we've seen even if the latest line is freeform —
        // the binding to a real inventory row is more useful than freshness.
        if (at > existing.lastPurchasedAt) {
          existing.lastPurchasedAt = at;
          existing.pricePerCanonical = derived.value;
          existing.canonicalUnit = canonicalUnitFor(derived.dimension);
          existing.dimension = derived.dimension;
          existing.itemName = itemName;
          existing.synthetic = Boolean(line.synthetic);
        }
        if (isRealId && !existing.itemId) existing.itemId = line.itemId;
      }
    }
  }

  return json(200, {
    history: Array.from(aggMap.values()),
    recencyWindowDays: RECENCY_WINDOW_DAYS,
  });
};
