// ── Foundation: types.ts ────────────────────────────────────────────────────
// Pure type definitions extracted from handler.ts. No runtime code.

export type InventoryColumnType = "text" | "number" | "date" | "link" | "boolean";

export type UserRecord = {
  id: string;
  email?: string;
  displayName?: string;
  organizationId?: string;
  role?: string;
  accessSuspended?: boolean;
  allowedModules?: unknown;
  columnVisibility?: string;
};

/** Discriminator for the rows stored in a per-org "columns" table.
 *  Pre-migration rows (the original column shape) lack this field — readers
 *  treat absent `kind` as `"column"`. The migration backfills.
 *  - "column"   → InventoryColumn metadata
 *  - "location" → InventoryLocation entity
 *  - "meta"     → singletons like the vendors registry, migration version stamp
 */
export type InventoryRowKind = "column" | "location" | "meta";

export type InventoryColumn = {
  id: string;
  organizationId: string;
  module: "inventory";
  /** Always "column" for column rows. Optional in the type because pre-migration
   *  rows lack the field; readers default to "column". */
  kind?: "column";
  key: string;
  label: string;
  type: InventoryColumnType;
  isCore: boolean;
  isRequired: boolean;
  isVisible: boolean;
  isEditable: boolean;
  /** Whether this column shows a "filter by value" header dropdown.
   *  Replaces the previous hardcoded `column.key === "category"` branch.
   *  Absent in pre-migration rows; readers default to false. */
  isGroupable?: boolean;
  sortOrder: number;
  /** Locations where this custom column renders. Ignored for core columns
   *  (they render everywhere). Empty array = dormant (defined but unrendered).
   *  Absent in pre-migration rows; the migration auto-attaches every existing
   *  custom column to every location to preserve current behavior. */
  attachedLocationIds?: string[];
  createdAt: string;
};

/** Per-org location entity. Stored as a row in the same DynamoDB table as
 *  columns, distinguished by `kind: "location"`. Replaces the previous
 *  `inventory-meta-locations` singleton blob.
 */
export type InventoryLocation = {
  id: string;
  organizationId: string;
  module: "inventory";
  kind: "location";
  name: string;
  sortOrder: number;
  createdAt: string;
};

export type InventoryItem = {
  id: string;
  organizationId: string;
  module: "inventory";
  position: number;
  /** Structural location pointer. Required after migration v1. Pre-migration
   *  rows lack this field; readers fall back to the legacy `values.location`
   *  string only inside the migration code path itself. */
  locationId?: string;
  valuesJson: string;
  createdAt: string;
  updatedAtCustom: string;
};

export type AccessContext = {
  userId: string;
  email: string;
  displayName: string;
  organizationId: string;
  role: string;
  /** Modules the org owner has activated (intersection of plan-available + owner-enabled) */
  orgEnabledModules: ModuleKey[];
  /** User's personal module subset — already intersected against orgEnabledModules */
  allowedModules: ModuleKey[];
  canEditInventory: boolean;
  canManageColumns: boolean;
  columnVisibilityOverrides: Record<string, boolean>;
};

export type InventoryStorage = {
  columnTable: string;
  itemTable: string;
  pendingTable: string;
  auditTable: string;
  restockOrdersTable: string;
  /** 1g: per-(item, vendor) pricing rows. Replaces the previous pattern of
   *  storing unitCost/packSize/packCost/reorderLink on each inventory item.
   *  Pricing is vendor-specific (Costco's box of 100 vs BoundTree's box of
   *  50), so an item can carry multiple rows — one per vendor it's bought
   *  from. PK is `${itemId}#${vendorLower}` for direct lookup; GSI by
   *  itemId for "all vendors that sell this item." */
  vendorPricingTable: string;
};

