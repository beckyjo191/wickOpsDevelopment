// ── Route handlers: dashboard ───────────────────────────────────────────────
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { RouteContext } from "../types";
import { json } from "../http";
import { ensureColumns } from "../columns";
import { listAllItems } from "../items";
import { getDaysUntilExpiration } from "../csv";
import { getRegisteredLocations } from "../locations";
import { ddb } from "../clients";

export const handleAlertSummary = async (ctx: RouteContext) => {
  const { storage } = ctx;
  const items = await listAllItems(storage, "");
  let expiredCount = 0;
  let expiringSoonCount = 0;
  let lowStockCount = 0;

  const byLocationMap = new Map<string, { expiredCount: number; expiringSoonCount: number; lowStockCount: number }>();

  for (const item of items) {
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(item.valuesJson ?? "{}") ?? {};
    } catch {
      continue;
    }

    const location = String(values.location ?? "").trim();
    if (!byLocationMap.has(location)) {
      byLocationMap.set(location, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
    const locCounts = byLocationMap.get(location)!;

    const daysUntil = getDaysUntilExpiration(values.expirationDate as string | null | undefined);
    if (daysUntil !== null) {
      if (daysUntil < 0) {
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

  // Include registered locations that may not have items yet
  const registeredLocations = await getRegisteredLocations(storage);
  for (const loc of registeredLocations) {
    if (!byLocationMap.has(loc)) {
      byLocationMap.set(loc, { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 });
    }
  }

  const byLocation = Array.from(byLocationMap.entries())
    .map(([location, counts]) => ({ location, ...counts }))
    .sort((a, b) => {
      // Empty location (unassigned) goes last
      if (!a.location && b.location) return 1;
      if (a.location && !b.location) return -1;
      return a.location.localeCompare(b.location);
    });

  return json(200, { expiredCount, expiringSoonCount, lowStockCount, byLocation });
};

export const handleBootstrap = async (ctx: RouteContext) => {
  const { storage, access } = ctx;
  const columns = await ensureColumns(access.organizationId);
  let [items, registeredLocations] = await Promise.all([
    listAllItems(storage, access.organizationId),
    getRegisteredLocations(storage),
  ]);

  // Seed a single blank row so new orgs never see an empty table.
  // Wrapped in try-catch so a seed failure (e.g. table still provisioning)
  // doesn't take down the entire bootstrap response.
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
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: rowId },
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, updatedAtCustom = :now, createdAt = :now",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":position": 0,
            ":values": valuesJson,
            ":now": now,
          },
        }),
      );
      items = [{ id: rowId, organizationId: access.organizationId, module: "inventory", position: 0, valuesJson, createdAt: now, updatedAtCustom: now }];
    } catch (err) {
      // Non-critical: frontend will create a blank row in memory if items is empty
      console.warn("Failed to seed blank row for new org", err);
    }
  }

  return json(200, {
    access,
    columns,
    items,
    registeredLocations,
    columnVisibilityOverrides: access.columnVisibilityOverrides,
    nextToken: null,
  });
};
