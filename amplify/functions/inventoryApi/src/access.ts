// ── Shared: access.ts ───────────────────────────────────────────────────────
// Authentication / authorization context builder.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import {
  USER_TABLE,
  ORG_TABLE,
  EDIT_ROLES,
  COLUMN_ADMIN_ROLES,
  getAvailableModulesForPlan,
} from "./config";
import {
  normalizeRole,
  normalizeOrgId,
  normalizeEmail,
  normalizeModuleSubset,
} from "./normalize";
import type { AccessContext, UserRecord } from "./types";

export const getAccessContext = async (event: any): Promise<AccessContext> => {
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ??
    event.requestContext?.authorizer?.claims;

  const userId = String(claims?.sub ?? "").trim();
  if (!userId) throw new Error("Unauthorized");
  const claimEmail = claims?.email ? normalizeEmail(claims.email) : "";

  const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
  const user = userRes.Item as UserRecord | undefined;
  if (!user || !user.organizationId) {
    throw new Error("User or organization not found");
  }
  if (claimEmail) {
    const persistedEmail = normalizeEmail(user.email);
    if (persistedEmail && persistedEmail !== claimEmail) {
      await ddb.send(
        new UpdateCommand({
          TableName: USER_TABLE,
          Key: { id: userId },
          ConditionExpression: "organizationId = :org",
          UpdateExpression: "SET email = :email",
          ExpressionAttributeValues: {
            ":org": normalizeOrgId(user.organizationId),
            ":email": claimEmail,
          },
        }),
      );
      user.email = claimEmail;
    }
  }
  if (user.accessSuspended) {
    throw new Error("Access suspended");
  }

  const role = normalizeRole(user.role);
  const organizationId = normalizeOrgId(user.organizationId);

  // Load org to compute the two-layer module access:
  //   plan → available pool → org owner's enabled subset → user's personal subset
  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: organizationId } }),
  );
  const org = orgRes.Item;
  const orgAvailable = getAvailableModulesForPlan(String(org?.plan ?? ""));
  const orgEnabledModules = normalizeModuleSubset(org?.enabledModules, orgAvailable);
  const allowedModules = normalizeModuleSubset(user.allowedModules, orgEnabledModules);

  let columnVisibilityOverrides: Record<string, boolean> = {};
  if (user.columnVisibility) {
    try {
      const parsed = JSON.parse(user.columnVisibility);
      const orgOverrides = parsed?.[organizationId];
      if (orgOverrides && typeof orgOverrides === "object") {
        columnVisibilityOverrides = orgOverrides;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    userId,
    email: claimEmail,
    displayName: String(user.displayName ?? "").trim(),
    organizationId,
    role,
    orgEnabledModules,
    allowedModules,
    canEditInventory: EDIT_ROLES.has(role),
    canManageColumns: COLUMN_ADMIN_ROLES.has(role),
    columnVisibilityOverrides,
  };
};
