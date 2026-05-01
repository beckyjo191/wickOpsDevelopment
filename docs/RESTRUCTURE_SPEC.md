# Inventory Restructure Spec — Location, Per-Location Columns, Generic Grouping

**Status:** Phase 1 (spec) — awaiting review
**Author:** Claude (with architecture decisions locked by user)
**Date:** 2026-04-30
**Phases:** 1 spec → 2 backend → 3 frontend → 4 coordination handoffs

This restructure is a prerequisite for two queued chips ("Design + build real onboarding flow", "Design industry template content"). It changes three connected things:

1. **Location** moves from a regular column value into a structural row property.
2. **Custom columns** become attachable per-location (a column can render in some locations but not others).
3. **Category** loses its hardcoded specialness — its dropdown-filter behavior becomes a generic `isGroupable` flag any text column can opt into.

The decisions in the chip prompt's "Locked decisions" table are not re-litigated below; they are taken as given and shape the spec.

---

## 1. Current data model

### 1.1 Row shape

In DynamoDB (per-org `items` table), an inventory row is an `InventoryItem`:

```ts
// amplify/functions/inventoryApi/src/types.ts:32
type InventoryItem = {
  id: string;
  organizationId: string;
  module: "inventory";
  position: number;
  valuesJson: string;            // JSON-encoded Record<string, unknown>
  createdAt: string;
  updatedAtCustom: string;
};
```

`valuesJson` decodes into a `Record<string, string | number | boolean | null>` keyed by column `key`. Locations are stored as the `location` value inside this blob — same as any other text column. There is no first-class "location" pointer on the row.

System fields living inside `values` today (in addition to user-facing columns):
- `parentItemId` — logical-item identity across lots
- `retiredAt`, `retiredQty`, `retirementReason` — retirement markers
- `orderedAt` — restock workflow marker

### 1.2 Column shape

```ts
// amplify/functions/inventoryApi/src/types.ts:17
type InventoryColumn = {
  id: string;                    // "inventory-core-<key>" for core; uuid otherwise
  organizationId: string;
  module: "inventory";
  key: string;                   // stable identifier (e.g. "itemName")
  label: string;
  type: "text" | "number" | "date" | "link" | "boolean";
  isCore: boolean;
  isRequired: boolean;
  isVisible: boolean;
  isEditable: boolean;
  sortOrder: number;
  createdAt: string;
};
```

Columns are **org-wide**: every row sees every column. There is no per-row or per-location attachment.

### 1.3 Core columns today

Seeded by [`ensureColumns`](amplify/functions/inventoryApi/src/columns.ts:55):

| Order | key | type | isVisible | isEditable | Notes |
|---|---|---|---|---|---|
| 10 | `itemName` | text | true | true | required |
| 20 | `quantity` | number | true | true | required |
| 30 | `minQuantity` | number | true | true | required |
| 40 | `expirationDate` | date | true | true | (will become custom) |
| 50 | `location` | text | true | true | (will become structural — not a column) |
| 60 | `reorderLink` | link | true | true | label "Product URL" |
| 70 | `unitCost` | number | false | false | derived from packCost/packSize |
| 80 | `packSize` | number | false | true | |
| 90 | `packCost` | number | false | true | |
| 100 | `vendor` | text | false | true | |

`category` does **not** exist as a core column today — it's a custom column that the system *treats* specially when it happens to exist (see §1.5).

### 1.4 Location registry

Location names are stored separately in a singleton row inside the `columns` table:

```
{ id: "inventory-meta-locations", locations: string[], updatedAt: string }
```

See [`amplify/functions/inventoryApi/src/locations.ts`](amplify/functions/inventoryApi/src/locations.ts:1). The registry is a **set of names**, with no other metadata, no per-location columns, no item-count, no permissions.

The frontend merges this registry with locations discovered in row values:

```ts
// useInventoryFilters.ts:225
const fromItems = locationColumn
  ? rows.map((row) => String(row.values[locationColumn.key] ?? "").trim())
        .filter((v) => v.length > 0)
  : [];
const named = Array.from(new Set([...fromItems, ...registeredLocations])).sort(...);
```

A row is "in" a location if `row.values.location === selectedLocation`. A row with empty location falls into the **"Unassigned"** sentinel — surfaced in the location dropdown only when at least one row has data but no location string.

### 1.5 Hardcoded "category" specialness

[`useInventoryFilters.ts:264-285`](src/components/inventory/hooks/useInventoryFilters.ts:264) and [`InventoryDesktopTable.tsx:111-138`](src/components/inventory/InventoryDesktopTable.tsx:111) special-case `column.key === "category"`:

- The filters hook builds `categoryOptions` (distinct `row.values.category` values) and `categoryFilter` state.
- The desktop table renders that column's `<th>` as a dropdown filter instead of a sort button.

