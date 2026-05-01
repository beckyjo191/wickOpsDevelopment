// ── Migration planner: pure logic ───────────────────────────────────────────
// Zero AWS / DDB imports — the planner reads a "world" snapshot of the org and
// returns a list of writes to apply. The DDB-bound wrapper lives in
// migration.ts; the test file imports from this module so it can run on
// `node --test` without bundling AWS SDK code.

import type { InventoryColumn, InventoryLocation } from "./types";

export const TARGET_MIGRATION_VERSION = 1;
export const MIGRATION_META_ID = "inventory-meta-migration";
export const LEGACY_LOCATIONS_REGISTRY_ID = "inventory-meta-locations";
export const DEFAULT_LOCATION_NAME = "Default";

// ── Types ──────────────────────────────────────────────────────────────────

/** Raw row from the per-org columns table (any kind: column, location, meta). */
export type ColumnTableRow = Record<string, unknown> & {
  id: string;
  module?: string;
  kind?: string;
};

/** Raw row from the per-org items table. */
export type ItemTableRow = {
  id: string;
  valuesJson: string;
  locationId?: string;
  position?: number;
  createdAt?: string;
  updatedAtCustom?: string;
};

export type MigrationWorld = {
  organizationId: string;
  migrationVersion: number;
  columnTableRows: ColumnTableRow[];
  itemRows: ItemTableRow[];
};

/** Single column row mutation. PUT semantics: write the full row. */
export type ColumnRowWrite = ColumnTableRow & {
  module: "inventory";
};

export type ItemPatch = {
  id: string;
  locationId: string;
  nextValuesJson: string;
};

export type AuditEventStub = {
  action: "MIGRATION_APPLY" | "LOCATION_CREATE";
  itemId: string | null;
  itemName: string | null;
  details: Record<string, unknown>;
};

