// ── Route handlers: dashboard ───────────────────────────────────────────────
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

  // Keyed by locationId, NOT name — location names are only unique within a
  // parent, so two primaries can each have an "EMS Cabinet". Keying by name
  // would silently merge their counts.
  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));
  const byLocationMap = new Map<string, { expiredCount: number; expiringSoonCount: number; lowStockCount: number }>();

  // Low stock is item-level, not per-lot: a single zeroed lot doesn't mean the
  // item needs reordering if its other lots cover the minimum. Aggregate lots
  // by (location, lowercased itemName) — SUM quantity, MAX minQuantity — and
  // flag the group low only when the total is below threshold. Mirrors the
  // frontend (useInventoryFilters.ts) and the Reorder/Shop rule. Quantity-only
  // counts (expired/expiring) stay per-lot since each lot has its own date.
  const lowAgg = new Map<string, { locationId: string; totalQty: number; maxMin: number }>();

  for (const item of items) {
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(item.valuesJson ?? "{}") ?? {};
    } catch {
      continue;
    }

    // Retired lots are handled stock (qty zeroed, kept for loss history) — they
    // don't count toward expired/expiring/low. Matches the frontend, which
    // hides retired rows from every grid count.
    if (values.retiredAt) continue;
    // NOTE: already-ordered lots are NOT skipped — a pending order hasn't
    // arrived, so the item is still physically low and stays in this count
    // (mirrors the Low Stock tab). Only the Reorder list hides ordered items.

    const locationId = String((item as { locationId?: string }).locationId ?? "").trim();
    if (!byLocationMap.has(locationId)) {
      byLocationMap.set(locationId, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
    const locCounts = byLocationMap.get(locationId)!;

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

    const name = String(values.itemName ?? "").trim().toLowerCase();
    // Blank-name items can't be grouped — key by id so each stands alone.
    const aggKey = name ? `${locationId}::${name}` : `id:${item.id}`;
    const quantity = Number(values.quantity);
    const minQuantity = Number(values.minQuantity);
    const entry = lowAgg.get(aggKey) ?? { locationId, totalQty: 0, maxMin: 0 };
    // Expired-but-not-retired stock still counts toward on-hand (matches the
    // frontend + Shop list) — retiring an expired lot is what drops an item
    // below par. The min still defines the item's threshold.
    if (Number.isFinite(quantity)) entry.totalQty += quantity;
    if (Number.isFinite(minQuantity) && minQuantity > entry.maxMin) entry.maxMin = minQuantity;
    lowAgg.set(aggKey, entry);
  }

  // Second pass: resolve each item-group to a single low/not-low verdict and
  // tally the org-wide + per-location counts.
  for (const { locationId, totalQty, maxMin } of lowAgg.values()) {
    if (maxMin > 0 && totalQty < maxMin) {
      lowStockCount += 1;
      const locCounts = byLocationMap.get(locationId);
      if (locCounts) locCounts.lowStockCount += 1;
    }
  }

  // Include locations that have no items yet so the dashboard renders them.
  for (const loc of locations) {
    if (!byLocationMap.has(loc.id)) {
      byLocationMap.set(loc.id, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
  }

  // Emit both the locationId (the stable key the frontend rolls up by) and the
  // name (display fallback). `location` keeps the name for back-compat.
  const byLocation = Array.from(byLocationMap.entries())
    .map(([locationId, counts]) => ({
      locationId,
      location: locationNameById.get(locationId) ?? "",
      ...counts,
    }))
    .sort((a, b) => {
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

  // Self-heal stale "ordered" markers. A row can keep `orderedAt` after its
  // order was closed/cancelled if the client-side cleanup failed or raced (the
  // close path now clears it server-side, but legacy rows predate that). Clear
  // orderedAt on any loaded row that isn't referenced by a still-open order, so
  // the reorder list + "Ordered" pill reflect reality. Best-effort: never block
  // bootstrap on the reconciliation.
  try {
    const ordersScan = await ddb.send(new ScanCommand({
      TableName: storage.restockOrdersTable,
      FilterExpression: "orgId = :orgId",
      ExpressionAttributeValues: { ":orgId": access.organizationId },
    }));
    const openRowIds = new Set<string>();
    for (const ord of ordersScan.Items ?? []) {
      if (String(ord.status) === "closed") continue;
      let orderItems: Array<{ itemId?: string }> = [];
      try { orderItems = JSON.parse(String(ord.itemsJson ?? "[]")) ?? []; } catch { /* ignore */ }
      for (const oi of orderItems) {
        const id = String(oi?.itemId ?? "").trim();
        if (id) openRowIds.add(id);
      }
    }
    const heals: Promise<unknown>[] = [];
    items = items.map((it) => {
      let values: Record<string, unknown> = {};
      try { values = JSON.parse(String(it.valuesJson ?? "{}")) ?? {}; } catch { return it; }
      if (!values.orderedAt || openRowIds.has(String(it.id))) return it;
      delete values.orderedAt;
      delete values.reorderCheckedAt;
      const valuesJson = JSON.stringify(values);
      heals.push(ddb.send(new UpdateCommand({
        TableName: storage.itemTable,
        Key: { id: it.id },
        ConditionExpression: "organizationId = :org AND #module = :module",
        UpdateExpression: "SET valuesJson = :values",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":org": access.organizationId, ":module": "inventory", ":values": valuesJson },
      })).catch(() => {}));
      return { ...it, valuesJson };
    });
    if (heals.length > 0) await Promise.all(heals);
  } catch { /* reconciliation is best-effort */ }

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
