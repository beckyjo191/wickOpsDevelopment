// ── Vendor pricing migration (1g.7) ─────────────────────────────────────────
// One-time backfill that seeds the inventoryItemVendorPricing table from the
// legacy `vendor` / `unitCost` / `packSize` / `packCost` / `reorderLink`
// fields on existing inventory items. After this runs, the user can safely
// delete those columns from Manage Columns — the data lives on the new
// per-(item, vendor) rows.
//
// Doubly idempotent in the same shape as 1e's synthetic-history seed:
//   1. Meta marker row gates the whole pass — warm path is one GetCommand.
//   2. Per-row ConditionExpression on insert (attribute_not_exists) means
//      even if the marker is wiped we never duplicate a row.
//
// Skip cases (silent — these are absences of data, not errors):
//   - items with no vendor (can't construct the (item, vendor) key)
//   - items with vendor but no pricing AND no URL (nothing to seed)

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import { listAllItems } from "./items";
import type {
  AccessContext,
  InventoryItemVendorPricing,
  InventoryStorage,
} from "./types";

/** Meta row id that marks an org as having run the 1g vendor-pricing
 *  migration. Stored on the columns table alongside the other meta rows. */
const VENDOR_PRICING_MIGRATION_MARKER_ID = "inventory-meta-vendor-pricing-1g";

const numberOrUndefined = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const stringOrUndefined = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

export const migrateVendorPricingFromItems = async (
  storage: InventoryStorage,
  access: AccessContext,
): Promise<{ migrated: number; skipped: number; alreadyDone: boolean }> => {
  // Warm-path short-circuit.
  try {
    const marker = await ddb.send(
      new GetCommand({
        TableName: storage.columnTable,
        Key: { id: VENDOR_PRICING_MIGRATION_MARKER_ID },
      }),
    );
    if (marker.Item) {
      return { migrated: 0, skipped: 0, alreadyDone: true };
    }
  } catch (err) {
    console.warn("migrateVendorPricingFromItems: marker check failed", err);
    // Don't fall through silently — better to attempt the migration.
  }

  const items = await listAllItems(storage, access.organizationId);
  let migrated = 0;
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

    const vendor = stringOrUndefined(values.vendor);
    if (!vendor) { skipped += 1; continue; }

    const unitCost = numberOrUndefined(values.unitCost);
    const packSize = numberOrUndefined(values.packSize);
    const packCost = numberOrUndefined(values.packCost);
    const reorderUrl = stringOrUndefined(values.reorderLink);

    // Nothing to seed if the item has only a vendor and no pricing/URL.
    if (unitCost === undefined && packSize === undefined && packCost === undefined && !reorderUrl) {
      skipped += 1;
      continue;
    }

    const id = `${item.id}#${vendor.toLowerCase()}`;
    const row: InventoryItemVendorPricing = {
      id,
      orgId: access.organizationId,
      module: "inventory",
      itemId: item.id,
      vendor,
      vendorLower: vendor.toLowerCase(),
      ...(unitCost !== undefined ? { unitCost } : {}),
      ...(packSize !== undefined ? { packSize } : {}),
      ...(packCost !== undefined ? { packCost } : {}),
      ...(reorderUrl ? { reorderUrl } : {}),
      lastUpdatedAt: now,
      lastUpdatedByUserId: "system",
    };

    try {
      await ddb.send(
        new PutCommand({
          TableName: storage.vendorPricingTable,
          Item: row,
          // Defensive: never overwrite a row a user has since edited.
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
      migrated += 1;
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        // Row already exists — either from a previous migration run that
        // didn't reach the marker step, OR the user already saved a vendor
        // pricing entry for this (item, vendor) via the modal. Both are
        // fine; their data wins.
        skipped += 1;
      } else {
        console.warn("migrateVendorPricingFromItems: failed to insert row", { itemId: item.id, err });
        skipped += 1;
      }
    }
  }

  // Mark complete so future bootstraps short-circuit.
  try {
    await ddb.send(
      new PutCommand({
        TableName: storage.columnTable,
        Item: {
          id: VENDOR_PRICING_MIGRATION_MARKER_ID,
          module: "inventory",
          kind: "meta",
          ranAt: now,
          migrated,
          skipped,
        },
      }),
    );
  } catch (err) {
    console.warn("migrateVendorPricingFromItems: marker write failed", err);
  }

  return { migrated, skipped, alreadyDone: false };
};