export type MigrationPlan = {
  reason: "already-migrated" | "v0-to-v1";
  fromVersion: number;
  toVersion: number;
  rowWrites: ColumnRowWrite[];
  columnPatches: Array<{
    id: string;
    isCore?: boolean;
    isGroupable?: boolean;
    attachedLocationIds?: string[];
    kind?: "column";
  }>;
  columnDeletes: string[];
  itemPatches: ItemPatch[];
  auditEvents: AuditEventStub[];
  toastMessage: string | null;
  itemsMovedToDefaultCount: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const isColumnRow = (row: ColumnTableRow): boolean =>
  row.kind === undefined || row.kind === null || row.kind === "column";
const isLocationRow = (row: ColumnTableRow): boolean => row.kind === "location";
const isMetaRow = (row: ColumnTableRow): boolean => row.kind === "meta";

const safeParse = (raw: string | undefined | null): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeNameForCompare = (name: string): string => name.trim().toLowerCase();

/** New core column set (post-restructure). Kept here so the planner is
 *  self-contained — must stay in sync with columns.ts `defaults`. */
const NEW_CORE_COLUMNS: Array<Omit<InventoryColumn, "id" | "organizationId">> = [
  { module: "inventory", kind: "column", key: "itemName", label: "Item Name", type: "text", isCore: true, isRequired: true, isVisible: true, isEditable: true, isGroupable: false, sortOrder: 10, createdAt: "" },
  { module: "inventory", kind: "column", key: "quantity", label: "Quantity", type: "number", isCore: true, isRequired: false, isVisible: true, isEditable: true, isGroupable: false, sortOrder: 20, createdAt: "" },
  { module: "inventory", kind: "column", key: "minQuantity", label: "Min Quantity", type: "number", isCore: true, isRequired: false, isVisible: true, isEditable: true, isGroupable: false, sortOrder: 30, createdAt: "" },
  { module: "inventory", kind: "column", key: "vendor", label: "Vendor", type: "text", isCore: true, isRequired: false, isVisible: false, isEditable: true, isGroupable: false, sortOrder: 40, createdAt: "" },
  { module: "inventory", kind: "column", key: "reorderLink", label: "Product URL", type: "link", isCore: true, isRequired: false, isVisible: true, isEditable: true, isGroupable: false, sortOrder: 50, createdAt: "" },
  { module: "inventory", kind: "column", key: "unitCost", label: "Unit Cost", type: "number", isCore: true, isRequired: false, isVisible: false, isEditable: false, isGroupable: false, sortOrder: 60, createdAt: "" },
  { module: "inventory", kind: "column", key: "packSize", label: "Pack Size", type: "number", isCore: true, isRequired: false, isVisible: false, isEditable: true, isGroupable: false, sortOrder: 70, createdAt: "" },
  { module: "inventory", kind: "column", key: "packCost", label: "Pack Cost", type: "number", isCore: true, isRequired: false, isVisible: false, isEditable: true, isGroupable: false, sortOrder: 80, createdAt: "" },
  { module: "inventory", kind: "column", key: "notes", label: "Notes", type: "text", isCore: true, isRequired: false, isVisible: true, isEditable: true, isGroupable: false, sortOrder: 90, createdAt: "" },
  { module: "inventory", kind: "column", key: "category", label: "Category", type: "text", isCore: true, isRequired: false, isVisible: true, isEditable: true, isGroupable: true, sortOrder: 100, createdAt: "" },
];

// ── Planner ────────────────────────────────────────────────────────────────

export const planMigration = (
  world: MigrationWorld,
  opts: {
    now: () => string;
    uuid: () => string;
  },
): MigrationPlan => {
  if (world.migrationVersion >= TARGET_MIGRATION_VERSION) {
    return {
      reason: "already-migrated",
      fromVersion: world.migrationVersion,
      toVersion: world.migrationVersion,
      rowWrites: [],
      columnPatches: [],
      columnDeletes: [],
      itemPatches: [],
      auditEvents: [],
      toastMessage: null,
      itemsMovedToDefaultCount: 0,
    };
  }

  const now = opts.now();
  const orgId = world.organizationId;
  const rowWrites: ColumnRowWrite[] = [];
  const columnPatches: MigrationPlan["columnPatches"] = [];
  const columnDeletes: string[] = [];
  const itemPatches: ItemPatch[] = [];
  const auditEvents: AuditEventStub[] = [];

  // ── Step 1: classify existing column-table rows ────────────────────────
  const existingColumns = world.columnTableRows.filter(isColumnRow);
  const existingLocations = world.columnTableRows.filter(isLocationRow);
  void existingLocations; // referenced via existingLocByName below
  void isMetaRow; // used implicitly via the !isColumnRow && !isLocationRow paths
  const existingByKey = new Map<string, ColumnTableRow>(
    existingColumns
      .filter((c) => typeof c.key === "string")
      .map((c) => [String(c.key), c]),
  );

  // ── Step 2: enumerate location names ────────────────────────────────────
  const legacyRegistry = world.columnTableRows.find(
    (r) => r.id === LEGACY_LOCATIONS_REGISTRY_ID,
  );
  const namesFromRegistry: string[] = Array.isArray(legacyRegistry?.locations)
    ? (legacyRegistry!.locations as unknown[]).map((v) => String(v ?? "").trim()).filter((v) => v.length > 0)
    : [];
  const namesFromItems: string[] = [];
  for (const item of world.itemRows) {
    const values = safeParse(item.valuesJson);
    const raw = String(values.location ?? "").trim();
    if (raw.length > 0) namesFromItems.push(raw);
  }

  const allNames = Array.from(new Set([...namesFromRegistry, ...namesFromItems]));
  allNames.sort((a, b) => a.localeCompare(b));

  const existingLocByName = new Map<string, InventoryLocation>();
  for (const loc of existingLocations) {
    existingLocByName.set(
      normalizeNameForCompare(String(loc.name ?? "")),
      loc as unknown as InventoryLocation,
    );
  }

  const locationsByLowerName = new Map<string, InventoryLocation>();
  let nextSortOrder = 10;
  for (const name of allNames) {
    const lower = normalizeNameForCompare(name);
    if (locationsByLowerName.has(lower)) continue;
    const existing = existingLocByName.get(lower);
    if (existing) {
      locationsByLowerName.set(lower, existing);
      continue;
    }
    const created: InventoryLocation = {
      id: opts.uuid(),
      organizationId: orgId,
      module: "inventory",
      kind: "location",
      name,
      sortOrder: nextSortOrder,
      createdAt: now,
    };
    nextSortOrder += 10;
    rowWrites.push(created as ColumnRowWrite);
    locationsByLowerName.set(lower, created);
    auditEvents.push({
      action: "LOCATION_CREATE",
      itemId: null,
      itemName: null,
      details: { locationId: created.id, name: created.name, source: "migration" },
    });
  }

  // ── Step 3: stamp locationId on every item ──────────────────────────────
  let needsDefault = false;
  for (const item of world.itemRows) {
    if (item.locationId) continue;
    const values = safeParse(item.valuesJson);
    const raw = String(values.location ?? "").trim();
    if (raw.length === 0) {
      needsDefault = true;
      break;
    }
  }

  let defaultLocation: InventoryLocation | null = null;
  if (needsDefault) {
    const lower = normalizeNameForCompare(DEFAULT_LOCATION_NAME);
    defaultLocation = locationsByLowerName.get(lower) ?? null;
    if (!defaultLocation) {
      defaultLocation = {
        id: opts.uuid(),
        organizationId: orgId,
        module: "inventory",
        kind: "location",
        name: DEFAULT_LOCATION_NAME,
        sortOrder: nextSortOrder,
        createdAt: now,
      };
      nextSortOrder += 10;
      rowWrites.push(defaultLocation as ColumnRowWrite);
      locationsByLowerName.set(lower, defaultLocation);
      auditEvents.push({
        action: "LOCATION_CREATE",
        itemId: null,
        itemName: null,
        details: { locationId: defaultLocation.id, name: defaultLocation.name, source: "migration-default" },
      });
    }
  }

  let itemsMovedToDefaultCount = 0;
  for (const item of world.itemRows) {
    if (item.locationId) continue;
    const values = safeParse(item.valuesJson);
    const raw = String(values.location ?? "").trim();
    let locationId: string;
    if (raw.length === 0) {
      if (!defaultLocation) continue;
      locationId = defaultLocation.id;
      itemsMovedToDefaultCount += 1;
    } else {
      const matched = locationsByLowerName.get(normalizeNameForCompare(raw));
      if (!matched) continue;
      locationId = matched.id;
    }
    delete values.location;
    itemPatches.push({
      id: item.id,
      locationId,
      nextValuesJson: JSON.stringify(values),
    });
  }

  // ── Step 4: demote expirationDate from core to custom ───────────────────
  const expCol = existingByKey.get("expirationDate");
  if (expCol && expCol.isCore !== false) {
    const allLocIds = Array.from(locationsByLowerName.values()).map((l) => l.id);
    columnPatches.push({
      id: String(expCol.id),
      isCore: false,
      attachedLocationIds: allLocIds,
      kind: "column",
    });
  }

  // ── Step 5: delete the location core column ─────────────────────────────
  const locCol = existingByKey.get("location");
  if (locCol) columnDeletes.push(String(locCol.id));

  // ── Step 6: auto-attach existing custom columns to every location ──────
  const allLocIds = Array.from(locationsByLowerName.values()).map((l) => l.id);
  for (const col of existingColumns) {
    const isCore = Boolean(col.isCore);
    const key = String(col.key ?? "");
    if (key === "location" || key === "expirationDate") continue;
    if (isCore) continue;
    // Skip columns that already have user-configured attachments.
    const alreadyAttached = Array.isArray(col.attachedLocationIds)
      ? (col.attachedLocationIds as unknown[]).map(String)
      : null;
    if (alreadyAttached && alreadyAttached.length > 0) continue;
    columnPatches.push({
      id: String(col.id),
      attachedLocationIds: allLocIds,
      kind: "column",
    });
  }

  // ── Step 7: add new core columns; promote existing keys to core if
  //           they happen to be user-created custom columns ──────────────
  for (const def of NEW_CORE_COLUMNS) {
    const existing = existingByKey.get(def.key);
    if (existing) {
      const wantsCore = def.isCore;
      const isAlreadyCore = Boolean(existing.isCore);
      const existingGroupable = Boolean(existing.isGroupable);
      const targetGroupable = Boolean(def.isGroupable);
      const needsKindBackfill = existing.kind === undefined;
      const promotingToCore = wantsCore && !isAlreadyCore;
      const groupableChanges = existingGroupable !== targetGroupable;
      if (!promotingToCore && !groupableChanges && !needsKindBackfill) continue;
      // Merge into any existing patch (e.g. the step-6 auto-attach patch).
      // When promoting a custom column to core, drop attachedLocationIds —
      // core columns render everywhere and the field is meaningless on them.
      const existingPatch = columnPatches.find((p) => p.id === existing.id);
      if (existingPatch) {
        if (promotingToCore) {
          existingPatch.isCore = true;
          // Step 6 may have set attachedLocationIds; clear it on promotion.
          delete existingPatch.attachedLocationIds;
        }
        if (groupableChanges) existingPatch.isGroupable = targetGroupable;
        if (needsKindBackfill) existingPatch.kind = "column";
      } else {
        columnPatches.push({
          id: String(existing.id),
          ...(promotingToCore ? { isCore: true } : {}),
          ...(groupableChanges ? { isGroupable: targetGroupable } : {}),
          ...(needsKindBackfill ? { kind: "column" } : {}),
        });
      }
      continue;
    }
    if (def.key === "expirationDate" || def.key === "location") continue;
    const created: InventoryColumn = {
      id: `inventory-core-${def.key}`,
      organizationId: orgId,
      ...def,
      createdAt: now,
    };
    rowWrites.push(created as unknown as ColumnRowWrite);
  }

  // ── Step 8: backfill kind on rows that lack it ──────────────────────────
  for (const col of existingColumns) {
    const key = String(col.key ?? "");
    if (key === "location") continue;
    const needsKind = col.kind === undefined;
    const alreadyPatched = columnPatches.find((p) => p.id === col.id);
    if (alreadyPatched) {
      if (needsKind && alreadyPatched.kind === undefined) alreadyPatched.kind = "column";
      continue;
    }
    if (!needsKind) continue;
    columnPatches.push({
      id: String(col.id),
      kind: "column",
    });
  }

  // ── Step 9: convert legacy meta singletons to kind: "meta" ─────────────
  if (legacyRegistry && legacyRegistry.kind !== "meta") {
    rowWrites.push({
      ...legacyRegistry,
      kind: "meta",
      module: "inventory",
      organizationId: orgId,
    } as ColumnRowWrite);
  }
  const legacyVendorsRegistry = world.columnTableRows.find(
    (r) => r.id === "inventory-meta-vendors",
  );
  if (legacyVendorsRegistry && legacyVendorsRegistry.kind !== "meta") {
    rowWrites.push({
      ...legacyVendorsRegistry,
      kind: "meta",
      module: "inventory",
      organizationId: orgId,
    } as ColumnRowWrite);
  }

  // ── Step 10: stamp migration meta row ──────────────────────────────────
  rowWrites.push({
    id: MIGRATION_META_ID,
    kind: "meta",
    module: "inventory",
    organizationId: orgId,
    migrationVersion: TARGET_MIGRATION_VERSION,
    completedAt: now,
  } as ColumnRowWrite);

  // ── Step 11: emit MIGRATION_APPLY ──────────────────────────────────────
  auditEvents.push({
    action: "MIGRATION_APPLY",
    itemId: null,
    itemName: null,
    details: {
      fromVersion: world.migrationVersion,
      toVersion: TARGET_MIGRATION_VERSION,
      itemsMovedToDefault: itemsMovedToDefaultCount,
      locationsCreated: rowWrites.filter((r) => r.kind === "location").length,
    },
  });

  const toastMessage =
    itemsMovedToDefaultCount > 0
      ? `Moved ${itemsMovedToDefaultCount} item${itemsMovedToDefaultCount === 1 ? "" : "s"} without a location to a "Default" location.`
      : null;

  return {
    reason: "v0-to-v1",
    fromVersion: world.migrationVersion,
    toVersion: TARGET_MIGRATION_VERSION,
    rowWrites,
    columnPatches,
    columnDeletes,
    itemPatches,
    auditEvents,
    toastMessage,
    itemsMovedToDefaultCount,
  };
};
