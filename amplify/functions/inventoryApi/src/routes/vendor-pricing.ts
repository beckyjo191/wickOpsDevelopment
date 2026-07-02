// ── Vendor pricing handlers (1g) ────────────────────────────────────────────
// Per-(item, vendor) pricing rows. Replaces the prior pattern of stuffing
// unitCost/packSize/packCost/reorderLink onto each inventory item — those
// fields are vendor-specific (Costco's box of 100 vs BoundTree's box of 50)
// and don't belong on a single-vendor row. Each (item, vendor) pair is one
// independent row here.
//
// Concurrency: writes use an optimistic-lock ConditionExpression on
// `lastUpdatedAt`. Two users editing different (item, vendor) pairs at once
// don't conflict (different rows). Two users editing the same pair within
// the same instant: the second write returns 409 so the client can re-fetch
// and retry. Receive-flow auto-upserts skip the lock (last receive wins,
// which is the right semantic — the new receipt is "more current").
//
// Read paths:
//   - bootstrap returns all rows for the org (Scan filtered by orgId)
//   - item-detail modal could Query by itemId via the GSI for one item
//
// Write paths:
//   - POST /inventory/item-vendor-pricing — upsert one row (modal save,
//     receive flow auto-upsert)
//   - DELETE /inventory/item-vendor-pricing/:id — remove a (item, vendor)
//     entry the user no longer wants tracked

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../clients";
import { json } from "../http";
import { dimensionForUnit } from "../uom";
import { buildAuditEvent, writeAuditEvents } from "../audit";
import type {
  AccessContext,
  InventoryItemVendorPricing,
  InventoryStorage,
  RouteContext,
} from "../types";

/** Compose the deterministic PK for a (item, vendor) row. Vendor is
 *  lowercased + trimmed so casing variants ("Costco" / "costco" / "COSTCO")
 *  collapse to one row. */
const composePricingId = (itemId: string, vendor: string): string => {
  const v = vendor.trim().toLowerCase();
  return `${itemId}#${v}`;
};

/** List every vendor-pricing row for the org. Used by bootstrap so the
 *  client can build an in-memory `Map<itemId, Map<vendor, entry>>` once and
 *  read directly without per-item round trips. The Scan is acceptable at
 *  current scale (rows are small + capped by item × vendor cardinality);
 *  if it gets hot, we'd add a `byOrg` GSI and Query instead. */
