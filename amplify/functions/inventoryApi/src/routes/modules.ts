// ── Route handlers: modules ─────────────────────────────────────────────────
import { GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  AdminDisableUserCommand,
  AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { RouteContext, ModuleKey, UserRecord } from "../types";
import { USER_TABLE, ORG_TABLE, USER_POOL_ID, OWNER_ROLES, COLUMN_ADMIN_ROLES, getAvailableModulesForPlan } from "../config";
import { ddb, cognito } from "../clients";
import { json } from "../http";
import { normalizeRole, normalizeOrgId, normalizeEmail, normalizeModuleKey, normalizeModuleSubset } from "../normalize";

/** GET /inventory/org-modules — returns org's plan, available modules, and owner-enabled modules */
export const handleGetOrgModules = async (ctx: RouteContext) => {
  const { access } = ctx;
  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: access.organizationId } }),
  );
  const org = orgRes.Item;
  if (!org) return json(404, { error: "Organization not found" });

  const plan = String(org.plan ?? "");
  const orgAvailableModules = getAvailableModulesForPlan(plan);
  const orgEnabledModules = normalizeModuleSubset(org.enabledModules, orgAvailableModules);

  return json(200, { plan, orgAvailableModules, orgEnabledModules });
};

/** POST /inventory/org-modules — owner activates/deactivates modules from the plan pool */
export const handleUpdateOrgModules = async (ctx: RouteContext) => {
  const { access, body } = ctx;
  if (!OWNER_ROLES.has(access.role)) {
    return json(403, { error: "Only organization owners can manage module activation." });
  }

  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: access.organizationId } }),
  );
  const org = orgRes.Item;
  if (!org) return json(404, { error: "Organization not found" });

  const plan = String(org.plan ?? "");
  const orgAvailableModules = getAvailableModulesForPlan(plan);

  // Validate that requested modules are a subset of the plan's available pool
  const requested = normalizeModuleSubset(body?.enabledModules, orgAvailableModules);
  const safeEnabled = requested.filter((key) => orgAvailableModules.includes(key));
  if (safeEnabled.length === 0) {
    return json(400, { error: "At least one module must remain enabled." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: ORG_TABLE,
      Key: { id: access.organizationId },
      UpdateExpression: "SET enabledModules = :modules",
      ExpressionAttributeValues: { ":modules": safeEnabled },
    }),
  );

  return json(200, { ok: true, orgEnabledModules: safeEnabled });
};

export const handleListModuleAccessUsers = async (ctx: RouteContext) => {
  const { access } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage module access" });
  }

  const users: Array<{
    userId: string;
    email: string;
    displayName: string;
    role: string;
    allowedModules: ModuleKey[];
  }> = [];

  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: USER_TABLE,
        FilterExpression: "organizationId = :org",
        ExpressionAttributeValues: {
          ":org": access.organizationId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const user = item as UserRecord;
      users.push({
        userId: String(user.id ?? ""),
        email: normalizeEmail(user.email),
        displayName: String(user.displayName ?? ""),
        role: normalizeRole(user.role),
        allowedModules: normalizeModuleSubset(user.allowedModules, access.orgEnabledModules),
      });
    }
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  users.sort((a, b) => {
    const aName = a.displayName.trim() || a.email || a.userId;
    const bName = b.displayName.trim() || b.email || b.userId;
    return aName.localeCompare(bName);
  });

  return json(200, {
    modules: access.orgEnabledModules,
    users,
  });
};