/** A row in the vendorPricingTable. */
export type InventoryItemVendorPricing = {
  /** `${itemId}#${vendorLower}` — composite PK string. */
  id: string;
  orgId: string;
  module: "inventory";
  /** Inventory item id this pricing belongs to. */
  itemId: string;
  /** Vendor name in canonical (registered) casing — e.g. "BoundTree". */
  vendor: string;
  /** Lowercased vendor for case-insensitive lookups. Stored alongside the
   *  canonical case so the matchup is unambiguous. */
  vendorLower: string;
  /** Per-unit price in the item's primary unit. e.g. $0.83/ct.
   *  1h.7: kept readable for legacy rows but no longer written. New rows
   *  derive $/ct or $/lb at display time from `packCost ÷ packCount` or
   *  `packCost ÷ packAmount`. */
  unitCost?: number;
  /** 1h.7 legacy: units per pack from this vendor. e.g. 100 for a Costco
   *  box of pads. New rows store this as `packCount` instead — `packSize`
   *  stays readable for transitional reads. Frontend prefers packCount
   *  when present. */
  packSize?: number;
  /** Total $ for one pack from this vendor. e.g. $24.99 for the box. The
   *  single source of cost truth post-1h.7 — both $/ct and $/lb derive
   *  from this divided by the relevant axis. */
  packCost?: number;

  // ── 1h.7: dual-axis pack contents ──────────────────────────────────────
  // A single (item, vendor) pricing row can carry up to TWO independent
  // measurements of what's inside one pack at this vendor. Both share the
  // same `packCost`. This lets a row like "5 lb / 10 ct apples for $4.99"
  // exist as one entity, with both `$/lb` and `$/apple` derivable from it.
  //
  // Combinations:
  //   - `packCount` only          → count-style (gauze, syringes — same
  //                                 as today's count packs).
  //   - `packAmount` + `packAmountUnit` only → bulk weight/volume (flour
  //                                 by lb, milk by fl oz).
  //   - both                      → mixed (apples sold "5 lb / 10 ct").
  //                                 Conversion ratio = packAmount ÷
  //                                 packCount → drives log-usage math.

  /** Number of countable items in one pack. e.g. 10 apples; 100 gauze;
   *  1 for a single-unit purchase. */
  packCount?: number;
  /** Bulk weight or volume in one pack. e.g. 5 (lb); 16 (fl oz); 2.5 (kg).
   *  Always a positive number; pair with `packAmountUnit`. */
  packAmount?: number;
  /** Unit for `packAmount` — must be a weight or volume unit
   *  (lb/oz/g/kg/fl oz/cup/pt/qt/gal/ml/l). Count units (ct, dozen) belong
   *  on `packCount` instead. The receive flow + frontend reject mismatched
   *  pairings. */
  packAmountUnit?: string;

  /** Optional human label for the pack ("box", "bag", "jug"). Defaults to
   *  "pack" in display when absent. */
  packLabel?: string;
  /** Per-vendor reorder URL — Costco's product page differs from BoundTree's
   *  for the same item, so this lives per-row instead of on the inventory
   *  row itself. */
  reorderUrl?: string;
  /** Last edit timestamp. Drives optimistic-locking ConditionExpressions on
   *  multi-user writes. */
  lastUpdatedAt: string;
  lastUpdatedByUserId: string;
};

export type ModuleKey = "inventory";

export type AuditAction =
  | "ITEM_CREATE"
  | "ITEM_EDIT"
  | "ITEM_DELETE"
  /** Structural location move. Body shape: { fromLocationId, fromLocationName,
   *  toLocationId, toLocationName }. Replaces the prior pattern of recording
   *  location changes as ordinary ITEM_EDIT diffs. */
  | "ITEM_MOVE"
  /** Quantity decrement with a loss reason (see RetireReason). */
  | "ITEM_RETIRE"
  /** Reverses a previous ITEM_RETIRE: clears the retire markers and marks the
   *  original event as undone. Soft-delete becomes "still in service" again. */
  | "ITEM_UNRETIRE"
  | "USAGE_SUBMIT"
  | "USAGE_APPROVE"
  | "USAGE_REJECT"
  /** Reverses a previous USAGE_APPROVE: re-adds the decremented quantity and
   *  marks the original event with `undone: true` so the Undo button hides. */
  | "USAGE_UNDO"
  | "COLUMN_CREATE"
  | "COLUMN_DELETE"
  /** Reverses a previous COLUMN_DELETE: recreates the column from the snapshot
   *  stamped on the original event. Existing item values for that column are
   *  preserved (delete only removes the column metadata, not per-row values). */
  | "COLUMN_RESTORE"
  | "COLUMN_UPDATE"
  /** Per-org location lifecycle. The previous behavior buried this inside
   *  the values-JSON of every affected row; now it's a first-class event. */
  | "LOCATION_CREATE"
  | "LOCATION_RENAME"
  | "LOCATION_DELETE"
  | "CSV_IMPORT"
  | "TEMPLATE_APPLY"
  | "RESTOCK_ORDER_CREATE"
  | "RESTOCK_RECEIVED"
  | "RESTOCK_ORDER_CLOSED"
  /** Fast Restock: quantity added directly to an inventory row (not via an order). */
  | "RESTOCK_ADDED"
  /** One-shot record of a schema migration applying to the org (e.g. v0 → v1
   *  when location goes structural). Body shape: { fromVersion, toVersion,
   *  itemsMovedToDefault, locationsCreated }. */
  | "MIGRATION_APPLY";

/** Reason codes attached to ITEM_RETIRE events. Drives loss analytics.
 *
 *  - expired: past expiration date.
 *  - damaged: physically broken or otherwise unusable.
 *  - lost: stock can't be found.
 *  - recalled: pulled per a manufacturer/safety recall.
 *  - discontinued: org no longer carries this item; pulled and discarded
 *    while still otherwise usable. Separable from "lost" so analytics can
 *    distinguish intentional discards from missing stock.
 *
 *  Note: a row that was a setup mistake (never actually stocked) is
 *  hard-deleted via ITEM_DELETE rather than retired — there's no loss to
 *  record. The Remove dialog surfaces that as a separate option.
 */
