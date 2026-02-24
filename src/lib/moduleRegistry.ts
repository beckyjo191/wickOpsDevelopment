// ─────────────────────────────────────────────────────────────────────────────
// moduleRegistry.ts
// Single source of truth for WickOps module definitions.
//
// To add a new module (all 6 steps are required):
//   1. Add the key to AppModuleKey union type
//   2. Add one entry to MODULE_REGISTRY with all fields
//   3. Add the key to PLAN_MODULE_MAP for each plan that should unlock it
//   4. Add the key to ALL_MODULE_KEYS in both Lambda handlers:
//        amplify/functions/inventoryApi/src/handler.ts
//        amplify/functions/userSubscriptionCheck/src/handler.ts
//      …and update their PLAN_MODULE_MAP to match
//   5. Create the frontend component + route (see InventoryPage / InventoryUsagePage as examples)
//   6. Provision any new DynamoDB tables in ensureOrgInventoryTables() if needed
//
// Example — adding a "maintenanceLog" module when it's ready:
//   AppModuleKey = "inventory" | "usage" | "maintenanceLog"
//   MODULE_REGISTRY entry:
//     { key: "maintenanceLog", name: "Maintenance Log", icon: "🔧",
//       category: "maintenance", status: "stable",
//       description: "Log and track equipment maintenance events.",
//       industryTags: ["plumbing", "fire-department"],
//       minPlan: "Department" }
// ─────────────────────────────────────────────────────────────────────────────

export type AppModuleKey = "inventory" | "usage";

export type ModuleStatus = "stable" | "beta" | "coming-soon";

export type ModuleCategory = "operations" | "maintenance" | "fleet" | "safety";

export type ModuleDefinition = {
  key: AppModuleKey;
  name: string;
  description: string;
  /** Emoji or unicode glyph rendered as the module icon — no icon library required */
  icon: string;
  category: ModuleCategory;
  /** Only "stable" modules appear in the marketplace UI and can be toggled */
  status: ModuleStatus;
  /** Optional industry tags for future filtering, e.g. ["fire-department", "plumbing"] */
  industryTags?: string[];
  /** Minimum plan required to access this module */
  minPlan: "Personal" | "Department" | "Organization";
};

export const MODULE_REGISTRY: ModuleDefinition[] = [
  {
    key: "inventory",
    name: "Inventory",
    description: "Track and manage your organization's inventory items, quantities, and expiration dates.",
    icon: "📦",
    category: "operations",
    status: "stable",
    industryTags: ["general", "fire-department", "plumbing", "ems"],
    minPlan: "Personal",
  },
  {
    key: "usage",
    name: "Usage Form",
    description: "Record usage events and checkouts against inventory items.",
    icon: "📋",
    category: "operations",
    status: "stable",
    industryTags: ["general", "fire-department", "plumbing", "ems"],
    minPlan: "Personal",
  },
];

/** Quick lookup by module key */
export const MODULE_BY_KEY: Record<AppModuleKey, ModuleDefinition> =
  Object.fromEntries(
    MODULE_REGISTRY.map((m) => [m.key, m]),
  ) as Record<AppModuleKey, ModuleDefinition>;

/** Returns only fully-implemented modules (status === "stable" or "beta") */
export const getStableModules = (): ModuleDefinition[] =>
  MODULE_REGISTRY.filter((m) => m.status === "stable" || m.status === "beta");

// ─── Plan → Module mapping ───────────────────────────────────────────────────
// Defines which modules each plan unlocks (the "available pool").
// Future premium modules can be gated to Department+ or Organization+ here.
// This must be kept in sync with PLAN_MODULE_MAP in both Lambda handlers.

export const PLAN_MODULE_MAP: Record<string, AppModuleKey[]> = {
  Personal:     ["inventory", "usage"],
  Department:   ["inventory", "usage"],
  Organization: ["inventory", "usage"],
};

/**
 * Returns the modules available to an org on a given plan.
 * Returns [] for unrecognized plans — no plan match = no module access.
 */
export const getAvailableModulesForPlan = (plan: string): AppModuleKey[] =>
  PLAN_MODULE_MAP[plan] ?? [];

/**
 * Normalizes an unknown value (e.g. from API response) into a valid
 * AppModuleKey[]. Deduplicates and filters to only recognized keys.
 */
export const normalizeModuleKeys = (value: unknown): AppModuleKey[] => {
  if (!Array.isArray(value)) return [];
  const valid = new Set(MODULE_REGISTRY.map((m) => m.key));
  return [
    ...new Set(
      value
        .map((i) => String(i ?? "").trim().toLowerCase())
        .filter((i): i is AppModuleKey => valid.has(i as AppModuleKey)),
    ),
  ];
};
