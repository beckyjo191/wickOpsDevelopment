// ── Route handlers: dashboard ───────────────────────────────────────────────
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { RouteContext } from "../types";
import { json } from "../http";
import { ensureColumns, listLocations } from "../columns";
import { listAllItems, listItemsPage } from "../items";
import { getDaysUntilExpiration } from "../csv";
import { getRegisteredVendors } from "../vendors";
import { createLocation } from "../locations";
import { ensureSchemaUpToDate, DEFAULT_LOCATION_NAME } from "../migration";
import { seedSyntheticPriceHistory } from "../seed-synthetic-history";
import { migrateVendorPricingFromItems } from "../migrate-vendor-pricing";
import { listAllVendorPricing } from "./vendor-pricing";
import { getAllowedUnits } from "./allowed-units";
import { ddb } from "../clients";

export const handleAlertSummary = async (ctx: RouteContext) => {
  const { storage } = ctx;
  const [items, locations] = await Promise.all([
    listAllItems(storage, ""),
    listLocations(storage),
  ]);
  let expiredCount = 0;
  let expiringSoonCount = 0;
  let lowStockCount = 0;

  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));
  const byLocationMap = new Map<string, { expiredCount: number; expiringSoonCount: number; lowStockCount: number }>();

  for (const item of items) {
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(item.valuesJson ?? "{}") ?? {};
    } catch {
      continue;
    }

    const locationId = String((item as { locationId?: string }).locationId ?? "").trim();
    const locationName = locationNameById.get(locationId) ?? "";
    if (!byLocationMap.has(locationName)) {
      byLocationMap.set(locationName, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
    const locCounts = byLocationMap.get(locationName)!;

    const daysUntil = getDaysUntilExpiration(values.expirationDate as string | null | undefined);
    if (daysUntil !== null) {
      // Today (daysUntil === 0) counts as expired: by end-of-day the item is past.
      if (daysUntil <= 0) {
        expiredCount += 1;
        locCounts.expiredCount += 1;
      } else if (daysUntil <= 30) {
        expiringSoonCount += 1;
        locCounts.expiringSoonCount += 1;
      }
    }

    const quantity = Number(values.quantity);
    const minQuantity = Number(values.minQuantity);
    const hasMinQty =
      values.minQuantity !== null &&
      values.minQuantity !== undefined &&
      String(values.minQuantity).trim() !== "" &&
      Number.isFinite(minQuantity) &&
      minQuantity > 0;
    if (hasMinQty && Number.isFinite(quantity) && quantity < minQuantity) {
      lowStockCount += 1;
      locCounts.lowStockCount += 1;
    }
  }

  // Include locations that have no items yet so the dashboard renders them.
  for (const loc of locations) {
    if (!byLocationMap.has(loc.name)) {
      byLocationMap.set(loc.name, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
  }

  const byLocation = Array.from(byLocationMap.entries())
    .map(([location, counts]) => ({ location, ...counts }))
    .sort((a, b) => {
      // Empty location (orphan — shouldn't happen post-migration) goes last
      if (!a.location && b.location) return 1;
      if (a.location && !b.location) return -1;
      return a.location.localeCompare(b.location);
    });

  return json(200, { expiredCount, expiringSoonCount, lowStockCount, byLocation });
};

export const handleBootstrap = async (ctx: RouteContext) => {
  const { storage, access } = ctx;
  // Run schema migration before reading anything else. Idempotent; cheap on
  // the warm path (one GetCommand on the migration meta row).
  const migrationResult = await ensureSchemaUpToDate(storage, access);
  const columns = await ensureColumns(access.organizationId);

  // 1e seed: synthesize one closed order per existing item with vendor +
  // price data so Shop has comparable history on day one. Idempotent (meta
  // marker + per-order ConditionExpression). Failure is logged, not fatal —
  // the user can still use the app, just with empty price history.
  try {
    await seedSyntheticPriceHistory(storage, access);
  } catch (err) {
    console.warn("Synthetic price-history seed failed", err);
  }

  // 1g.7 migration: seed inventoryItemVendorPricing rows from legacy
  // vendor / unitCost / packSize / packCost / reorderLink fields on items.
  // Lets the user delete those columns from Manage Columns once migrated.
  // Idempotent (meta marker + per-row attribute_not_exists). Failure is
  // logged, not fatal.
  try {
    await migrateVendorPricingFromItems(storage, access);
  } catch (err) {
    console.warn("Vendor-pricing migration failed", err);
  }

  // Locations must exist before we seed a blank row (the seed needs a
  // locationId). On a fresh org with no items and no migration, no locations
  // exist yet — create a Default one.
  let locations = await listLocations(storage);
  if (locations.length === 0) {
    const created = await createLocation(
      storage,
      access.organizationId,
      DEFAULT_LOCATION_NAME,
      10,
    );
    locations = [created];
  }

  // Use paginated fetch to stay well under Lambda's 6 MB response limit.
  // Each item is ~200 bytes JSON, so 10k items ≈ 2 MB — safe margin under 6 MB.
  const BOOTSTRAP_PAGE_SIZE = 10_000;
  let [page, registeredVendors, vendorPricing, allowedUnitsResult] = await Promise.all([
    listItemsPage(storage, access.organizationId, BOOTSTRAP_PAGE_SIZE),
    getRegisteredVendors(storage),
    listAllVendorPricing(storage, access.organizationId),
    getAllowedUnits(storage),
  ]);
  // 1h.7: getAllowedUnits returns both the curated list AND the
  // tracksUnits org gate (whether the org buys items in units of
  // measurement). Default-off so basic EMS orgs get the simpler form.
  const { units: allowedUnits, tracksUnits } = allowedUnitsResult;
  let items = page.items;
  let nextToken = page.nextToken;

  // Seed a single blank row so new orgs never see an empty table.
  if (items.length === 0) {
    try {
      const rowId = randomUUID();
      const now = new Date().toISOString();
      const blankValues: Record<string, string | number> = {};
      for (const col of columns) {
        if (col.type === "number") blankValues[col.key] = 0;
        else blankValues[col.key] = "";
      }
      const valuesJson = JSON.stringify(blankValues);
      const seedLocationId = locations[0].id;
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: rowId },
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, locationId = :loc, updatedAtCustom = :now, createdAt = :now",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":position": 0,
            ":values": valuesJson,
            ":loc": seedLocationId,
            ":now": now,
          },
        }),
      );
      items = [{ id: rowId, organizationId: access.organizationId, module: "inventory", position: 0, valuesJson, locationId: seedLocationId, createdAt: now, updatedAtCustom: now }];
      nextToken = null;
    } catch (err) {
      console.warn("Failed to seed blank row for new org", err);
    }
  }

  return json(200, {
    access,
    columns,
    items,
    locations,
    registeredVendors,
    // 1g: per-(item, vendor) pricing rows. Frontend builds an in-memory
    // Map<itemId, Map<vendor, entry>> for fast modal + Shop reads.
    vendorPricing,
    // 1h.2: per-org curated unit list. Drives the unit dropdowns in
    // CellEditor + New Order so EMS / pantry / fire orgs see only the
    // units that fit their world.
    allowedUnits,
    // 1h.7: org-wide gate. When false (default for new orgs), the i
    // modal hides Amount + Unit fields — count-only EMS flow. When
    // true, the dual-axis Pack form + $/lb price-trend math come on.
    tracksUnits,
    columnVisibilityOverrides: access.columnVisibilityOverrides,
    nextToken,
    ...(migrationResult.toastMessage
      ? { migrationNotice: { message: migrationResult.toastMessage } }
      : {}),
  });
};
