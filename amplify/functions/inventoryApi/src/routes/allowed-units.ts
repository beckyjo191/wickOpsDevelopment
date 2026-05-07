// ── Allowed-units handlers (1h.2) ───────────────────────────────────────────
// Per-org curation of which units appear in inventory + receipt-entry
// dropdowns. Without this, every org sees the full KNOWN_UNITS list (ct,
// dozen, oz, lb, g, kg, fl oz, cup, pt, qt, gal, ml, l) — overkill for an
// EMS cabinet that only ever uses ct + dozen, and noisy for a household
// pantry that doesn't deal in metric volumes.
//
// Storage shape: a single "meta" row on the columns table with
//   { id, module, kind: "meta", units: string[] }
// keyed by `inventory-meta-allowed-units`. Living on the columns table
// matches the existing pattern (migration meta, vendors meta) and avoids
// provisioning a new table for one row of state.
//
// Validation: the server only accepts units present in KNOWN_UNITS. This is
// the same set both the backend uom.ts and the frontend lib/uom.ts know
// about — so a unit added here is guaranteed to canonicalize for pricing.

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../clients";
import { json } from "../http";
import type { InventoryStorage, RouteContext } from "../types";

const ALLOWED_UNITS_META_ID = "inventory-meta-allowed-units";

/** Master list of unit strings the server recognizes. Mirrors the FACTORS
 *  table in uom.ts — anything outside this list can't be canonicalized for
 *  per-vendor price comparison, so we don't allow it as an allowed unit. */
const KNOWN_UNIT_SET = new Set<string>([
  "ct", "dozen",
  "oz", "lb", "g", "kg",
  "fl oz", "cup", "pt", "qt", "gal", "ml", "l",
]);

/** Default list when an org hasn't curated yet. Matches the frontend's
 *  KNOWN_UNITS order so a fresh org sees the same picker as legacy code
 *  paths fell back to. Onboarding templates can override this with a
 *  narrower set (e.g. fire/EMS = [ct, dozen]). */
const DEFAULT_UNITS: string[] = [
  "ct", "dozen",
  "oz", "lb", "g", "kg",
  "fl oz", "cup", "pt", "qt", "gal", "ml", "l",
];

/** Read the org's allowed-units list AND the org-wide tracksUnits gate.
 *
 *  `tracksUnits` defaults to **false** for new orgs (EMS-style: count
 *  only, no UoM). Pantry / restaurant orgs explicitly turn it on via
 *  Settings to surface weight/volume tracking, $/lb price-trend math,
 *  and the dual-axis Pack form. Existing orgs that pre-date the gate
 *  default to `false` too — they can flip it on if they actually want
 *  the feature, and nothing in the EMS-style flow breaks if they don't. */
export const getAllowedUnits = async (
  storage: InventoryStorage,
): Promise<{ units: string[]; tracksUnits: boolean }> => {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: storage.columnTable,
        Key: { id: ALLOWED_UNITS_META_ID },
      }),
    );
    const stored = result.Item?.units;
    // Treat a stored `true` as on; any other shape (false / undefined /
    // null) is off. Default-off keeps EMS as the simpler flow and avoids
    // surprising orgs with extra UI when they didn't ask for it.
    const tracksUnits = result.Item?.tracksUnits === true;
    if (Array.isArray(stored) && stored.every((u) => typeof u === "string")) {
      const filtered = (stored as string[]).filter((u) => KNOWN_UNIT_SET.has(u));
      return {
        units: filtered.length > 0 ? filtered : DEFAULT_UNITS,
        tracksUnits,
      };
    }
    return { units: DEFAULT_UNITS, tracksUnits };
  } catch (err) {
    console.warn("getAllowedUnits read failed", err);
  }
  return { units: DEFAULT_UNITS, tracksUnits: false };
};

export const handleGetAllowedUnits = async (ctx: RouteContext) => {
  const { storage, access } = ctx;
  if (!access.allowedModules?.includes("inventory")) {
    return json(403, { error: "Inventory access required." });
  }
  const { units, tracksUnits } = await getAllowedUnits(storage);
  return json(200, { units, tracksUnits, knownUnits: Array.from(KNOWN_UNIT_SET) });
};

export const handleSetAllowedUnits = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, {
      error: "Only org admins can change the allowed-units list.",
    });
  }

  // tracksUnits is the org-wide UoM gate. When false, the front-end
  // hides the Amount + Unit fields in the i modal entirely so EMS-style
  // orgs see a simple Vendor/Type/Cost form. When true, those fields
  // become available so pantry/restaurant orgs can capture weight/volume
  // for $/lb price-trend math.
  const tracksUnitsRaw = body?.tracksUnits;
  const tracksUnits =
    typeof tracksUnitsRaw === "boolean" ? tracksUnitsRaw : false;

  const raw = body?.units;
  if (!Array.isArray(raw)) {
    return json(400, { error: "units must be an array of strings." });
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const u of raw) {
    if (typeof u !== "string") continue;
    const norm = u.trim().toLowerCase();
    if (!norm) continue;
    if (!KNOWN_UNIT_SET.has(norm)) {
      return json(400, { error: `Unknown unit: "${u}". Allowed values: ${Array.from(KNOWN_UNIT_SET).join(", ")}.` });
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    cleaned.push(norm);
  }
  // Only require a non-empty list when tracking is on. With tracking
  // off, the list is dormant — flipping the toggle back on later
  // restores whatever the user had picked before.
  if (tracksUnits && cleaned.length === 0) {
    return json(400, { error: "Pick at least one allowed unit." });
  }

  await ddb.send(
    new PutCommand({
      TableName: storage.columnTable,
      Item: {
        id: ALLOWED_UNITS_META_ID,
        module: "inventory",
        kind: "meta",
        units: cleaned,
        tracksUnits,
        updatedAt: new Date().toISOString(),
        updatedByUserId: access.userId,
      },
    }),
  );

  return json(200, { units: cleaned, tracksUnits });
};

export { KNOWN_UNIT_SET };