export type RetireReason = "expired" | "damaged" | "lost" | "recalled" | "discontinued";

export const RETIRE_REASONS: RetireReason[] = ["expired", "damaged", "lost", "recalled", "discontinued"];

export type PendingEntry = {
  itemId: string;
  itemName: string;
  quantityUsed: number;
  notes?: string;
  location?: string;
};

export type PendingSubmission = {
  id: string;
  submittedAt: string;
  submittedByUserId: string;
  submittedByEmail: string;
  submittedByName: string;
  status: "pending" | "approved" | "rejected";
  entriesJson: string;
  reviewedAt?: string;
  reviewedByUserId?: string;
  reviewedByEmail?: string;
  rejectionReason?: string;
};

export type TemplateColumn = {
  label: string;
  type: InventoryColumnType;
};

export type IndustryTemplate = {
  id: string;
  name: string;
  description: string;
  columns: TemplateColumn[];
  /** 1h.2d: per-template default allowed-units list. Seeded onto the org's
   *  meta row when the template is applied so EMS / kitchen / etc. see
   *  only relevant units in pickers from day one. Optional — templates
   *  that don't specify get the full KNOWN_UNITS default. */
  allowedUnits?: string[];
};

export type RestockOrderStatus = "open" | "partial" | "closed";

export type RestockOrderItem = {
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost?: number;
  // For freeform items: vendor URL captured at order time so that when the
  // item is later added to inventory on receive, the link is persisted on the
  // new inventory row.
  reorderLink?: string;
  /** For freeform items: structural location pointer captured at order time.
   *  Persisted to the new inventory row's `locationId` on receive. Preferred
   *  over the legacy `location` (name) field. */
  locationId?: string;
  /** Legacy: location name captured at order time for orders created before
   *  the v1 restructure. Receive falls back to resolving this to a locationId
   *  if `locationId` is absent. */
  location?: string;
  // For freeform items: user-provided reorder threshold captured at order
  // time. When the item is later added to inventory on receive (or materialized
  // on cancel), this becomes the row's minQuantity so future reorder logic
  // triggers correctly. Falls back to qtyOrdered when absent.
  minQuantity?: number;
  // For freeform items: pack size (units per box). Persisted to the new
  // inventory row on receive so box-mode receiving / unit-cost derivation
  // work next time.
  packSize?: number;
  // For freeform items: pack cost (price per box). Persisted to the new
  // inventory row on receive.
  packCost?: number;
  // ── 1b: amount/UoM/price model (additive) ─────────────────────────────────
  // Captures what the user actually bought in human terms ("2.5 lb beef for
  // $14.99"). The server derives `pricePerCanonical` via uom.ts so the
  // shopping-list view (1d) can do per-vendor $/canonical comparisons
  // without re-running unit math at read time.
  //
  // Optional in 1b: old clients still send unitCost/packSize/packCost.
  // Receipt-entry rebuild (1c) populates these for new orders; migration (1e)
  // backfills synthetic order lines that carry these fields too.
  /** Amount the user purchased, in `purchaseUnit` (e.g. 2.5 for "2.5 lb"). */
  purchaseAmount?: number;
  /** Unit-of-measure for purchaseAmount (e.g. "lb", "fl oz", "ct"). */
  purchaseUnit?: string;
  /** Total $ paid for this purchase line (the receipt amount). */
  purchasePrice?: number;
  /** Server-derived $ per canonical unit for the item's dimension. Used by
   *  per-vendor price comparison queries. Persisted so reads don't re-derive. */
  pricePerCanonical?: number;
  /** Item dimension at the time this line was created (count|weight|volume).
   *  Persisted on the line so a later change to the item's dimension doesn't
   *  retroactively break price-history math. */
  dimension?: "count" | "weight" | "volume";
  /** True for migration-injected historical lines (1e). Lets analytics
   *  decide whether to include synthesized data in "best price" rollups. */
  synthetic?: boolean;
};

export type RestockReceiveLine = {
  itemId: string;
  qtyThisReceive: number;
  expirationDate?: string;
  unitCost?: number;
  addToInventory?: boolean;
};

export type RestockReceiveEvent = {
  receivedAt: string;
  receivedByUserId: string;
  receivedByName: string;
  lines: RestockReceiveLine[];
  closedOrder: boolean;
};

export type RestockOrder = {
  id: string;
  orgId: string;
  status: RestockOrderStatus;
  vendor?: string;
  notes?: string;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  itemsJson: string;
  receivesJson: string;
  closedAt?: string;
  closedByUserId?: string;
  closedByName?: string;
};

export type LambdaResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type RouteContext = {
  access: AccessContext;
  storage: InventoryStorage;
  body: any;
  path: string;
  query: Record<string, string | undefined>;
};
