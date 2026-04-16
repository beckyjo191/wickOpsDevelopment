// ── Foundation: normalize.ts ────────────────────────────────────────────────
// Normalization and utility functions extracted from handler.ts.

import { createHash } from "node:crypto";
import { ALL_MODULE_KEYS, LEGACY_MODULE_ALIASES, INVENTORY_ORG_TABLE_PREFIX, INVENTORY_STORAGE_NAMESPACE } from "./config";
import type { AccessContext, ModuleKey } from "./types";

export const normalizeRole = (value: unknown): string => String(value ?? "").trim().toUpperCase();

export const normalizeOrgId = (value: unknown): string => String(value ?? "").trim();

export const normalizeEmail = (value: unknown): string => String(value ?? "").trim().toLowerCase();

export const normalizeLooseKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const coerceModuleKey = (raw: unknown, valid: Set<ModuleKey>): ModuleKey | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (valid.has(normalized as ModuleKey)) return normalized as ModuleKey;
  const aliased = LEGACY_MODULE_ALIASES[normalized];
  return aliased && valid.has(aliased) ? aliased : null;
};

export const normalizeModuleKey = (value: unknown): ModuleKey | null =>
  coerceModuleKey(value, new Set(ALL_MODULE_KEYS));

export const toKey = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const sanitizeOrgIdForTableName = (organizationId: string): string =>
  organizationId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "org";

export const buildOrgScopedTableName = (organizationId: string, suffix: "columns" | "items" | "pending" | "auditlog" | "restock-orders"): string => {
  const safeOrg = sanitizeOrgIdForTableName(organizationId);
  const hash = createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
  return `${INVENTORY_ORG_TABLE_PREFIX}-${INVENTORY_STORAGE_NAMESPACE}-${safeOrg}-${hash}-${suffix}`;
};

// Normalize a raw DDB value into a valid subset of allValid. Legacy module
// aliases (see LEGACY_MODULE_ALIASES) are remapped so stored records from the
// pre-consolidation era don't silently lose permissions.
// null/absent → allValid (backward-compat: existing orgs without enabledModules get full access).
// NOTE: This also serves as getUserAllowedModules — the logic is identical.
export const normalizeModuleSubset = (value: unknown, allValid: ModuleKey[]): ModuleKey[] => {
  if (!Array.isArray(value)) return [...allValid];
  const s = new Set(allValid);
  const out = new Set<ModuleKey>();
  for (const raw of value) {
    const key = coerceModuleKey(raw, s);
    if (key) out.add(key);
  }
  return out.size > 0 ? [...out] : [...allValid];
};

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const hasModuleAccess = (
  access: AccessContext,
  required: ModuleKey | ModuleKey[],
): boolean => {
  const requiredModules = Array.isArray(required) ? required : [required];
  return requiredModules.some((moduleKey) => access.allowedModules.includes(moduleKey));
};