export const handleUpdateUserModuleAccess = async (ctx: RouteContext) => {
  const { access, path, body } = ctx;
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage module access" });
  }

  const match = path.match(/\/inventory\/module-access\/users\/([^/]+)$/);
  const targetUserId = String(match?.[1] ?? "").trim();
  if (!targetUserId) {
    return json(400, { error: "User id is required" });
  }

  const rawModules: ModuleKey[] | null = Array.isArray(body?.allowedModules)
    ? (Array.from(
        new Set(
          body.allowedModules
            .map((item: unknown) => normalizeModuleKey(item))
            .filter((item: ModuleKey | null): item is ModuleKey => !!item),
        ),
      ) as ModuleKey[])
    : null;
  if (!rawModules) {
    return json(400, { error: "allowedModules must be an array." });
  }
  // Clamp to org-enabled modules — admins cannot grant modules the org hasn't activated
  const requestedAllowedModules = rawModules.filter((key) =>
    access.orgEnabledModules.includes(key),
  );
  if (requestedAllowedModules.length === 0) {
    return json(400, { error: "At least one org-enabled module must be included." });
  }
  if (targetUserId === access.userId) {
    return json(400, { error: "You cannot change your own module access." });
  }

  const targetRes = await ddb.send(
    new GetCommand({
      TableName: USER_TABLE,
      Key: { id: targetUserId },
    }),
  );
  const targetUser = targetRes.Item as UserRecord | undefined;
  if (!targetUser || normalizeOrgId(targetUser.organizationId) !== normalizeOrgId(access.organizationId)) {
    return json(404, { error: "User not found" });
  }
  if (access.email && normalizeEmail(targetUser.email) === access.email) {
    return json(400, { error: "You cannot change your own module access." });
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { id: targetUserId },
        ConditionExpression: "organizationId = :org",
        UpdateExpression: "SET allowedModules = :allowedModules",
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":allowedModules": requestedAllowedModules,
        },
      }),
    );
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return json(404, { error: "User not found or not in organization" });
    }
    throw err;
  }

  return json(200, {
    ok: true,
    userId: targetUserId,
    allowedModules: requestedAllowedModules,
  });
};

export const handleRevokeUserAccess = async (ctx: RouteContext) => {
  const { access, path } = ctx;
  if (!COLUMN_ADMIN_ROLES.has(access.role)) {
    return json(403, { error: "Only admins can revoke user access" });
  }

  const match = path.match(/\/inventory\/module-access\/users\/([^/]+)$/);
  const targetUserId = String(match?.[1] ?? "").trim();
  if (!targetUserId) {
    return json(400, { error: "User id is required" });
  }
  if (targetUserId === access.userId) {
    return json(400, { error: "You cannot revoke your own access." });
  }

  const targetRes = await ddb.send(
    new GetCommand({ TableName: USER_TABLE, Key: { id: targetUserId } }),
  );
  const targetUser = targetRes.Item as UserRecord | undefined;
  if (!targetUser || normalizeOrgId(targetUser.organizationId) !== access.organizationId) {
    return json(404, { error: "User not found" });
  }
  if (OWNER_ROLES.has(normalizeRole(targetUser.role))) {
    return json(400, { error: "Organization owners cannot be removed." });
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { id: targetUserId },
        ConditionExpression: "organizationId = :org",
        UpdateExpression: "SET accessSuspended = :suspended",
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":suspended": true,
        },
      }),
    );
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return json(404, { error: "User not found or not in organization" });
    }
    throw err;
  }

  // Disable Cognito account (prevents new logins) and invalidate existing sessions
  if (USER_POOL_ID) {
    try {
      await cognito.send(new AdminDisableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: targetUserId,
      }));
    } catch (err: any) {
      console.error("Failed to disable Cognito user:", targetUserId, err?.message);
    }
    try {
      await cognito.send(new AdminUserGlobalSignOutCommand({
        UserPoolId: USER_POOL_ID,
        Username: targetUserId,
      }));
    } catch (err: any) {
      console.error("Failed to global sign out Cognito user:", targetUserId, err?.message);
    }
  }

  // Count remaining active (non-suspended) users for the updated seat tally
  let seatsUsed = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: USER_TABLE,
        FilterExpression:
          "organizationId = :org AND (attribute_not_exists(accessSuspended) OR accessSuspended = :false)",
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":false": false,
        },
        ExclusiveStartKey: lastKey,
        Select: "COUNT",
      }),
    );
    seatsUsed += page.Count ?? 0;
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  // Write the accurate count back to the org table so userSubscriptionCheck stays in sync
  await ddb.send(
    new UpdateCommand({
      TableName: ORG_TABLE,
      Key: { id: access.organizationId },
      UpdateExpression: "SET seatsUsed = :seatsUsed",
      ExpressionAttributeValues: { ":seatsUsed": seatsUsed },
    }),
  );

  return json(200, { ok: true, seatsUsed });
};
