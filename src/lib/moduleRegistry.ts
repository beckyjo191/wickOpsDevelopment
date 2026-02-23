// ─────────────────────────────────────────────────────────────────────────────
// moduleRegistry.ts
// Single source of truth for WickOps module definitions.
//
// To add a new module:
//   1. Add one entry to MODULE_REGISTRY
//   2. Add the key to AppModuleKey
//   3. Add the key to PLAN_MODULE_MAP for each plan that should unlock it
//   4. Add the key to ALL_MODULE_KEYS in each Lambda handler
// ─────────────────────────────────────────────────────────────────────────────

export type AppModuleKey = "inventory" | "usage";

export type ModuleDefinition = {
  key: AppModuleKey;
  name: string;
  description: string;
  /** Minimum plan required to access this module */
  minPlan: "Personal" | "Department" | "Organization";
};

export const MODULE_REGISTRY: ModuleDefinition[] = [
  {
    key: "inventory",
    name: "Inventory",
    description: "Track and manage your organization's inventory items.",
    minPlan: "Personal",
  },
  {
    key: "usage",
    name: "Usage Form",
    description: "Record usage events and checkouts against inventory items.",
    minPlan: "Personal",
  },
];

/** Quick lookup by module key */
export const MODULE_BY_KEY: Record<AppModuleKey, ModuleDefinition> =
  Object.fromEntries(
    MODULE_REGISTRY.map((m) => [m.key, m]),
  ) as Record<AppModuleKey, ModuleDefinition>;

// ─── Plan → Module mapping ───────────────────────────────────────────────────
// Defines which modules each plan unlocks (the "available pool").
// Future premium modules can be gated to Department+ or Organization+ here.

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
