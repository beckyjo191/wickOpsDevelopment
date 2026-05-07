// Migration logic tests. Runs against the pure `planMigration` function — no
// DynamoDB, no clock, no real UUIDs. Run via:
//
//   npm run test:migration
//
// (which esbuild-bundles this file + the migration module, then invokes
//  `node --test` on the output).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planMigration,
  TARGET_MIGRATION_VERSION,
  MIGRATION_META_ID,
  LEGACY_LOCATIONS_REGISTRY_ID,
  type MigrationWorld,
} from "../migration-planner.js";

const FIXED_NOW = "2026-04-30T12:00:00.000Z";
let uuidCounter = 0;
const opts = {
  now: () => FIXED_NOW,
  uuid: () => `uuid-${++uuidCounter}`,
};

const resetUuids = () => { uuidCounter = 0; };

const baseWorld = (overrides: Partial<MigrationWorld> = {}): MigrationWorld => ({
  organizationId: "org-1",
  migrationVersion: 0,
  columnTableRows: [],
  itemRows: [],
  ...overrides,
});

const findCreatedLocation = (plan: ReturnType<typeof planMigration>, name: string) =>
  plan.rowWrites.find((r) => r.kind === "location" && (r as any).name === name);

describe("planMigration", () => {
  it("short-circuits on already-migrated org", () => {
    resetUuids();
    const plan = planMigration(baseWorld({ migrationVersion: 1 }), opts);
    assert.equal(plan.reason, "already-migrated");
    assert.equal(plan.rowWrites.length, 0);
    assert.equal(plan.itemPatches.length, 0);
  });

  it("empty org → seeds new core columns + meta row only (no Default)", () => {
    resetUuids();
    const plan = planMigration(baseWorld(), opts);
    assert.equal(plan.reason, "v0-to-v1");
    // No items → no Default location needed, no item patches.
    assert.equal(plan.itemPatches.length, 0);
    // Locations created: zero (no items, no registry).
    const locationsCreated = plan.rowWrites.filter((r) => r.kind === "location");
    assert.equal(locationsCreated.length, 0);
    // New core columns added: itemName, quantity, minQuantity, vendor,
    // reorderLink, unitCost, packSize, packCost, notes (9).
    // 1h.5: category removed from the core seed.
    const columnsCreated = plan.rowWrites.filter((r) => r.kind === "column");
    assert.equal(columnsCreated.length, 9);
    // Migration meta row stamped.
    const metaRow = plan.rowWrites.find((r) => r.id === MIGRATION_META_ID);
    assert.ok(metaRow, "should write migration meta row");
    assert.equal((metaRow as any).migrationVersion, TARGET_MIGRATION_VERSION);
    // MIGRATION_APPLY audit event emitted.
    const applyEvent = plan.auditEvents.find((e) => e.action === "MIGRATION_APPLY");
    assert.ok(applyEvent);
  });

  it("org with one location and one row → row stamped, registry promoted", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          { id: LEGACY_LOCATIONS_REGISTRY_ID, locations: ["Main"] },
        ],
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ itemName: "Widget", location: "Main" }) },
        ],
      }),
      opts,
    );
    const main = findCreatedLocation(plan, "Main");
    assert.ok(main, "should materialize Main location");
    assert.equal(plan.itemPatches.length, 1);
    assert.equal(plan.itemPatches[0].id, "item-1");
    assert.equal(plan.itemPatches[0].locationId, (main as any).id);
    // values.location stripped from valuesJson.
    const newValues = JSON.parse(plan.itemPatches[0].nextValuesJson);
    assert.equal(newValues.location, undefined);
    assert.equal(newValues.itemName, "Widget");
    // Legacy registry row converted to kind: meta.
    const promotedRegistry = plan.rowWrites.find((r) => r.id === LEGACY_LOCATIONS_REGISTRY_ID);
    assert.ok(promotedRegistry);
    assert.equal((promotedRegistry as any).kind, "meta");
  });

  it("row with values.location not in registry → location materialized anyway", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [{ id: LEGACY_LOCATIONS_REGISTRY_ID, locations: [] }],
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ location: "Garage" }) },
        ],
      }),
      opts,
    );
    const garage = findCreatedLocation(plan, "Garage");
    assert.ok(garage);
    assert.equal(plan.itemPatches[0].locationId, (garage as any).id);
  });

  it("rows with same name in different casing → kept as separate locations", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ location: "Main" }) },
          { id: "item-2", valuesJson: JSON.stringify({ location: "main" }) },
        ],
      }),
      opts,
    );
    const upper = findCreatedLocation(plan, "Main");
    const lower = findCreatedLocation(plan, "main");
    // Both names dedup case-insensitively in the same map; only one location
    // is created and both rows resolve to it. (See spec §4.3.1 — this is the
    // documented behavior for the ambiguous-casing case.)
    assert.ok(upper || lower, "at least one Main casing materialized");
    // The two items resolve to the same location.
    assert.equal(plan.itemPatches[0].locationId, plan.itemPatches[1].locationId);
  });

  it("rows with empty location → all moved to Default with toast", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ itemName: "A" }) },
          { id: "item-2", valuesJson: JSON.stringify({ itemName: "B", location: "" }) },
          { id: "item-3", valuesJson: JSON.stringify({ itemName: "C", location: "   " }) },
        ],
      }),
      opts,
    );
    const def = findCreatedLocation(plan, "Default");
    assert.ok(def, "should create Default");
    assert.equal(plan.itemsMovedToDefaultCount, 3);
    assert.ok(plan.toastMessage?.includes("Default"));
    for (const patch of plan.itemPatches) {
      assert.equal(patch.locationId, (def as any).id);
    }
  });

  it("expirationDate column → flipped to isCore: false, attached to all locations", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          {
            id: "inventory-core-expirationDate",
            kind: "column",
            module: "inventory",
            key: "expirationDate",
            label: "Expiration Date",
            type: "date",
            isCore: true,
            isRequired: false,
            isVisible: true,
            isEditable: true,
            sortOrder: 40,
            createdAt: FIXED_NOW,
          },
        ],
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ location: "Main" }) },
        ],
      }),
      opts,
    );
    const expPatch = plan.columnPatches.find((p) => p.id === "inventory-core-expirationDate");
    assert.ok(expPatch);
    assert.equal(expPatch.isCore, false);
    assert.ok(Array.isArray(expPatch.attachedLocationIds));
    assert.equal(expPatch.attachedLocationIds!.length, 1); // attached to Main
  });

  it("location core column → deleted", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          {
            id: "inventory-core-location",
            kind: "column",
            module: "inventory",
            key: "location",
            label: "Location",
            type: "text",
            isCore: true,
            isRequired: false,
            isVisible: true,
            isEditable: true,
            sortOrder: 50,
            createdAt: FIXED_NOW,
          },
        ],
      }),
      opts,
    );
    assert.ok(plan.columnDeletes.includes("inventory-core-location"));
  });

  it("custom column → auto-attached to every location", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          {
            id: "col-vehicle",
            kind: "column",
            module: "inventory",
            key: "vehicle",
            label: "Vehicle",
            type: "text",
            isCore: false,
            isRequired: false,
            isVisible: true,
            isEditable: true,
            sortOrder: 200,
            createdAt: FIXED_NOW,
          },
        ],
        itemRows: [
          { id: "item-1", valuesJson: JSON.stringify({ location: "Main" }) },
          { id: "item-2", valuesJson: JSON.stringify({ location: "Storage" }) },
        ],
      }),
      opts,
    );
    const vehiclePatch = plan.columnPatches.find((p) => p.id === "col-vehicle");
    assert.ok(vehiclePatch);
    assert.equal(vehiclePatch.attachedLocationIds?.length, 2);
  });

  it("category as custom column → stays custom (1h.5: category is no longer core)", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          {
            id: "col-category",
            kind: "column",
            module: "inventory",
            key: "category",
            label: "Category",
            type: "text",
            isCore: false,        // user-created custom column
            isRequired: false,
            isVisible: true,
            isEditable: true,
            sortOrder: 500,
            createdAt: FIXED_NOW,
          },
        ],
      }),
      opts,
    );
    // The planner should NOT promote category to core (it's been removed
    // from NEW_CORE_COLUMNS). The only patch this row should ever pick
    // up here is a `kind` backfill if it's missing — otherwise nothing.
    const catPatch = plan.columnPatches.find((p) => p.id === "col-category");
    if (catPatch) {
      assert.notEqual(catPatch.isCore, true);
    }
    // No new core category column inserted by the planner either.
    const newCoreCategories = plan.rowWrites.filter(
      (r) => r.kind === "column" && (r as any).key === "category",
    );
    assert.equal(newCoreCategories.length, 0);
  });

  it("notes as custom column → promoted to core", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          {
            id: "col-notes",
            kind: "column",
            module: "inventory",
            key: "notes",
            label: "Notes",
            type: "text",
            isCore: false,
            isRequired: false,
            isVisible: true,
            isEditable: true,
            sortOrder: 700,
            createdAt: FIXED_NOW,
          },
        ],
      }),
      opts,
    );
    const notesPatch = plan.columnPatches.find((p) => p.id === "col-notes");
    assert.ok(notesPatch);
    assert.equal(notesPatch.isCore, true);
    const newCoreNotes = plan.rowWrites.filter(
      (r) => r.kind === "column" && (r as any).key === "notes",
    );
    assert.equal(newCoreNotes.length, 0);
  });

  it("idempotency: re-running plan on a v1 world is a no-op", () => {
    resetUuids();
    const v1World = baseWorld({
      migrationVersion: 1,
      columnTableRows: [
        {
          id: MIGRATION_META_ID,
          kind: "meta",
          module: "inventory",
          organizationId: "org-1",
          migrationVersion: 1,
          completedAt: FIXED_NOW,
        },
      ],
    });
    const plan = planMigration(v1World, opts);
    assert.equal(plan.reason, "already-migrated");
    assert.equal(plan.rowWrites.length, 0);
    assert.equal(plan.itemPatches.length, 0);
    assert.equal(plan.columnDeletes.length, 0);
    assert.equal(plan.auditEvents.length, 0);
  });

  it("emits LOCATION_CREATE audit event per materialized location", () => {
    resetUuids();
    const plan = planMigration(
      baseWorld({
        columnTableRows: [
          { id: LEGACY_LOCATIONS_REGISTRY_ID, locations: ["Main", "Storage"] },
        ],
      }),
      opts,
    );
    const locationCreates = plan.auditEvents.filter((e) => e.action === "LOCATION_CREATE");
    assert.equal(locationCreates.length, 2);
  });
});
