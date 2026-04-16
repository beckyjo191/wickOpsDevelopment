// ── Foundation: config.ts ───────────────────────────────────────────────────
// Constants and configuration extracted from handler.ts.

import { createHash } from "node:crypto";
import type { ModuleKey } from "./types";

export const USER_TABLE = process.env.USER_TABLE!;
export const USER_POOL_ID = process.env.USER_POOL_ID ?? "";
export const ORG_TABLE = process.env.ORG_TABLE!;
export const DEFAULT_INVENTORY_COLUMN_TABLE = process.env.INVENTORY_COLUMN_TABLE!;
export const DEFAULT_INVENTORY_ITEM_TABLE = process.env.INVENTORY_ITEM_TABLE!;
export const ENABLE_PER_ORG_TABLES =
  String(process.env.ENABLE_PER_ORG_INVENTORY_TABLES ?? "true").trim().toLowerCase() !== "false";
export const INVENTORY_ORG_TABLE_PREFIX =
  String(process.env.INVENTORY_ORG_TABLE_PREFIX ?? "wickops-inventory").trim() ||
  "wickops-inventory";
export const INVENTORY_STORAGE_NAMESPACE = createHash("sha256")
  .update(`${USER_TABLE}|${INVENTORY_ORG_TABLE_PREFIX}`)
  .digest("hex")
  .slice(0, 8);
export const INVENTORY_COLUMN_BY_MODULE_INDEX = "ByModuleSortOrder";
export const INVENTORY_ITEM_BY_MODULE_INDEX = "ByModulePosition";

export const EDIT_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"]);
export const COLUMN_ADMIN_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);
export const OWNER_ROLES = new Set(["OWNER", "ACCOUNT_OWNER"]);
export const CORE_KEYS = new Set(["quantity", "minQuantity", "expirationDate", "reorderLink", "unitCost"]);
export const STORAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const PROVISIONING_RETRY_AFTER_MS = 2000;

// ── MODULE SYNC NOTE ────────────────────────────────────────────────────────
// This list must be kept in sync with AppModuleKey in src/lib/moduleRegistry.ts.
// When a new module goes stable:
//   1. Add its key to ALL_MODULE_KEYS here (and in userSubscriptionCheck/handler.ts)
//   2. Add it to PLAN_MODULE_MAP for each plan that should unlock it (both handlers)
//   3. Provision any new DynamoDB tables in ensureOrgInventoryTables() if needed
//   4. Follow remaining steps documented in src/lib/moduleRegistry.ts
// ────────────────────────────────────────────────────────────────────────────
export const ALL_MODULE_KEYS = ["inventory"] as const;

// Legacy keys folded into a current module. Stored records may still contain
// these; normalize.ts remaps them on read so permissions survive the change.
export const LEGACY_MODULE_ALIASES: Record<string, ModuleKey> = {
  usage: "inventory",
};

// Plan → module mapping. Unrecognized plan = no modules (no fallback to all).
export const PLAN_MODULE_MAP: Record<string, ModuleKey[]> = {
  Personal:     ["inventory"],
  Department:   ["inventory"],
  Organization: ["inventory"],
  Sponsored:    ["inventory"],
};

export const getAvailableModulesForPlan = (plan: string): ModuleKey[] =>
  PLAN_MODULE_MAP[plan] ?? [];

export const DEPLOYMENT_ENV = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();

export const HEADER_ALIASES: Record<string, string> = {
  itemname: "itemName",
  itemid: "itemName",
  name: "itemName",
  quantity: "quantity",
  qty: "quantity",
  minimumquantity: "minQuantity",
  minquantity: "minQuantity",
  minqty: "minQuantity",
  minimumqty: "minQuantity",
  expirationdate: "expirationDate",
  expirydate: "expirationDate",
  expdate: "expirationDate",
};

export const AUDIT_BY_TIMESTAMP_INDEX = "ByTimestamp";
export const AUDIT_BY_USER_INDEX = "ByUser";
export const AUDIT_TTL_DAYS = 365;
