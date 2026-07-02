// ── Location hierarchy helpers ───────────────────────────────────────────────
// Locations form a two-level tree via `parentLocationId`:
//   - a top-level location is a "primary" (e.g. Station 1)
//   - a location with a parent is a "sublocation" (e.g. Station 1 / EMS Cabinet)
//
// ANY location can hold stock — a primary keeps its own items AND can have
// sublocations. So every roll-up (reorder need, dashboard alert counts) is a
// subtree sum over the selected location PLUS its sublocations. These helpers
// are the single source of truth for that shape; pickers, the reorder math,
// and the dashboard all consume them.

import type { InventoryLocation } from "./inventoryApi";

const parentOf = (loc: InventoryLocation): string =>
  (loc.parentLocationId ?? "").trim();

const bySortOrder = (a: InventoryLocation, b: InventoryLocation): number =>
  Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0);

/** A root location together with its (already sort-ordered) child leaves. */
export type LocationNode = {
  location: InventoryLocation;
  children: InventoryLocation[];
};

/** Build the ordered list of root nodes, each carrying its children. Roots and
 *  children are both sorted by sortOrder. */
export const buildLocationTree = (locations: InventoryLocation[]): LocationNode[] => {
  const childrenByParent = new Map<string, InventoryLocation[]>();
  for (const loc of locations) {
    const pid = parentOf(loc);
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(loc);
    childrenByParent.set(pid, arr);
  }
  return locations
    .filter((l) => !parentOf(l))
    .sort(bySortOrder)
    .map((location) => ({
      location,
      children: (childrenByParent.get(location.id) ?? []).slice().sort(bySortOrder),
    }));
};

/** True when a location has sublocations — i.e. it's a primary with children. */
export const isStation = (locations: InventoryLocation[], id: string): boolean =>
  locations.some((l) => parentOf(l) === id);

/** Name of the auto-created child bucket that holds stock saved into a station.
 *  Mirrors DEFAULT_BUCKET_NAME on the backend (amplify .../locations.ts). */
export const DEFAULT_BUCKET_NAME = "General";

/** The id of a station's default stock bucket child ("General"), or null when
 *  it doesn't exist yet. The optimistic add path uses this to stamp a leaf
 *  instead of the parent; if it's null the backend creates the bucket on save
 *  and the post-save reload reconciles the row into it. */
export const defaultBucketChildId = (
  locations: InventoryLocation[],
  parentId: string,
): string | null => {
  const norm = (s: string): string => s.trim().toLowerCase();
  const target = norm(DEFAULT_BUCKET_NAME);
  const child = locations.find(
    (l) => parentOf(l) === parentId && norm(l.name) === target,
  );
  return child ? child.id : null;
};

/**
 * The set of location ids whose stock rolls up to a given scope:
 *   - empty / null scope  → every location ("All Locations")
 *   - a primary           → itself + its sublocations
 *   - a sublocation       → just itself
 * Any location can hold stock, so the scope always includes the location
 * itself (a primary's own items count) plus its sublocations.
 */
export const locationsInScope = (
  locations: InventoryLocation[],
  scopeId: string | null | undefined,
): Set<string> => {
  const scope = (scopeId ?? "").trim();
  if (!scope) return new Set(locations.map((l) => l.id));
  const ids = new Set<string>([scope]);
  for (const l of locations) {
    if (parentOf(l) === scope) ids.add(l.id);
  }
  return ids;
};

/** Human label for a location, prefixed with its station when nested
 *  (e.g. "Station 1 / EMS Cabinet"). Used where a flat label needs full
 *  context — exports, audit rows, breakdown chips. */
export const locationPath = (
  locations: InventoryLocation[],
  id: string,
): string => {
  const loc = locations.find((l) => l.id === id);
  if (!loc) return "";
  const pid = parentOf(loc);
  if (!pid) return loc.name;
  const parent = locations.find((l) => l.id === pid);
  return parent ? `${parent.name} / ${loc.name}` : loc.name;
};

/** A flattened, render-ready entry for grouped location dropdowns. Roots come
 *  first (depth 0), each immediately followed by its children (depth 1). */
export type LocationPickerEntry = {
  id: string;
  name: string;
  depth: 0 | 1;
  /** Root with children — selecting it means "roll up the whole station". */
  isStation: boolean;
  /** Self-describing label: "EMS Cabinet" for a primary, "Station 1 / EMS
   *  Cabinet" for a sublocation — so a dropdown's CLOSED value still tells you
   *  which station a cabinet belongs to. */
  label: string;
};

/** Flatten the tree into an ordered list for rendering a grouped picker. */
export const buildLocationPickerEntries = (
  locations: InventoryLocation[],
): LocationPickerEntry[] => {
  const tree = buildLocationTree(locations);
  const entries: LocationPickerEntry[] = [];
  for (const node of tree) {
    const station = node.children.length > 0;
    entries.push({ id: node.location.id, name: node.location.name, depth: 0, isStation: station, label: node.location.name });
    for (const child of node.children) {
      entries.push({ id: child.id, name: child.name, depth: 1, isStation: false, label: `${node.location.name} / ${child.name}` });
    }
  }
  return entries;
};