export const listAllVendorPricing = async (
  storage: InventoryStorage,
  organizationId: string,
): Promise<InventoryItemVendorPricing[]> => {
  const out: InventoryItemVendorPricing[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: storage.vendorPricingTable,
        FilterExpression: "orgId = :orgId",
        ExpressionAttributeValues: { ":orgId": organizationId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(...((page.Items ?? []) as InventoryItemVendorPricing[]));
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return out;
};

/** Server-side helper used by the receive flow (1g.5) to upsert a vendor
 *  pricing row from the just-completed receipt. Last-write-wins on purpose:
 *  the new receipt is authoritatively the most current price, so there's no
 *  optimistic-lock check. Skips when vendor is empty or the line has no
 *  pricing/url info to record (nothing to seed). */
export const upsertVendorPricingFromReceive = async (
  storage: InventoryStorage,
  access: AccessContext,
  input: {
    itemId: string;
    vendor: string;
    /** 1h.7: count of items in the pack (e.g. 10 apples). */
    packCount?: number;
    /** 1h.7: bulk weight or volume in the pack (e.g. 5). */
    packAmount?: number;
    /** 1h.7: unit for `packAmount` (must be a weight or volume unit). */
    packAmountUnit?: string;
    packCost?: number;
    /** Per primary-unit cost from the receipt (e.g. $5.00/ct). When a direct
     *  `packCost` isn't supplied, this is converted into one using the vendor's
     *  known pack shape (× packCount or packAmount) so a price change entered at
     *  receive time flows back onto the vendor's current price. */
    unitCost?: number;
    reorderUrl?: string;
  },
): Promise<void> => {
  const vendor = input.vendor.trim();
  if (!vendor) return;
  if (
    input.packCount === undefined &&
    input.packAmount === undefined &&
    input.packCost === undefined &&
    input.unitCost === undefined &&
    !input.reorderUrl
  ) {
    return;
  }

  const id = `${input.itemId}#${vendor.toLowerCase()}`;
  const now = new Date().toISOString();

  // Read existing row first so we preserve fields the receipt didn't carry
  // (e.g. user-entered packLabel from the modal). Receive is updating the
  // priced fields; the label belongs to the item, not the receipt.
  let existing: Partial<InventoryItemVendorPricing> = {};
  try {
    const got = await ddb.send(
      new GetCommand({ TableName: storage.vendorPricingTable, Key: { id } }),
    );
    if (got.Item && String(got.Item.orgId) === access.organizationId) {
      existing = got.Item as InventoryItemVendorPricing;
    }
  } catch {
    /* best-effort — fall through to insert */
  }

  // Resolve the pack cost to store. A receipt carries a per-primary-unit cost
  // (`unitCost`); convert it to the pack cost using the vendor's known pack
  // shape (preferring an incoming axis, else the existing row's) so a price
  // changed at receive time updates the vendor's current price while leaving
  // the pack shape alone. A directly-supplied `packCost` always wins.
  let resolvedPackCost = input.packCost;
  if (
    resolvedPackCost === undefined
    && input.unitCost !== undefined
    && Number.isFinite(input.unitCost)
    && input.unitCost >= 0
  ) {
    const effPackCount = input.packCount ?? existing.packCount ?? existing.packSize;
    const effPackAmount = input.packAmount ?? existing.packAmount;
    if (effPackCount !== undefined && effPackCount > 0) {
      resolvedPackCost = input.unitCost * effPackCount;
    } else if (effPackAmount !== undefined && effPackAmount > 0) {
      resolvedPackCost = input.unitCost * effPackAmount;
    } else {
      resolvedPackCost = input.unitCost; // single / pack-of-one
    }
  }

  const merged: InventoryItemVendorPricing = {
    id,
    orgId: access.organizationId,
    module: "inventory",
    itemId: input.itemId,
    vendor,
    vendorLower: vendor.toLowerCase(),
    // 1h.7: dual-axis pack contents. Receive carries whichever axes the
    // order line specified — the other axis preserves any prior modal
    // edit so we don't clobber user-entered fields with undefined.
    ...(input.packCount !== undefined
      ? { packCount: input.packCount }
      : existing.packCount !== undefined ? { packCount: existing.packCount } : {}),
    ...(input.packAmount !== undefined
      ? { packAmount: input.packAmount }
      : existing.packAmount !== undefined ? { packAmount: existing.packAmount } : {}),
    ...(input.packAmountUnit !== undefined
      ? { packAmountUnit: input.packAmountUnit }
      : existing.packAmountUnit !== undefined ? { packAmountUnit: existing.packAmountUnit } : {}),
    ...(resolvedPackCost !== undefined
      ? { packCost: resolvedPackCost }
      : existing.packCost !== undefined ? { packCost: existing.packCost } : {}),
    // packLabel + reorderUrl: receive carries url (from order line) but not
    // label. Preserve label from existing row.
    ...(existing.packLabel ? { packLabel: existing.packLabel } : {}),
    ...(input.reorderUrl
      ? { reorderUrl: input.reorderUrl }
      : existing.reorderUrl ? { reorderUrl: existing.reorderUrl } : {}),
    // Legacy per-unit field: refresh it from the receipt's unit cost when
    // present so readers that still prefer `unitCost` (e.g. the receive
    // prefill) don't serve a stale price alongside the fresh packCost.
    ...(input.unitCost !== undefined
      ? { unitCost: input.unitCost }
      : existing.unitCost !== undefined ? { unitCost: existing.unitCost } : {}),
    ...(existing.packSize !== undefined ? { packSize: existing.packSize } : {}),
    lastUpdatedAt: now,
    lastUpdatedByUserId: access.userId,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: storage.vendorPricingTable,
        Item: merged,
      }),
    );
  } catch (err) {
    // Non-critical: receive completed; the pricing cache write is a best-
    // effort cache update. Log loudly so we can spot systemic failures.
    console.warn("upsertVendorPricingFromReceive: write failed", { id, err });
  }
};

/** Coerce a numeric request field — strings ("12.5") and numbers both
 *  accepted; "" / null / undefined → undefined. Returns null on invalid. */
const parseOptionalNumber = (raw: unknown): number | undefined | null => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
};

export const handleListVendorPricing = async (ctx: RouteContext) => {
  const { storage, access } = ctx;
  if (!access.allowedModules?.includes("inventory")) {
    return json(403, { error: "Inventory access required." });
  }
  const rows = await listAllVendorPricing(storage, access.organizationId);
  return json(200, { vendorPricing: rows });
};

