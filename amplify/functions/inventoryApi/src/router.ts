// ── Declarative route table ─────────────────────────────────────────────────
import type { AccessContext, InventoryStorage, ModuleKey, LambdaResponse, RouteContext } from "./types";
import { json } from "./http";
import { hasModuleAccess } from "./normalize";
import { ensureStorageForOrganization } from "./storage";

// Route handlers
import { handleGetOrgModules, handleUpdateOrgModules, handleListModuleAccessUsers, handleUpdateUserModuleAccess, handleRevokeUserAccess } from "./routes/modules";
import { handleUpdateCurrentUserDisplayName, handleSyncCurrentUserEmail, handleSaveUserColumnVisibility } from "./routes/profile";
import { handleListOnboardingTemplates, handleApplyOnboardingTemplate } from "./routes/onboarding";
import { handleAuditFeed, handleAuditItemHistory, handleAuditAnalytics } from "./routes/audit";
import { handleListRestockOrders, handleCreateRestockOrder, handleReceiveRestockOrder, handleCloseRestockOrder } from "./routes/restock";
import { handleAddLocation, handleRemoveLocation, handleRenameLocation } from "./routes/locations";
import { handleAlertSummary, handleBootstrap } from "./routes/dashboard";
import { handleListItems, handleSaveItems } from "./routes/inventory";
import { handleSubmitUsage, handleListPendingSubmissions, handleApproveSubmission, handleRejectSubmission, handleDeleteSubmission } from "./routes/usage";
import { handleImportCsv } from "./routes/csv-import";
import { handleCreateColumn, handleDeleteColumn, handleUpdateColumnVisibility, handleUpdateColumnLabel, handleUpdateColumnType, handleReorderColumns, handleDeleteOrganizationStorage } from "./routes/column-mgmt";

type RouteHandler = (ctx: RouteContext) => Promise<ReturnType<typeof json>>;

type Route = {
  method: "GET" | "POST" | "DELETE";
  pattern: string | RegExp;
  module?: ModuleKey | ModuleKey[];
  needsStorage: boolean;
  handler: RouteHandler;
};

