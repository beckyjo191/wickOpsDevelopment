// ── Shared: access.ts ───────────────────────────────────────────────────────
// Authentication / authorization context builder.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";
import {
  USER_TABLE,
  ORG_TABLE,
  SUPPORT_GRANT_TABLE,
  PLATFORM_SUPPORT_GROUP,
  PLATFORM_SUPPORT_ROLE,
  SUPPORT_ORG_HEADER,
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

/** Parse the Cognito `cognito:groups` claim, which arrives either as a real
 *  array or as a bracketed string like "[PLATFORM_SUPPORT Admins]" depending on
 *  the authorizer. Returns a clean list of group names. */
const parseCognitoGroups = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .map((g) => g.trim())
    .filter(Boolean);
};

/** Read the case-insensitive support-org header off the Lambda event. API
 *  Gateway HTTP API lowercases header keys, but be defensive. */
const readSupportOrgHeader = (event: any): string => {
  const headers = event?.headers ?? {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === SUPPORT_ORG_HEADER) {
      return normalizeOrgId(headers[key]);
    }
  }
  return "";
};

/** Compute the read-only module access a support operator gets for a target
 *  org: everything the org has enabled (so every inventory route resolves),
 *  but no edit/column rights. Bumps the grant's lastAccessedAt for the owner's
 *  transparency view. Returns null if there is no live grant — caller 403s. */
const buildSupportContext = async (
  operator: { userId: string; email: string; displayName: string },
  targetOrgId: string,
): Promise<AccessContext | null> => {
  if (!SUPPORT_GRANT_TABLE) return null;

  const grantRes = await ddb.send(
    new GetCommand({ TableName: SUPPORT_GRANT_TABLE, Key: { id: targetOrgId } }),
  );
  const grant = grantRes.Item;
  const expiresAt = String(grant?.expiresAt ?? "");
  const isLive =
    grant &&
    String(grant.status ?? "") === "active" &&
    !!expiresAt &&
    Date.parse(expiresAt) > Date.now();
  if (!isLive) return null;

  // Record the access for the customer's "support last viewed" indicator.
  // Best-effort: a failed bump must not block legitimate troubleshooting.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SUPPORT_GRANT_TABLE,
        Key: { id: targetOrgId },
        UpdateExpression: "SET lastAccessedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }),
    );
  } catch {
    // ignore — transparency metadata only
  }

  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: targetOrgId } }),
  );
  const org = orgRes.Item;
  const orgAvailable = getAvailableModulesForPlan(String(org?.plan ?? ""));
  const orgEnabledModules = normalizeModuleSubset(org?.enabledModules, orgAvailable);

  return {
    userId: operator.userId,
    email: operator.email,
    displayName: operator.displayName,
    organizationId: targetOrgId,
    role: PLATFORM_SUPPORT_ROLE,
    orgEnabledModules,
    // Support sees whatever the org has enabled, read-only.
    allowedModules: orgEnabledModules,
    canEditInventory: false,
    canManageColumns: false,
    columnVisibilityOverrides: {},
    isPlatformSupport: true,
    platformSupportGroupMember: true,
    supportGrantExpiresAt: expiresAt,
  };
};

/** Context for a dedicated support operator who is NOT impersonating any org
 *  (no support header) and has no org membership of their own. Has no inventory
 *  scope — only operator-only meta endpoints (the org picker) resolve. Flagged
 *  read-only so the router blocks any mutation. */
const buildBareOperatorContext = (operator: {
  userId: string;
  email: string;
  displayName: string;
}): AccessContext => ({
  userId: operator.userId,
  email: operator.email,
  displayName: operator.displayName,
  organizationId: "",
  role: PLATFORM_SUPPORT_ROLE,
  orgEnabledModules: [],
  allowedModules: [],
  canEditInventory: false,
  canManageColumns: false,
  columnVisibilityOverrides: {},
  isPlatformSupport: true,
  platformSupportGroupMember: true,
});

export const getAccessContext = async (event: any): Promise<AccessContext> => {
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ??
    event.requestContext?.authorizer?.claims;

  const userId = String(claims?.sub ?? "").trim();
  if (!userId) throw new Error("Unauthorized");
  const claimEmail = claims?.email ? normalizeEmail(claims.email) : "";

  // ── Platform-support operator routing (takes precedence) ──────────────────
  // A PLATFORM_SUPPORT member is ALWAYS a support operator — never a regular
  // tenant — even if an org row happens to exist for them (e.g. the support
  // account once self-signed-up). Resolve this before the normal user lookup so
  // any own-org is ignored: impersonate the target org when the header names one
  // and a live grant exists, otherwise the bare operator context (picker only).
  const isPlatformSupportGroupMember =
    parseCognitoGroups(claims?.["cognito:groups"]).includes(PLATFORM_SUPPORT_GROUP);
  const supportOrgId = readSupportOrgHeader(event);
  if (isPlatformSupportGroupMember) {
    const operator = { userId, email: claimEmail, displayName: claimEmail || "WickOps Support" };
    if (supportOrgId) {
      const supportContext = await buildSupportContext(operator, supportOrgId);
      if (!supportContext) throw new Error("Support access not granted");
      return supportContext;
    }
    return buildBareOperatorContext(operator);
  }

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
    platformSupportGroupMember: isPlatformSupportGroupMember,
  };
};
