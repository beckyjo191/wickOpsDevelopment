// ── Synthetic price-history seed (1e) ───────────────────────────────────────
// One-time backfill that creates one closed RestockOrder per existing
// inventory item that already has a vendor + price recorded on the row
// (legacy `vendor` / `unitCost` / `packSize` / `packCost` columns from
// before the 1c receipt-entry rebuild). Without this, the Shop tab's
// price-history endpoint shows "No history yet" for every item until the
// user places a new order — which forces them to type prices they already
// told us once.
//
// Idempotent in two ways:
//   1. A meta marker row gates the whole pass so the warm path is one
//      GetCommand. Set after the first successful run.
//   2. Each synthetic order uses a deterministic id (`synthetic-1e-<itemId>`)
//      with a ConditionExpression on insert, so even if the marker is wiped
//      we never duplicate an order line.
//
// What we DON'T seed: items with no vendor (can't compare across stores) or
// no price field (nothing to record). Both skips are silent — they're not
// errors, just absence of data.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { listAllItems } from "./items";
import { pricePerCanonical as derivePricePerCanonical } from "./uom";
import type {
  AccessContext,
  InventoryStorage,
  RestockOrder,
  RestockOrderItem,
} from "./types";

/** Meta row id that marks this org as having run the 1e seed pass. Stored on
 *  the columns table alongside the existing migration meta row. */
const SYNTHETIC_HISTORY_MARKER_ID = "inventory-meta-synthetic-history-1e";

export const seedSyntheticPriceHistory = async (
  storage: InventoryStorage,
  access: AccessContext,
): Promise<{ seeded: number; skipped: number; alreadyDone: boolean }> => {
  // Warm-path: marker exists ⇒ single GetCommand and we're done.
  try {
    const marker = await ddb.send(
      new GetCommand({
        TableName: storage.columnTable,
        Key: { id: SYNTHETIC_HISTORY_MARKER_ID },
      }),
    );
    if (marker.Item) {
      return { seeded: 0, skipped: 0, alreadyDone: true };
    }
  } catch (err) {
    console.warn("seedSyntheticPriceHistory: marker check failed", err);
    // Fall through — better to attempt the seed than skip silently.
  }

  const items = await listAllItems(storage, access.organizationId);
  let seeded = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const item of items) {
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(String(item.valuesJson ?? "{}"));
    } catch {
      skipped += 1;
      continue;
    }

    const vendor = String(values.vendor ?? "").trim();
    if (!vendor) { skipped += 1; continue; }
    const itemName = String(values.itemName ?? "").trim();
    if (!itemName) { skipped += 1; continue; }

    const unitCostRaw = Number(values.unitCost);
    const packSizeRaw = Number(values.packSize);
    const packCostRaw = Number(values.packCost);

    // Prefer pack data (it's the receipt shape: "30 ct for $24.99"). Fall
    // back to unitCost ("1 ct for $0.50"). Skip when there's no usable price.
    let purchaseAmount: number;
    let purchasePrice: number;
    let packSize: number | undefined;
    let packCost: number | undefined;
    if (Number.isFinite(packSizeRaw) && packSizeRaw > 0 && Number.isFinite(packCostRaw) && packCostRaw >= 0) {
      purchaseAmount = packSizeRaw;
      purchasePrice = packCostRaw;
      packSize = packSizeRaw;
      packCost = packCostRaw;
    } else if (Number.isFinite(unitCostRaw) && unitCostRaw >= 0) {
      purchaseAmount = 1;
      purchasePrice = unitCostRaw;
    } else {
      skipped += 1;
      continue;
    }

    const purchaseUnit = "ct"; // 1e seeds count-dimension only — that's the legacy assumption
    const canonical = derivePricePerCanonical(purchasePrice, purchaseAmount, purchaseUnit);
    // canonical can't realistically fail here since unit is hardcoded "ct",
    // but we guard anyway and fall back to a direct division.
    const pricePerCanonical = canonical
      ? canonical.pricePerCanonical
      : purchasePrice / Math.max(1, purchaseAmount);

    const line: RestockOrderItem = {
      itemId: item.id,
      itemName,
      qtyOrdered: purchaseAmount,
      qtyReceived: purchaseAmount,
      unitCost: purchasePrice / Math.max(1, purchaseAmount),
      ...(packSize !== undefined ? { packSize } : {}),
      ...(packCost !== undefined ? { packCost } : {}),
      purchaseAmount,
      purchaseUnit,
      purchasePrice,
      pricePerCanonical,
      dimension: "count",
      synthetic: true,
    };

    const orderId = `synthetic-1e-${item.id}`;
    const order: RestockOrder = {
      id: orderId,
      orgId: access.organizationId,
      status: "closed",
      vendor,
      createdAt: now,
      createdByUserId: "system",
      createdByName: "System (price-history backfill)",
      itemsJson: JSON.stringify([line]),
      receivesJson: JSON.stringify([
        {
          receivedAt: now,
          receivedByUserId: "system",
          receivedByName: "System (price-history backfill)",
          lines: [{ itemId: item.id, qtyThisReceive: purchaseAmount }],
          closedOrder: true,
        },
      ]),
      closedAt: now,
      closedByUserId: "system",
      closedByName: "System (price-history backfill)",
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: storage.restockOrdersTable,
          Item: order,
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
      seeded += 1;
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Already inserted on a previous run that didn't reach the marker
        // step — count as a skip (no real work) rather than an error.
        skipped += 1;
      } else {
        console.warn("seedSyntheticPriceHistory: failed to insert order", { itemId: item.id, err });
        skipped += 1;
      }
    }
  }

  // Write the marker so future bootstraps short-circuit on the warm path.
  // Best-effort — if this fails the per-order ConditionExpression still
  // protects against duplicates next time.
  try {
    await ddb.send(
      new PutCommand({
        TableName: storage.columnTable,
        Item: {
          id: SYNTHETIC_HISTORY_MARKER_ID,
          module: "inventory",
          kind: "meta",
          ranAt: now,
          seeded,
          skipped,
        },
      }),
    );
  } catch (err) {
    console.warn("seedSyntheticPriceHistory: marker write failed", err);
  }

  return { seeded, skipped, alreadyDone: false };
};