// Routes are matched in order. More specific patterns MUST come before general ones.
// needsStorage: false → dispatched BEFORE ensureStorageForOrganization (pre-storage routes)
const routes: Route[] = [
  // ── Pre-storage routes (no org tables needed) ─────────────────────────────
  { method: "GET",    pattern: "/inventory/org-modules",                needsStorage: false, handler: handleGetOrgModules },
  { method: "POST",   pattern: "/inventory/org-modules",                needsStorage: false, handler: handleUpdateOrgModules },
  { method: "GET",    pattern: "/inventory/module-access/users",        needsStorage: false, handler: handleListModuleAccessUsers },
  { method: "POST",   pattern: /\/inventory\/module-access\/users\/[^/]+$/, needsStorage: false, handler: handleUpdateUserModuleAccess },
  { method: "DELETE",  pattern: /\/inventory\/module-access\/users\/[^/]+$/, needsStorage: false, handler: handleRevokeUserAccess },
  { method: "POST",   pattern: "/inventory/profile/display-name",       needsStorage: false, handler: handleUpdateCurrentUserDisplayName },
  { method: "POST",   pattern: "/inventory/profile/email/sync",         needsStorage: false, handler: handleSyncCurrentUserEmail },
  { method: "POST",   pattern: "/inventory/column-visibility",          needsStorage: false, handler: handleSaveUserColumnVisibility },
  { method: "GET",    pattern: "/inventory/onboarding/templates",       needsStorage: false, handler: handleListOnboardingTemplates },

  // ── Post-storage routes (org tables required) ─────────────────────────────
  { method: "POST",   pattern: "/inventory/onboarding/apply-template",  needsStorage: true, handler: handleApplyOnboardingTemplate },

  // Audit
  { method: "GET",    pattern: "/inventory/audit/feed",                 needsStorage: true, module: "inventory", handler: handleAuditFeed },
  { method: "GET",    pattern: /\/inventory\/audit\/item\/[^/]+$/,      needsStorage: true, module: "inventory", handler: handleAuditItemHistory },
  { method: "GET",    pattern: "/inventory/audit/analytics",            needsStorage: true, module: "inventory", handler: handleAuditAnalytics },

  // Restock
  { method: "GET",    pattern: "/inventory/restock/orders",             needsStorage: true, module: "inventory", handler: handleListRestockOrders },
  { method: "POST",   pattern: "/inventory/restock/orders",             needsStorage: true, module: "inventory", handler: handleCreateRestockOrder },
  { method: "POST",   pattern: /\/inventory\/restock\/orders\/[^/]+\/receive$/, needsStorage: true, module: "inventory", handler: handleReceiveRestockOrder },
  { method: "POST",   pattern: /\/inventory\/restock\/orders\/[^/]+\/close$/,   needsStorage: true, module: "inventory", handler: handleCloseRestockOrder },

  // Locations
  { method: "POST",   pattern: "/inventory/locations",                  needsStorage: true, module: "inventory", handler: handleAddLocation },
  { method: "DELETE",  pattern: "/inventory/locations",                  needsStorage: true, module: "inventory", handler: handleRemoveLocation },
  { method: "POST",   pattern: "/inventory/locations/rename",           needsStorage: true, module: "inventory", handler: handleRenameLocation },

  // Dashboard / bootstrap
  { method: "GET",    pattern: "/inventory/alert-summary",              needsStorage: true, module: ["inventory", "usage"], handler: handleAlertSummary },
  { method: "GET",    pattern: "/inventory/bootstrap",                  needsStorage: true, module: ["inventory", "usage"], handler: handleBootstrap },

  // Items
  { method: "GET",    pattern: "/inventory/items",                      needsStorage: true, module: "inventory", handler: handleListItems },
  { method: "POST",   pattern: "/inventory/items/save",                 needsStorage: true, module: "inventory", handler: handleSaveItems },

  // Usage
  { method: "POST",   pattern: "/inventory/usage/submit",              needsStorage: true, module: "usage", handler: handleSubmitUsage },
  { method: "GET",    pattern: "/inventory/usage/pending",             needsStorage: true, module: "usage", handler: handleListPendingSubmissions },
  { method: "POST",   pattern: /\/inventory\/usage\/pending\/[^/]+\/approve$/, needsStorage: true, module: "usage", handler: handleApproveSubmission },
  { method: "POST",   pattern: /\/inventory\/usage\/pending\/[^/]+\/reject$/,  needsStorage: true, module: "usage", handler: handleRejectSubmission },
  { method: "DELETE",  pattern: /\/inventory\/usage\/pending\/[^/]+$/,  needsStorage: true, module: "usage", handler: handleDeleteSubmission },

  // CSV import
  { method: "POST",   pattern: "/inventory/import-csv",                needsStorage: true, module: "inventory", handler: handleImportCsv },

  // Column management (specific patterns first)
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/visibility$/, needsStorage: true, module: "inventory", handler: handleUpdateColumnVisibility },
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/label$/,      needsStorage: true, module: "inventory", handler: handleUpdateColumnLabel },
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/type$/,       needsStorage: true, module: "inventory", handler: handleUpdateColumnType },
  { method: "POST",   pattern: "/inventory/columns/reorder",              needsStorage: true, module: "inventory", handler: handleReorderColumns },
  { method: "POST",   pattern: "/inventory/columns",                      needsStorage: true, module: "inventory", handler: handleCreateColumn },
  { method: "DELETE",  pattern: /\/inventory\/columns\/[^/]+$/,            needsStorage: true, module: "inventory", handler: handleDeleteColumn },

  // Org storage deletion
  { method: "DELETE",  pattern: "/inventory/organization-storage",      needsStorage: true, module: "inventory", handler: handleDeleteOrganizationStorage },
];

function matchPattern(pattern: string | RegExp, path: string): boolean {
  if (typeof pattern === "string") return path.endsWith(pattern);
  return pattern.test(path);
}

/**
 * Match the request to a route and execute the handler.
 * Returns null if no route matches (caller should return 404).
 */
export async function dispatch(
  method: string,
  path: string,
  access: AccessContext,
  body: any,
  query: Record<string, string | undefined>,
): Promise<ReturnType<typeof json> | null> {
  let storage: InventoryStorage | null = null;

  for (const route of routes) {
    if (route.method !== method) continue;
    if (!matchPattern(route.pattern, path)) continue;

    // Module access check (uniform for all routes that declare a module)
    if (route.module && !hasModuleAccess(access, route.module)) {
      return json(403, { error: "Module access denied" });
    }

    // Lazy storage provisioning — only when the matched route needs it
    if (route.needsStorage && !storage) {
      storage = await ensureStorageForOrganization(access.organizationId);
    }

    const ctx: RouteContext = {
      access,
      storage: storage as InventoryStorage,
      body,
      path,
      query,
    };

    return route.handler(ctx);
  }

  return null; // no match
}
