// ── Declarative route table ─────────────────────────────────────────────────
import type { AccessContext, InventoryStorage, ModuleKey, LambdaResponse, RouteContext } from "./types";
import { json } from "./http";
import { hasModuleAccess } from "./normalize";
import { ensureStorageForOrganization } from "./storage";

// Route handlers
import { handleGetOrgModules, handleUpdateOrgModules, handleListModuleAccessUsers, handleUpdateUserModuleAccess, handleRevokeUserAccess } from "./routes/modules";
import { handleUpdateCurrentUserDisplayName, handleSyncCurrentUserEmail, handleSaveUserColumnVisibility } from "./routes/profile";
import { handleListOnboardingTemplates, handleApplyOnboardingTemplate } from "./routes/onboarding";
import { handleAuditFeed, handleAuditItemHistory, handleAuditAnalytics, handleVendorBreakdown, handleAnalyticsBreakdown } from "./routes/audit";
import { handleListRestockOrders, handleCreateRestockOrder, handleReceiveRestockOrder, handleCloseRestockOrder } from "./routes/restock";
import { handleGetPriceHistory } from "./routes/price-history";
import { handleListVendorPricing, handleUpsertVendorPricing, handleDeleteVendorPricing } from "./routes/vendor-pricing";
import { handleGetAllowedUnits, handleSetAllowedUnits } from "./routes/allowed-units";
import { handleAddLocation, handleListLocations, handleRemoveLocation, handleRenameLocation } from "./routes/locations";
import { handleAddVendor, handleRemoveVendor, handleRenameVendor } from "./routes/vendors";
import { handleAlertSummary, handleBootstrap } from "./routes/dashboard";
import { handleListItems, handleMoveItems, handleSaveItems, handleUndoRetire, handleUpdateItemPricing } from "./routes/inventory";
import { handleSubmitUsage, handleListPendingSubmissions, handleApproveSubmission, handleRejectSubmission, handleDeleteSubmission, handleUndoUsage } from "./routes/usage";
import { handleImportCsv } from "./routes/csv-import";
import { handleCreateColumn, handleDeleteColumn, handleRestoreColumn, handleUpdateColumnAttachments, handleUpdateColumnVisibility, handleUpdateColumnLabel, handleUpdateColumnType, handleReorderColumns, handleDeleteOrganizationStorage } from "./routes/column-mgmt";

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
  { method: "GET",    pattern: "/inventory/audit/analytics/vendor",     needsStorage: true, module: "inventory", handler: handleVendorBreakdown },
  { method: "GET",    pattern: "/inventory/audit/analytics/breakdown",  needsStorage: true, module: "inventory", handler: handleAnalyticsBreakdown },

  // Restock
  { method: "GET",    pattern: "/inventory/restock/orders",             needsStorage: true, module: "inventory", handler: handleListRestockOrders },
  { method: "POST",   pattern: "/inventory/restock/orders",             needsStorage: true, module: "inventory", handler: handleCreateRestockOrder },
  { method: "POST",   pattern: /\/inventory\/restock\/orders\/[^/]+\/receive$/, needsStorage: true, module: "inventory", handler: handleReceiveRestockOrder },
  { method: "POST",   pattern: /\/inventory\/restock\/orders\/[^/]+\/close$/,   needsStorage: true, module: "inventory", handler: handleCloseRestockOrder },

  // Price history (1d) — aggregates per-(itemName, vendor) latest $/canonical
  // within the recency window. Powers the shopping-list comparison badge.
  { method: "GET",    pattern: "/inventory/price-history",              needsStorage: true, module: "inventory", handler: handleGetPriceHistory },

  // Vendor pricing (1g) — per-(item, vendor) pricing rows. Replaces the
  // previous pattern of stuffing unitCost/packSize/packCost/reorderLink onto
  // each inventory item.
  { method: "GET",    pattern: "/inventory/item-vendor-pricing",        needsStorage: true, module: "inventory", handler: handleListVendorPricing },
  { method: "POST",   pattern: "/inventory/item-vendor-pricing",        needsStorage: true, module: "inventory", handler: handleUpsertVendorPricing },
  { method: "DELETE", pattern: /\/inventory\/item-vendor-pricing\/[^/]+$/, needsStorage: true, module: "inventory", handler: handleDeleteVendorPricing },

  // Allowed units (1h.2) — per-org curated list of units that appear in
  // inventory + receipt-entry dropdowns. Cuts visual noise for orgs that
  // only deal in count units (EMS) vs. those that need volume + weight.
  { method: "GET",    pattern: "/inventory/allowed-units",              needsStorage: true, module: "inventory", handler: handleGetAllowedUnits },
  { method: "POST",   pattern: "/inventory/allowed-units",              needsStorage: true, module: "inventory", handler: handleSetAllowedUnits },

  // Locations
  { method: "GET",    pattern: "/inventory/locations",                  needsStorage: true, module: "inventory", handler: handleListLocations },
  { method: "POST",   pattern: "/inventory/locations",                  needsStorage: true, module: "inventory", handler: handleAddLocation },
  { method: "DELETE",  pattern: "/inventory/locations",                  needsStorage: true, module: "inventory", handler: handleRemoveLocation },
  { method: "POST",   pattern: "/inventory/locations/rename",           needsStorage: true, module: "inventory", handler: handleRenameLocation },

  // Vendors
  { method: "POST",   pattern: "/inventory/vendors",                    needsStorage: true, module: "inventory", handler: handleAddVendor },
  { method: "DELETE",  pattern: "/inventory/vendors",                    needsStorage: true, module: "inventory", handler: handleRemoveVendor },
  { method: "POST",   pattern: "/inventory/vendors/rename",             needsStorage: true, module: "inventory", handler: handleRenameVendor },

  // Dashboard / bootstrap
  { method: "GET",    pattern: "/inventory/alert-summary",              needsStorage: true, module: "inventory", handler: handleAlertSummary },
  { method: "GET",    pattern: "/inventory/bootstrap",                  needsStorage: true, module: "inventory", handler: handleBootstrap },

  // Items
  { method: "GET",    pattern: "/inventory/items",                      needsStorage: true, module: "inventory", handler: handleListItems },
  { method: "POST",   pattern: "/inventory/items/save",                 needsStorage: true, module: "inventory", handler: handleSaveItems },
  { method: "POST",   pattern: "/inventory/items/move",                 needsStorage: true, module: "inventory", handler: handleMoveItems },
  { method: "POST",   pattern: "/inventory/items/pricing",              needsStorage: true, module: "inventory", handler: handleUpdateItemPricing },
  { method: "POST",   pattern: "/inventory/items/undo-retire",          needsStorage: true, module: "inventory", handler: handleUndoRetire },

  // Usage (feature within the inventory module; role-based gating applies inside handlers)
  { method: "POST",   pattern: "/inventory/usage/submit",              needsStorage: true, module: "inventory", handler: handleSubmitUsage },
  { method: "POST",   pattern: "/inventory/usage/undo",                needsStorage: true, module: "inventory", handler: handleUndoUsage },
  // The pending approval flow has been replaced by direct decrement + undo.
  // These routes remain so any pending submissions queued before deploy can be
  // drained manually; they are unreferenced from the frontend and will be
  // removed in a follow-up once the queue is empty.
  { method: "GET",    pattern: "/inventory/usage/pending",             needsStorage: true, module: "inventory", handler: handleListPendingSubmissions },
  { method: "POST",   pattern: /\/inventory\/usage\/pending\/[^/]+\/approve$/, needsStorage: true, module: "inventory", handler: handleApproveSubmission },
  { method: "POST",   pattern: /\/inventory\/usage\/pending\/[^/]+\/reject$/,  needsStorage: true, module: "inventory", handler: handleRejectSubmission },
  { method: "DELETE",  pattern: /\/inventory\/usage\/pending\/[^/]+$/,  needsStorage: true, module: "inventory", handler: handleDeleteSubmission },

  // CSV import
  { method: "POST",   pattern: "/inventory/import-csv",                needsStorage: true, module: "inventory", handler: handleImportCsv },

  // Column management (specific patterns first)
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/visibility$/, needsStorage: true, module: "inventory", handler: handleUpdateColumnVisibility },
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/label$/,      needsStorage: true, module: "inventory", handler: handleUpdateColumnLabel },
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/type$/,       needsStorage: true, module: "inventory", handler: handleUpdateColumnType },
  { method: "POST",   pattern: /\/inventory\/columns\/[^/]+\/attachments$/, needsStorage: true, module: "inventory", handler: handleUpdateColumnAttachments },
  { method: "POST",   pattern: "/inventory/columns/reorder",              needsStorage: true, module: "inventory", handler: handleReorderColumns },
  { method: "POST",   pattern: "/inventory/columns/restore",              needsStorage: true, module: "inventory", handler: handleRestoreColumn },
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