export const handleUpsertVendorPricing = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can edit vendor pricing." });
  }

  const itemId = String(body?.itemId ?? "").trim();
  const vendor = String(body?.vendor ?? "").trim();
  if (!itemId) return json(400, { error: "itemId is required." });
  if (!vendor) return json(400, { error: "vendor is required." });

  const packCost = parseOptionalNumber(body?.packCost);
  if (packCost === null) return json(400, { error: "packCost must be a number." });

  // 1h.7: dual-axis pack contents. A row may carry packCount only,
  // packAmount + packAmountUnit only, or both (apples sold "5 lb / 10 ct").
  // We validate but never require the pair — partial info is allowed so
  // users can record what they see on the receipt without forcing them
  // to estimate the missing axis.
  const packCount = parseOptionalNumber(body?.packCount);
  if (packCount === null) return json(400, { error: "packCount must be a number." });
  if (packCount !== undefined && (!Number.isFinite(packCount) || packCount <= 0)) {
    return json(400, { error: "packCount must be greater than 0." });
  }

  const packAmount = parseOptionalNumber(body?.packAmount);
  if (packAmount === null) return json(400, { error: "packAmount must be a number." });
  if (packAmount !== undefined && (!Number.isFinite(packAmount) || packAmount <= 0)) {
    return json(400, { error: "packAmount must be greater than 0." });
  }

  let packAmountUnit: string | undefined;
  if (body?.packAmountUnit !== undefined && body?.packAmountUnit !== null) {
    const raw = String(body.packAmountUnit).trim().toLowerCase();
    if (raw) {
      const dim = dimensionForUnit(raw);
      if (!dim) {
        return json(400, { error: `Unknown unit "${body.packAmountUnit}".` });
      }
      if (dim === "count") {
        return json(400, {
          error: "packAmountUnit must be a weight or volume unit. Counts (ct/dozen) belong on packCount.",
        });
      }
      packAmountUnit = raw;
    }
  }
  if (packAmount !== undefined && !packAmountUnit) {
    return json(400, { error: "packAmount requires a packAmountUnit (lb/oz/g/kg/fl oz/cup/pt/qt/gal/ml/l)." });
  }

  const packLabel = body?.packLabel === undefined || body?.packLabel === null
    ? undefined
    : String(body.packLabel).trim() || undefined;
  const reorderUrl = body?.reorderUrl === undefined || body?.reorderUrl === null
    ? undefined
    : String(body.reorderUrl).trim() || undefined;

  // Optimistic-lock: client passes the lastUpdatedAt it last read; server
  // rejects with 409 if the stored row has changed since. Empty string
  // means "I expect no row" (first-time create). Skipped when the request
  // explicitly opts out via expectAnyVersion (used by receive auto-upsert
  // where last-write-wins is the intended semantic).
  const expectedLastUpdatedAt = typeof body?.expectedLastUpdatedAt === "string"
    ? body.expectedLastUpdatedAt
    : undefined;
  const expectAnyVersion = body?.expectAnyVersion === true;

  const id = composePricingId(itemId, vendor);
  const now = new Date().toISOString();

  const row: InventoryItemVendorPricing = {
    id,
    orgId: access.organizationId,
    module: "inventory",
    itemId,
    vendor, // canonical case as supplied
    vendorLower: vendor.toLowerCase(),
    ...(packCost !== undefined ? { packCost } : {}),
    ...(packCount !== undefined ? { packCount } : {}),
    ...(packAmount !== undefined ? { packAmount } : {}),
    ...(packAmountUnit ? { packAmountUnit } : {}),
    ...(packLabel ? { packLabel } : {}),
    ...(reorderUrl ? { reorderUrl } : {}),
    lastUpdatedAt: now,
    lastUpdatedByUserId: access.userId,
  };

  // Read the prior row before writing so we can tell whether the PRICE actually
  // changed (a URL-only edit shouldn't log a price point) and derive the old
  // $/unit for comparison. Best-effort — absence just means "treat as new".
  let priorEntry: InventoryItemVendorPricing | undefined;
  try {
    const got = await ddb.send(
      new GetCommand({ TableName: storage.vendorPricingTable, Key: { id } }),
    );
    if (got.Item && String(got.Item.orgId) === access.organizationId) {
      priorEntry = got.Item as InventoryItemVendorPricing;
    }
  } catch { /* best-effort */ }

  const putCmd = expectAnyVersion
    ? new PutCommand({ TableName: storage.vendorPricingTable, Item: row })
    : new PutCommand({
        TableName: storage.vendorPricingTable,
        Item: row,
        // Empty string ⇒ expect-no-row (creating). Otherwise expect the
        // exact stored timestamp the client read.
        ConditionExpression:
          expectedLastUpdatedAt
            ? "lastUpdatedAt = :expected"
            : "attribute_not_exists(id)",
        ...(expectedLastUpdatedAt
          ? { ExpressionAttributeValues: { ":expected": expectedLastUpdatedAt } }
          : {}),
      });

  try {
    await ddb.send(putCmd);
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      // Re-fetch and return the current row so the client can show the
      // user what changed and let them retry.
      const current = await ddb.send(
        new GetCommand({ TableName: storage.vendorPricingTable, Key: { id } }),
      );
      return json(409, {
        error: "This vendor pricing was edited by someone else. Refresh and try again.",
        current: current.Item ?? null,
      });
    }
    throw err;
  }

  // Record the price change on the item's audit history so cost-over-time and
  // the activity feed reflect vendor-price edits — not just receipts. Derive
  // $/unit the same way the receive path + UI do (count axis first, then bulk
  // amount, else the pack cost stands as the unit cost). Best-effort: the save
  // itself already succeeded, so a failed audit write must not fail the request.
  const deriveUnit = (pc?: number, cnt?: number, amt?: number): number | undefined => {
    if (pc === undefined || !Number.isFinite(pc)) return undefined;
    if (cnt !== undefined && cnt > 0) return pc / cnt;
    if (amt !== undefined && amt > 0) return pc / amt;
    return pc;
  };
  const newUnit = deriveUnit(packCost, packCount, packAmount);
  const priorPackCount = typeof priorEntry?.packCount === "number"
    ? priorEntry.packCount
    : (typeof priorEntry?.packSize === "number" ? priorEntry.packSize : undefined);
  const oldUnit = deriveUnit(
    typeof priorEntry?.packCost === "number" ? priorEntry.packCost : undefined,
    priorPackCount,
    typeof priorEntry?.packAmount === "number" ? priorEntry.packAmount : undefined,
  );
  if (
    newUnit !== undefined && Number.isFinite(newUnit) && newUnit >= 0
    && (oldUnit === undefined || Math.abs(newUnit - oldUnit) >= 0.005)
  ) {
    let itemName = "";
    try {
      const it = await ddb.send(new GetCommand({ TableName: storage.itemTable, Key: { id: itemId } }));
      if (it.Item) {
        try { itemName = String(JSON.parse(String(it.Item.valuesJson ?? "{}")).itemName ?? ""); } catch { /* ignore */ }
      }
    } catch { /* best-effort */ }
    try {
      await writeAuditEvents(storage.auditTable, [
        buildAuditEvent(access, "VENDOR_PRICE_EDIT", itemId, itemName, {
          vendor,
          unitCost: newUnit,
          ...(packCost !== undefined ? { packCost } : {}),
          ...(packCount !== undefined ? { packCount } : {}),
        }),
      ]);
    } catch (err) {
      console.error("vendor price audit write failed", err);
    }
  }

  return json(200, { entry: row });
};

export const handleDeleteVendorPricing = async (ctx: RouteContext) => {
  const { storage, access, path } = ctx;
  if (!access.canEditInventory) {
    return json(403, { error: "Only editors and admins can edit vendor pricing." });
  }

  // Path shape: /inventory/item-vendor-pricing/:id where :id is the
  // already-composed `${itemId}#${vendorLower}` string. We accept the id
  // verbatim from the client (it's safe — composePricingId is a pure
  // function of inputs the client already has).
  const tail = path.split("/").pop();
  const id = decodeURIComponent(tail ?? "").trim();
  if (!id) return json(400, { error: "id is required." });

  // Best-effort orgId guard before delete: a row from another org with the
  // same id (collision-vanishingly-unlikely but cheap to check) shouldn't
  // be deletable here.
  const existing = await ddb.send(
    new GetCommand({ TableName: storage.vendorPricingTable, Key: { id } }),
  );
  if (!existing.Item) return json(200, { ok: true });
  if (String(existing.Item.orgId) !== access.organizationId) {
    return json(404, { error: "Not found." });
  }

  await ddb.send(
    new DeleteCommand({ TableName: storage.vendorPricingTable, Key: { id } }),
  );
  return json(200, { ok: true });
};