If an org never creates a `category` column (the key isn't seeded), the dropdown never appears. Some industry templates create one labeled "Category" via the lazy-import path; the resulting key happens to be `category` because [`toKey()`](amplify/functions/inventoryApi/src/normalize.ts) normalizes labels.

### 1.6 Where `values.location` and `values.category` are read/written

Exhaustive map (`grep` across `src/` and `amplify/`):

**Frontend reads `row.values.location`:**
- [`useInventoryFilters.ts:227,234,297,371,392`](src/components/inventory/hooks/useInventoryFilters.ts:227) — location options, filter, UNASSIGNED detection
- [`useInventoryData.ts:519,760,771,775,1406,1414`](src/components/inventory/hooks/useInventoryData.ts:519) — auto-set on add, move-rows mutation, retire grouping, autosave skip-blank check
- [`SettingsPage.tsx:346,354,406,431,446`](src/components/SettingsPage.tsx:346) — registry merging, item-count, rename mirror, delete purge, vendor variant
- [`ReorderTab.tsx:190,1169,1370`](src/components/ReorderTab.tsx:190) — `itemName + location` aggregation key, restock order item.location persistence
- [`OrdersPage.tsx:1436,1582`](src/components/OrdersPage.tsx:1436) — gather location set for picker, persist onto order item
- [`InventoryUsagePage.tsx`](src/components/InventoryUsagePage.tsx) — passes location into `submitInventoryUsage`
- [`inventoryApi.ts:352`](src/lib/inventoryApi.ts:352) — `pruneZeroQtyRows` group key includes location

**Frontend writes `row.values.location`:**
- [`useInventoryData.ts:519`](src/components/inventory/hooks/useInventoryData.ts:519) — `onAddRow` auto-stamps location when scoped to one
- [`useInventoryData.ts:766,775`](src/components/inventory/hooks/useInventoryData.ts:766) — `onMoveSelectedRows` mutates rows + leaves blank placeholders behind in source
- Generic `onCellChange` path — any user edit of the location cell

**Backend reads `values.location`:**
- [`routes/dashboard.ts:30`](amplify/functions/inventoryApi/src/routes/dashboard.ts:30) — alert summary `byLocation` aggregation
- [`routes/usage.ts:153-189,303`](amplify/functions/inventoryApi/src/routes/usage.ts:153) — usage submission validation; entry.location must match item.values.location
- [`csv.ts:216`](amplify/functions/inventoryApi/src/csv.ts:216) — `buildImportMatchKey` uses `itemName + location + expirationDate` for dedupe

**Backend writes `values.location`:**
- [`routes/locations.ts:44,87`](amplify/functions/inventoryApi/src/routes/locations.ts:44) — clear on remove; rewrite on rename (full table scan)
- [`routes/restock.ts:260`](amplify/functions/inventoryApi/src/routes/restock.ts:260) — receive freeform → new row's `values.location = orderItem.location`

**Anywhere `category` is special-cased:**
- [`useInventoryFilters.ts:264-285,372,397`](src/components/inventory/hooks/useInventoryFilters.ts:264) — `categoryColumn` lookup, options, filter
- [`InventoryDesktopTable.tsx:112,124`](src/components/inventory/InventoryDesktopTable.tsx:112) — dropdown header rendering
- [`useInventoryData.ts:1431`](src/components/inventory/hooks/useInventoryData.ts:1431) — retire-stub carry-forward field list
- `InventoryPage.tsx:646` — passes `categoryFilter` through

**Anywhere `expirationDate` is special-cased (relevant because it becomes a custom column):**
- [`useInventoryFilters.ts:218,305,307,343,370,440,441`](src/components/inventory/hooks/useInventoryFilters.ts:218) — `hasExpirationColumn`, tab counts, search formatting, `getDaysUntilExpiration`, expiration sort
- [`InventoryMobileCards.tsx:147-150,216`](src/components/inventory/InventoryMobileCards.tsx:147) — preview-card badges
- [`useInventoryData.ts:66,1381`](src/components/inventory/hooks/useInventoryData.ts:66) — `ORDERED_CLEAR_KEYS` auto-clear, retire preserves expirationDate
- [`columns.ts:336-348`](amplify/functions/inventoryApi/src/columns.ts:336) — core seed (sortOrder 40)
- [`csv-import.ts:205,217`](amplify/functions/inventoryApi/src/routes/csv-import.ts:205) — special parse for expirationDate
- [`csv.ts:216,225`](amplify/functions/inventoryApi/src/csv.ts:216) — match key, fingerprint normalization
- [`audit.ts:135-143`](amplify/functions/inventoryApi/src/audit.ts:135) — `buildQuantitySnapshot` pulls expirationDate
- [`routes/inventory.ts:141`](amplify/functions/inventoryApi/src/routes/inventory.ts:141) — snapshot fields
- [`routes/restock.ts`](amplify/functions/inventoryApi/src/routes/restock.ts) — receive can set expirationDate

### 1.7 Audit log shape

`ITEM_EDIT` events record `{ changes: [{ field, from, to }, ...] }` from a generic diff ([`audit.ts:115`](amplify/functions/inventoryApi/src/audit.ts:115)). When a user edits the `location` cell today, this shows up in the feed as a normal field-change event. There is **no `ITEM_MOVE` event type** — moves are indistinguishable from any other edit.

`buildQuantitySnapshot` (used by ITEM_EDIT, ITEM_RETIRE, RESTOCK_RECEIVED) hardcodes `["quantity", "minQuantity", "expirationDate"]` as the fields to snapshot.

---

## 2. New data model

### 2.1 Row shape

```ts
type InventoryItem = {
  id: string;
  organizationId: string;
  module: "inventory";
  position: number;
  valuesJson: string;            // unchanged: Record<string, unknown> for column data
  /** Structural location — required, never empty. */
  locationId: string;            // FK → locations table
  createdAt: string;
  updatedAtCustom: string;
};
```

The structural pointer is `locationId` (a UUID), **not** `location` name, so renames are O(1) at the registry level. Bandwidth-wise, parsing `locationId` from a top-level attribute is also cheaper than parsing JSON for filtering.

### 2.2 Column shape

```ts
type InventoryColumn = {
  id: string;
  organizationId: string;
  module: "inventory";
  key: string;
  label: string;
  type: "text" | "number" | "date" | "link" | "boolean";
  isCore: boolean;               // unchanged
  isRequired: boolean;           // unchanged (only itemName hard-required)
  isVisible: boolean;            // unchanged
  isEditable: boolean;           // unchanged
  sortOrder: number;
  /** NEW: any column may opt into the header dropdown filter. Defaults to false.
   *  category core column ships with isGroupable: true. */
  isGroupable: boolean;
  createdAt: string;
};
```

### 2.3 Locations as a real entity

Promote the registry from a `string[]` blob to an addressable table:

```ts
// New per-org "locations" table (or a new section of the existing columns table —
// see §2.6 for table-shape discussion)
type InventoryLocation = {
  id: string;                    // UUID
  organizationId: string;
  name: string;                  // user-facing display
  sortOrder: number;             // for stable ordering in the picker
  createdAt: string;
};
```

A `Default` location is auto-created at migration time for every org.

### 2.4 Per-location column attachment

**Locked decision: no separate join entity.** Attachments are stored as a string-array field directly on the column row:

```ts
// extends InventoryColumn (see §2.2)
attachedLocationIds?: string[];   // ignored for core columns
```

- Core columns ignore this field — they always render in every location.
- A custom column with `attachedLocationIds: []` is dormant (defined but not rendered anywhere).
- A custom column with `attachedLocationIds: [locA, locB]` renders only in those two locations.
- One read of the columns table returns columns + locations + their relationships in a single query — no join needed.

This keeps the model flat: 1 row per column, 1 row per location, no extra rows for the relationships.

### 2.5 Final core column list

| Order | key | type | isCore | isRequired | isGroupable | isVisible | isEditable |
|---|---|---|---|---|---|---|---|
| 10 | `itemName` | text | yes | **yes** | no | true | true |
| 20 | `quantity` | number | yes | no | no | true | true |
| 30 | `minQuantity` | number | yes | no | no | true | true |
| 40 | `vendor` | text | yes | no | no | false | true |
| 50 | `reorderLink` | link | yes | no | no | true | true |
| 60 | `unitCost` | number | yes | no | no | false | false |
| 70 | `packSize` | number | yes | no | no | false | true |
| 80 | `packCost` | number | yes | no | no | false | true |
| 90 | `notes` | text | yes | no | no | true | true |
| 100 | `category` | text | yes | no | **yes** | true | true |

**Removed from core:** `location` (now structural), `expirationDate` (now custom).

**Added to core:** `notes` (universal), `category` (was implicit; now explicit core with `isGroupable: true`).

`itemName` retains its hard-required status — empty values are rejected by the server. Other "required" custom column flags only show a warning indicator client-side; saves still succeed.

### 2.6 Where to store new entities (DynamoDB-shape — LOCKED)

**Decision:** Reuse the existing per-org `columns` table with a `kind` discriminator. No new DynamoDB tables. No GSI on `kind` — listing is cheap at this cardinality.

Row kinds in the columns table:
- `kind: "column"` — the InventoryColumn shape (existing rows; backfill `kind`). Carries `attachedLocationIds: string[]` for custom columns.
- `kind: "location"` — `{ id, kind: "location", organizationId, module, name, sortOrder, createdAt }` (replaces the `inventory-meta-locations` singleton).
- `kind: "meta"` — surviving singletons (vendors registry, migration metadata).

Listing strategy: the existing GSI `ByModuleSortOrder` already key-conditions on `module === "inventory"`. Add a code-side filter on `kind === "column"` (treating absent `kind` as `"column"` for backwards compat with un-migrated rows). A separate `listLocations` helper does the same query and filters `kind === "location"`. Total row count per org is ≤ ~150; the read is cheap.

The migration backfills defensively: any row with `module === "inventory"` and no `kind` gets `kind: "column"`. The location singleton gets converted to per-location rows in step 2.

### 2.7 Removed concepts

- **"Unassigned" sentinel** — gone. Migration creates a `Default` location for orgs that have any rows missing/empty location, and moves them there.
- **`row.values.location` field** — removed during migration (or dual-written for one deploy cycle if backwards-compat is requested; see §8).
- **Hardcoded `column.key === "category"` rendering branch** — replaced by `column.isGroupable`.

---

## 3. API changes

### 3.1 New endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/inventory/locations` | List structured locations (id, name, sortOrder). Replaces the `string[]` returned in bootstrap. |
| POST | `/inventory/items/move` | Structural move. Body: `{ rowIds: string[], locationId }`. Emits one `ITEM_MOVE` audit event per row. (Batch-friendly since the toolbar's "Move to…" can target a multi-selection.) |

Attachments are managed via the existing `POST /inventory/columns/:id` update path — the body now accepts an optional `attachedLocationIds: string[]`. No separate attach/detach endpoints.

### 3.2 Changed endpoints

**`GET /inventory/bootstrap`** — response shape changes:

```diff
 {
   access,
   columns: InventoryColumn[],     // now includes isGroupable + attachedLocationIds
-  registeredLocations: string[],
+  locations: InventoryLocation[],
   items: InventoryItem[],         // each item now has top-level locationId
   ...
 }
```

`registeredLocations` is removed in favor of `locations` (full objects). Attachments are a field on each column (not a separate array). Single-org deploy means no v0/v1 client coexistence to shim around — see §8.

**`POST /inventory/items/save`** — request shape: each row in `rows` may now carry a top-level `locationId` (writes the structural field). When omitted, the server preserves the existing `locationId`. Body validation: rejects writes with `locationId` referring to a location that doesn't belong to the org.

The save handler also strips `location` from `values` if a v1 client still sends it (server-side dual-write only — we accept input but don't persist `values.location`).

**`POST /inventory/locations`** — returns the full `InventoryLocation` row, not just the updated `string[]`. Body remains `{ name }`.

**`POST /inventory/locations/rename`** — takes `{ id, newName }` (was `{ oldName, newName }`). The previous row-rewriting fan-out is gone — renames are O(1) at the location row only.

**`DELETE /inventory/locations`** — takes `{ id }` (was `{ name }`). Rejects with `409` if the location still has items unless `?force=true` (which moves them to `Default` and emits a bulk `ITEM_MOVE` audit event per item — actually, ergonomically better: surface a `<ConfirmDialog>` client-side that calls a "move all out" endpoint first, then delete).

**`POST /inventory/columns`** — body now accepts an optional `attachToLocationIds: string[]`. When omitted, behavior is "attach to all current locations" (preserves the old org-wide behavior). The "primary" management surface (Inventory toolbar modal) will pass `attachToLocationIds: [currentLocationId]` for the per-location-only flow.

**`POST /inventory/columns/:id`** — gains `isGroupable` and `attachedLocationIds` as updatable fields (in addition to the existing label/type/visibility update paths). The `ColumnAttachmentDialog` modal calls this endpoint with the new attachments array; setting `isGroupable` flips the header dropdown filter on/off.

**`POST /inventory/onboarding/apply-template`** — semantics extended (covered in detail in the queued template-content chip; here we lock in the *shape*):

```ts
// Template now defines locations + per-location column attachments + seed items.
type IndustryTemplate = {
  id: string;
  name: string;
  description: string;
  locations?: Array<{           // NEW: optional. When absent, only Default is created.
    name: string;
    columns: TemplateColumn[];  // attached only to this location
    items?: Array<Record<string, unknown>>;  // seed items
  }>;
  globalColumns?: TemplateColumn[];   // attached to every location
};
```

Existing templates ship `globalColumns` only — preserves current behavior. The template-content chip will fill in `locations[]` per industry.

**`POST /inventory/import-csv`** — request adds a required `locationId` parameter (was implicitly read from CSV row's `location` column). The frontend gathers it from a new "which location are you importing into?" picker before column mapping.

**`POST /inventory/usage/submit`** — `entries[].location: string` → `entries[].locationId: string` (or remove entirely; the item's structural location is authoritative). Recommend: **remove the field**. The server reads the item's `locationId` directly. This collapses the validation logic in [`usage.ts:153-189`](amplify/functions/inventoryApi/src/routes/usage.ts:153) since "entry location matches item location" becomes tautological.

**`POST /inventory/restock/orders`** + receive — `RestockOrderItem.location` → `RestockOrderItem.locationId`. New rows materialized at receive time write the structural `locationId`. Freeform items capture `locationId` at order time.

### 3.3 Deprecated endpoints

None. Every endpoint is updated in place. The locations CRUD endpoints change their request/response shapes (id-keyed, not name-keyed). With one live org and a single coordinated deploy, there's no v0-client window to support — the new shapes go live atomically.

### 3.4 Wire-format compat in `valuesJson`

**No dual-write.** The migration writes `locationId` and strips `values.location`. Rollback path is PITR restore + git revert, not dual-write windows. See §8.

---

## 4. Migration plan

### 4.1 Goals

- Idempotent — safe to re-run
- Bulletproof — never lose data, never produce orphaned rows
- Versioned — record migration version on the org so we know what's been migrated
- Graceful — orgs that skip the migration somehow still serve correctly (server runs migration on first request)

### 4.2 Migration trigger

Add a `migrationVersion: number` field to the [`organization`](amplify/data/resource.ts:5) record (or a separate per-org meta row in the columns table). The router-level [`ensureStorageForOrganization`](amplify/functions/inventoryApi/src/storage.ts:249) gains a sibling step `ensureSchemaUpToDate` that runs after storage provisioning and short-circuits if `migrationVersion >= TARGET_VERSION`.

Initial target version: `1`. Future restructures bump it.

### 4.3 Per-org migration script (version 0 → 1)

Run inside `ensureSchemaUpToDate` for any org with `migrationVersion < 1`. Steps in strict order, each idempotent:

**Step 1: Backfill `kind` on existing column rows**
- Scan the columns table.
- For every row with `module === "inventory"` and no `kind` attribute, write `kind: "column"`.
- The two singletons (`inventory-meta-locations`, `inventory-meta-vendors`) get `kind: "meta"`.

**Step 2: Materialize Locations from the registry + row data**
- Read the `inventory-meta-locations` registry → `string[]`.
- Scan all rows in items table → collect every distinct `String(values.location ?? "").trim()`.
- Union the two sets. For each name, create an `InventoryLocation` row with `kind: "location"`, fresh UUID, `sortOrder` ascending.
- If the union contains the empty string OR is empty, also create a `Default` location.

**Step 3: Stamp `locationId` on every row**
- Build a map: `locationName → locationId` from the rows just created.
- Iterate every item:
  - If `values.location` resolves to a known location, stamp `item.locationId = <that id>`.
  - If `values.location` is empty/missing, stamp `item.locationId = <Default id>`.
- Use UpdateItem (not PutItem) so `valuesJson` and other fields are untouched.
- Idempotency: skip rows that already have `locationId`.

**Step 4: Convert `expirationDate` core column → custom**
- Find the `expirationDate` column row (id `inventory-core-expirationDate`).
- Update `isCore: false`. Keep the same id (or move to a new uuid; keeping id is simpler and audit log already references `columnId`).
- Create a `ColumnLocationAttachment` for every existing location × `expirationDate`. (Preserves current behavior: every row in every location can still see expiration.)

**Step 5: Convert `location` core column → removed**
- Delete the `inventory-core-location` row from the columns table.
- Strip `values.location` from every item row's `valuesJson` (or leave it dual-written for one deploy cycle — see §8).

**Step 6: Auto-attach existing custom columns to every location**
- For every column with `isCore === false`:
  - Set `column.attachedLocationIds = <list of every location id>`.
- Idempotent: if `attachedLocationIds` is already populated, leave it alone.

This preserves current behavior: a custom column that used to be org-wide remains visible everywhere, and the user can detach it from specific locations later via the column update endpoint.

**Step 7: Add new core columns (`notes`, `category` if missing)**
- `notes`: create with sortOrder 90 if a column with key `notes` doesn't already exist. If one exists as a custom column, promote it to core (`isCore: true`).
- `category`: create with sortOrder 100, `isGroupable: true` if missing. If exists as custom, promote it to core + set `isGroupable: true`.

**Step 8: Set `isGroupable: false` default on all other columns**
- One UpdateItem per column row to add the new `isGroupable: false` attribute (DynamoDB requires explicit set; missing attribute is read as `false`, but explicit setting is clearer and cheaper to query against).

**Step 9: Stamp migration version**
- Update the org record: `migrationVersion: 1`.
- Emit a single `MIGRATION_APPLY` audit event with `{ from: 0, to: 1 }` so the activity feed shows when this happened.

**Step 10: Surface a UI toast on next page load**
- Server returns a `migrationNotice` payload in bootstrap when migration ran in this session: `{ message, defaultLocationItemCount }`.
- Client shows it via `useToast` once, persists "seen" flag in localStorage.

### 4.3.1 Edge cases enumerated

| Case | Handling |
|---|---|
| Org with zero locations and zero rows | Create only the `Default` location; no attachments needed. Step 3 is a no-op. |
| Org with rows but all `values.location === ""` | Single `Default` location created; all rows moved into it. Toast: "Moved N items to a 'Default' location." |
| Org with `values.location` values that are NOT in the registry | Materialize them as new `InventoryLocation` rows in step 2 (Union not Intersection). Preserves data the user typed inline. |
| Org with two location strings that differ only in casing ("Main" vs "main") | Treat as separate locations (preserves the user's input). They can rename/merge later. The unique check in `handleAddLocation` is case-insensitive going forward but doesn't re-canonicalize old data. |
| Org with rows whose `values.location` is whitespace-only | Treated as empty → `Default`. |
| Org that already has a column called "Default" or "Notes" or "Category" | Migration uses keys, not labels. The `notes`/`category` core seeds use those exact keys; if a user-created custom column happens to share the key, promote it to core (idempotent — running twice is a no-op). |
| Org that has `expirationDate` as a custom column already (via a template that mistakenly created one) | Idempotent on key match. The migration finds it by key, ensures `isCore: false`, attaches to every location. |
| Org with `migrationVersion >= 1` and someone manually deleted a location | No re-creation. The `Default` is only created at v1 migration time. (Deleting `Default` later is a user action governed by §3.2 delete rules.) |
| Org mid-write during migration | Each step uses UpdateItem with conditional expressions where possible. A row written during step 3 by a v1 client carries its own `locationId`; the migration's idempotency check skips it. A v0 client in flight will fail at save time when the server starts rejecting `values.location` writes — the user sees a save error and reloads. Acceptable for a one-time migration. |

### 4.4 Migration ordering with deploy

**Single coordinated deploy** (one live org, validated locally first):

1. Local: implement + test migration as a pure function over a fixture "world" object (see §9.1).
2. Local: run migration against a DDB export of the live org → diff before/after to verify no data loss, every row has `locationId`, no row has `values.location`.
3. Deploy server + frontend together.
4. Migration runs lazily on first authenticated request from the live org (or invoke proactively via a one-shot CLI before the first user click).
5. Verify in browser; if anything is wrong, restore from PITR + `git revert` + redeploy.

No dual-read, no dual-write, no v0/v1 client coexistence. The single-org constraint makes the deploy atomic in practice.

---

## 5. Audit log impact

### 5.1 New event type

`ITEM_MOVE` — emitted by the structural move endpoint and by import/restock paths that change a row's location:

```ts
{
  action: "ITEM_MOVE",
  itemId,
  itemName,
  details: {
    fromLocationId: string,
    fromLocationName: string,   // snapshotted for feed display
    toLocationId: string,
    toLocationName: string,
  }
}
```

ITEM_MOVE is **not** coalesced (unlike ITEM_EDIT). Each move is its own event. Volume is low (users don't move items rapidly) so coalescing isn't worth the complexity.

### 5.2 ITEM_EDIT changes

The diff computation in [`audit.ts:115`](amplify/functions/inventoryApi/src/audit.ts:115) currently emits a `changes` entry for `field: "location"`. After migration, location no longer lives in `values`, so this stops happening organically. The `SYSTEM_FIELDS` filter in [`routes/inventory.ts:17`](amplify/functions/inventoryApi/src/routes/inventory.ts:17) does NOT need to add `location` (it's no longer in `values`).

`buildQuantitySnapshot` continues to snapshot `quantity, minQuantity, expirationDate` even though `expirationDate` is now custom. Behavior is unchanged because the snapshot reads from `values` and `expirationDate` still lives there (just under a custom column instead of a core one).

### 5.3 Backfilled events?

Question: should we rewrite old `ITEM_EDIT` events whose only change was `location` → `ITEM_MOVE`?

**Decision: no.** The audit table partitions by `ITEM#<itemId>` and is keyed by `(pk, sk = TS#timestamp#shortId)` — rewriting historical events requires a per-org scan, would change SortKey ordering only if we also touched timestamp, and provides minimal value (the original event still says "user changed location from X to Y"). We document this in the activity-feed UI by showing both event types as "Moved" rows when the field name was `location`.

A migration-time renderer transformation in the audit feed handler can optionally normalize: if `action === "ITEM_EDIT"` AND `details.changes` is exactly one change with `field === "location"`, render it as a "Moved" row. Cosmetic only — no data migration.

### 5.4 New audit events around the migration itself

- `MIGRATION_APPLY` (one event per org per migration version bump)
- `LOCATION_CREATE`, `LOCATION_DELETE`, `LOCATION_RENAME` — replacing the implicit "edited a row's location cell" trail
- Attachment changes flow through the existing `COLUMN_UPDATE` event with `changeType: "attachments"` and a from/to of the `attachedLocationIds` arrays. No separate event types needed since attachment lives on the column row.

---

## 6. CSV import flow

### 6.1 Today

[`csv-import.ts`](amplify/functions/inventoryApi/src/routes/csv-import.ts:34) accepts a CSV with arbitrary headers, maps them to existing columns (or creates new columns for unknown headers), and writes rows. `location` is a regular column header in the CSV — its values flow into `values.location`.

### 6.2 New flow

Two-step UI:

1. **Step 1 — pick location.** Frontend opens a `<location>` picker before showing the column-mapping dialog. The user picks one location to import into. (Multi-location imports out of scope.)
2. **Step 2 — column mapping.** As today, but the `location` column header is automatically detected and **excluded** from the mapping list (with a tooltip: "Location is set above"). If the CSV has multiple distinct values in a `location` column, surface a warning: "Your CSV has rows with different locations. Only X will be imported here." (User can split their CSV and re-run for each location.)

Server-side:

- `POST /inventory/import-csv` body now requires `locationId`.
- Server stamps every imported row's `locationId` from the request, ignoring any `location` column in the CSV.
- The `buildImportMatchKey` change: dedupe key becomes `itemName + locationId + expirationDate` (was `itemName + location + expirationDate`). The locationId comes from the request, the expirationDate from values. The match-key change is invisible to users — same behavior, different identifier.

### 6.3 XLSX export change

[`exportInventoryData`](src/lib/inventoryApi.ts:1007) writes a "Locations" sheet that's just the location names. After the change, write `id, name, sortOrder` instead — useful for round-trip imports if we ever support them. Inventory sheet stays the same, but instead of a `Location` column populated from `values.location`, populate from `locations.find(l => l.id === item.locationId).name`.

---

## 7. Cross-cutting client code (file-by-file change list)

Phase-3 implementation worksheet. Each entry: file → what changes.

### 7.1 Hooks

- **`useInventoryData.ts`** (lines flagged below):
  - L52, L80: drop `UNASSIGNED_LOCATION` param
  - L519-520: `onAddRow` → set `created.locationId = currentLocation.id` (not `values[locationColumn.key]`)
  - L750-789: `onMoveSelectedRows` → call new structural move endpoint per row (or a batch endpoint), update `row.locationId` in local state, drop the "leave a blank placeholder behind" logic (locations are now first-class, they don't disappear when emptied)
  - L760, 766, 771, 775: read/write `row.locationId`, not `row.values[locationColumn.key]`
  - L844-848: `diffRowsAgainstSnapshot` skip-blank check no longer needs to ignore `locationKey`
  - L1406, 1414: retire group key uses `row.locationId` (via a registry lookup if the name is needed for stub display)
  - L1431: drop `category` from the carry-forward field list — no longer special; it's just another core column whose value carries forward like any other if present

- **`useInventoryFilters.ts`**:
  - L38: drop `UNASSIGNED_LOCATION` constant
  - L196-285: replace `categoryFilter` / `categoryOptions` / `categoryColumn` with a generic `groupableFilters: Map<columnKey, { selected: string, options: string[] }>` keyed by every visible column with `isGroupable: true`
  - L208-211: `locationColumn` lookup is dead (location no longer a column) — delete
  - L227-246: `locationOptions` reads from a new `locations: InventoryLocation[]` prop instead of merging `values.location` + registry. Drop the "Unassigned" branch entirely.
  - L253-262: `visibleColumns` no longer needs the `showLocationPills ? base.filter(c => c.key !== "location")` filter — location isn't a column anymore.
  - L296-302, 391-396: location filter compares `row.locationId === effectiveLocationId`, not `row.values.location === effectiveLocationFilter`; drop UNASSIGNED branch
  - L370-372, 397-399: replace category-specific filtering with generic `for (const [key, filter] of groupableFilters)` loop

- **`useInventoryFilters.ts` return shape** changes — every consumer in `InventoryPage.tsx` updates accordingly.

### 7.2 Components

- **`InventoryPage.tsx`**:
  - L73, 172: drop `UNASSIGNED_LOCATION` references
  - L645-648: replace `categoryFilter` / `categoryOptions` / `effectiveCategoryFilter` / `onCategoryChange` props with generic `groupableFilters` plumbing
  - Add a "Manage columns for this location" button to the toolbar, opening a new `<ColumnAttachmentDialog>` modal
  - Move-to dropdown items now pass `locationId` instead of name to `onMoveSelectedRows`
  - Add-location flow already works against the new `POST /inventory/locations` (which now returns full objects); the local state update changes from `string[]` to `InventoryLocation[]`

- **`InventoryDesktopTable.tsx`**:
  - L28-31, 73-75, 124-138: replace `categoryOptions/categoryFilter/onCategoryChange` props with `groupableFilters: Map<columnKey, { selected, options, onChange }>`
  - L111-138: replace `column.key === "category"` branch with `column.isGroupable` check; render the dropdown for any groupable column

- **`InventoryMobileCards.tsx`**:
  - L147-150, 216: `expirationDate` references are fine — the column still exists, just custom. The badge logic is keyed by column key, not by `isCore`. **No change needed beyond verifying the column shows up in `visibleColumns` for the current location.**

- **`CellEditor.tsx`** — no change needed. CellEditor renders generic text/number/date/etc. cells; there was never a `location`-specific path here. The location cell rendered with the generic text path; that path simply stops being used because location stops being in `visibleColumns`.

- **`InventoryToolbar.tsx`** — add the "Manage columns" button trigger.

- **New: `ColumnAttachmentDialog.tsx`** — modal listing all org-wide custom columns with checkboxes. Toggling attaches/detaches the column for the currently-scoped location. "Create new column" inline form attaches to the current location only by default, with a checkbox to "also attach to all other locations." Validates `itemName` required client-side; warning indicator (no save block) for other "required" toggles.

- **`SettingsPage.tsx`**:
  - L342-354: `allLocations` derivation simplifies — no more merging with `values.location`; just read from `locations: InventoryLocation[]`
  - L383-423: rename location → use new id-keyed endpoint; drop the `setInventoryRows` location-rewrite (no longer needed since rows don't carry location names)
  - L425-439: remove location → use id-keyed endpoint; the "purge rows" client-side logic is replaced with a server-side "move to Default" + `ConfirmDialog` flow (per §3.2)
  - Add a new "Per-Location Columns" subsection inside the existing "Locations" disclosure, mirroring the in-page modal
  - Reword the "Inventory Columns" section copy: clarify core vs custom-org-wide vs custom-per-location

- **`AddLocationForm.tsx`** — no functional change; it still calls a parent-provided `onAdd`. Parent now updates a `InventoryLocation[]` instead of `string[]`.

- **`OnboardingPage.tsx`** — preserved as-is per scope. (The full onboarding redesign is a queued chip; this restructure deliberately leaves the existing single-screen flow alone.) The frontend `INDUSTRY_TEMPLATES` constant in this file currently includes "Location" as a column in several templates — these need to be removed since location is now structural. Replace those with the structural locations the template wants to seed (e.g. Fire/EMS template seeds `["Engine 1", "Engine 2", "Station Office"]` locations, each with appropriate column attachments). This is the bridge into the queued template-content chip — for *this* restructure we just delete the "Location" entries from the local templates list and let the existing core-only fallback take over until the template-content chip lands.

- **`OrdersPage.tsx`**:
  - L1431-1440: replace the `values.location` set-derivation with reading the locations registry directly (it's already loaded into bootstrap state)
  - L1520, 1582: persist `locationId` on order items, not `location` name; receive flow stamps `locationId` on materialized rows

- **`ReorderTab.tsx`**:
  - L190-191, 1169-1170, 1370: aggregation key becomes `itemName + locationId` (was `itemName + location name`). Internal-only, but changes the join semantics slightly: items at "Main" and "main" used to be one group, now they're two (because they're separate `locationId`s). Acceptable — they were already separate logical locations.
  - L1398, 1582: persist `locationId` on freeform restock orders
  - L1486, 1498: comments referring to "itemName + location" → update to "itemName + locationId"

- **`InventoryUsagePage.tsx`** — drop the `location` field from the usage submit payload. The server reads it from the item.

- **`inventoryApi.ts`** (the API surface):
  - Update `loadInventoryBootstrap` return shape: `locations: InventoryLocation[]`, `columnAttachments: ColumnLocationAttachment[]`
  - Add `moveInventoryItem(itemId, locationId)`, `attachColumnToLocation`, `detachColumnFromLocation`
  - Update `addInventoryLocation`, `removeInventoryLocation`, `renameInventoryLocation` signatures (id-keyed)
  - Update types: `RestockOrderItem.locationId`, `InventoryUsageEntryInput` drop `location`
  - `pruneZeroQtyRows` (L341): change signature — no `locationColumnKey` param, group by `itemName + row.locationId`

### 7.3 Generic isGroupable filter UI

Today's category dropdown is rendered in the `<th>` for `column.key === "category"`. Replace with: any column whose `isGroupable === true` gets the dropdown header. The picker shows distinct values from `row.values[column.key]` for rows in the current scope (same as today's category options).

Two natural places this replaces hardcoded behavior:
1. `InventoryDesktopTable.tsx:111-138` — the dropdown header
2. `useInventoryFilters.ts:264-285` — the options derivation

Settings UI (column management) gains a checkbox: "Show as filter dropdown in the table header" → toggles `isGroupable`.

### 7.4 Migration-related UI

- Toast on first post-migration load (per §4.3 step 10):
  ```
  We restructured your inventory. {N} items without a location were moved to a "Default" location. You can rename or split that location any time in Settings.
  ```
- Activity feed renders `MIGRATION_APPLY` events with a friendly "Inventory data model upgraded" entry.

### 7.5 String search audit (must be fully removed by end of phase 3)

After phase 3, these strings should not appear anywhere in `src/`:
- `"Unassigned"` (the sentinel)
- `UNASSIGNED_LOCATION`
- `categoryFilter`, `categoryOptions`, `categoryColumn`, `effectiveCategoryFilter` (replaced with generic groupable equivalents)
- `column.key === "category"` (replaced with `column.isGroupable`)

Lingering legitimate uses:
- `row.values.expirationDate` — fine, it's still in values, just under a custom column
- `row.values.category` — fine, it's still in values; the *specialness* is what's being removed, not the data

---

## 8. Backwards compatibility

**Locked decision: no compat layer.** With one live org and local validation before deploy, there's no realistic v0-client-v1-server overlap to support.

### 8.1 Deploy story

1. Implement + test locally against a DDB export (the migration runs as a pure function over a fixture object — fast, deterministic, repeatable).
2. Verify the local browser works end-to-end against the migrated state (Inventory CRUD, location switching, CSV import, ordering, retire/discard).
3. Deploy server + frontend together (Amplify push covers both).
4. Migration runs lazily on the first authenticated request — fast (~150 row writes for the typical org).
5. Refresh the browser and verify the toast fires.

### 8.2 Rollback path

If something goes wrong post-deploy:

1. **DynamoDB:** restore the per-org tables from PITR (already enabled in [`storage.ts:58`](amplify/functions/inventoryApi/src/storage.ts:58)) to a point just before the migration ran. PITR is per-table — restore `wickops-inventory-<orgHash>-items` and `wickops-inventory-<orgHash>-columns`.
2. **Code:** `git revert` the v1 commit, redeploy server + frontend.

Total recovery: ~10 minutes. PITR restores are atomic per table and don't affect other orgs.

### 8.3 What we explicitly are NOT doing

- No dual-read of `values.location` and `locationId` simultaneously
- No dual-write of `values.location` after the migration
- No name-keyed shim endpoints for `/inventory/locations`
- No tolerance for v0 clients hitting a v1 server (CDN caching delay is ~minutes for this app, well under the time it takes to verify the deploy)

If a second live org is added before this lands, revisit this section — the dual-write pattern from the prior version of this doc still applies if multi-tenant safety matters.

---

## 9. Test plan

### 9.1 Automated

**Locked decision: no Vitest/Jest, just Node's built-in `node --test`.** Migration tests are the only automated tests added in this restructure.

**Pure-function design.** The migration is implemented as `migrateOrg(world: World): World` over a plain JS object representing the columns + items + locations + audit-events of a single org. The DynamoDB-touching wrapper is thin: read everything, build `world`, run `migrateOrg`, diff, write changes. Tests run against fixture `world` objects without DDB.

**Test file:** `amplify/functions/inventoryApi/src/__tests__/migration.test.ts` (or `.mjs` if simpler with `node --test`).

Cases:
1. Empty org → only `Default` created
2. Org with one location, one row → row stamped with that location id, registry promoted
3. Org with `values.location` not in registry → location materialized and row stamped
4. Org with rows split across "Main" and "main" → both kept as separate locations
5. Org with all empty location rows → all moved to `Default`
6. Org with `expirationDate` column → column flipped to `isCore: false`, attached to every location
7. Idempotency: run twice → no extra writes, no extra audit events
8. Re-running on a v1 org → short-circuits via `migrationVersion >= 1` check
9. Org with `category` as custom column → promoted to core with `isGroupable: true`
10. Org with `notes` already as custom column → promoted to core (no key collision)

**Type checking:**
- `npx tsc --noEmit` clean at every phase boundary

**Staging dry-run:** before deploying, snapshot the live org's DDB tables via `aws dynamodb scan`, build a `world` object from the snapshot, run `migrateOrg` locally, diff the output, manually inspect a sample of items/columns/locations.

### 9.2 Manual smoke tests (run before merging phase 3)

For each: log in as a real user, verify in browser. Test on both desktop and mobile.

**Migration safety:**
1. Pick three production-shaped orgs (small, medium, large) and dry-run the migration in a staging environment. Diff before/after data to verify no row count change, every row has `locationId`, no row has `values.location`.

**New-org flow:**
2. Sign up a fresh org → subscribe → reach onboarding → pick a template → see Default location on Inventory page → see core-only columns + any template-attached custom columns → add a row, verify it sticks to the current location → switch to "All Locations" view, verify only core columns render.

**Existing-org migration:**
3. Open an existing org first time post-deploy → verify migration toast fires → verify all locations from the old registry are present → verify items moved to Default appear in the Default location → verify activity feed shows `MIGRATION_APPLY`.

**Per-location column attachment:**
4. In Settings, attach a custom column "Lot Number" to "Main" only → verify the column renders in Main but NOT in another location → verify "All Locations" view doesn't show it (core only).
5. Detach the column from Main → verify rows still have the values in their `valuesJson` (just hidden) → re-attach → verify values reappear (no data loss on detach).

**Move-row flow:**
6. Select 3 rows in "Main" → Move to "Storage" → verify they appear in Storage, are gone from Main → verify three `ITEM_MOVE` audit events with correct from/to.
7. Move a row back → verify event-feed records the reverse move.

**Generic isGroupable:**
8. Edit the `category` column in Settings, verify the "Show as filter dropdown" checkbox is checked. Uncheck it → verify the dropdown disappears from the table header → re-check → dropdown returns.
9. Create a new custom text column "Brand", set isGroupable: true → verify the dropdown appears. Add some values, filter by them.

**CSV import:**
10. Upload a CSV with a `Location` column → verify the location-picker step appears first → pick "Storage" → verify the column-mapping dialog hides Location with the tooltip → import → verify all rows landed in Storage regardless of CSV's `Location` column values.
11. Upload a CSV without a Location column → verify same flow works.

**Orders + Reorder:**
12. Create a restock order with a freeform item, pick "Storage" location → receive it with addToInventory → verify the materialized row has structural locationId === Storage.
13. Reorder tab: items in "Main" and "Storage" show as separate entries (was true before too — verify nothing regressed).

**Retire + Delete:**
14. Retire an item with min-quantity → verify a stub appears in the same location with quantity 0.
15. Delete a 0-quantity row → verify it's gone, audit event recorded.

**No string regressions:**
16. `grep -r "Unassigned" src/` → zero hits.
17. `grep -r "UNASSIGNED_LOCATION" src/` → zero hits.
18. `grep -rn 'column.key === "category"' src/` → zero hits.

### 9.3 Smoke order in CI/staging

The migration is the load-bearing change. Do a staging dry-run on a snapshot of production data (DynamoDB export → restore to staging tables) before deploying to prod. This is the moment to catch a missed `values.location` writer.

---

## 10. Definition of done (for this restructure as a whole)

- `docs/RESTRUCTURE_SPEC.md` exists and was reviewed by the user
- Existing orgs migrate cleanly; nothing observable breaks
- New orgs onboard into the new model
- Inventory page renders core columns + this location's attached custom columns; "All Locations" shows core only
- Per-location column management works from both the inventory toolbar and Settings
- `Unassigned` is gone from the codebase
- `category` is just a core column with `isGroupable: true`; the special path is removed
- `ITEM_MOVE` events are emitted for moves
- `expirationDate` is custom (per-location)
- Two waiting chips' prompts have been updated with the new model
- `npx tsc --noEmit` passes
- Manual smoke tests in §9.2 pass

---

## Locked decisions (carried into phase 2)

| # | Decision | Where in spec |
|---|---|---|
| 1 | Reuse columns table with `kind` discriminator. No new tables. No GSI on `kind`. Attachments live on the column row as `attachedLocationIds: string[]` — no separate join entity. | §2.4, §2.6 |
| 2 | Structural pointer is `locationId` (UUID), not name. Name lookups via `Map<id, location>` built once at bootstrap. | §2.1 |
| 3 | Don't backfill audit history. Feed renderer cosmetically maps old `ITEM_EDIT`-with-only-`location`-change events to "Moved" rows. | §5.3 |
| 4 | Single coordinated deploy. No dual-read, no dual-write. Local validation against a DDB export first; rollback is PITR + git revert. | §4.4, §8 |
| 5 | Migration tests use Node's built-in `node --test` over a pure `migrateOrg(world)` function. No Vitest/Jest. Plus a staging dry-run on a snapshot of the live org. | §9.1 |
