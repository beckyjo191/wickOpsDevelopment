// ── Route handlers: platform support access ─────────────────────────────────
// Owner-facing CRUD for the time-boxed WickOps support-access consent window.
// The org OWNER grants a read-only window so WickOps staff can troubleshoot;
// the grant row (see supportAccessGrant) is the consent + audit artifact, and
// access.ts enforces it on the support operator's cross-org reads.

import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { SUPPORT_GRANT_TABLE, ORG_TABLE, OWNER_ROLES } from "../config";
import { ddb } from "../clients";
import { json } from "../http";
import { buildAuditEvent, writeAuditEvents } from "../audit";

/** Allowed grant durations (hours). Keeps windows short and bounded. */
const ALLOWED_DURATION_HOURS = [4, 24, 48, 72] as const;
const DEFAULT_DURATION_HOURS = 48;
const SUPPORT_SCOPE = ["inventory:read"];

type GrantStatus = {
  active: boolean;
  expiresAt: string | null;
  grantedAt: string | null;
  grantedByEmail: string | null;
  lastAccessedAt: string | null;
  scope: string[];
};

const readGrant = async (orgId: string): Promise<Record<string, unknown> | undefined> => {
  if (!SUPPORT_GRANT_TABLE) return undefined;
  const res = await ddb.send(
    new GetCommand({ TableName: SUPPORT_GRANT_TABLE, Key: { id: orgId } }),
  );
  return res.Item;
};

/** Collapse a stored grant row into the live/expired status the UI renders. */
const toStatus = (grant: Record<string, unknown> | undefined): GrantStatus => {
  const expiresAt = grant?.expiresAt ? String(grant.expiresAt) : null;
  const active =
    !!grant &&
    String(grant.status ?? "") === "active" &&
    !!expiresAt &&
    Date.parse(expiresAt) > Date.now();
  return {
    active,
    expiresAt: active ? expiresAt : null,
    grantedAt: active && grant?.grantedAt ? String(grant.grantedAt) : null,
    grantedByEmail: active && grant?.grantedByEmail ? String(grant.grantedByEmail) : null,
    lastAccessedAt: active && grant?.lastAccessedAt ? String(grant.lastAccessedAt) : null,
    scope: Array.isArray(grant?.scope) ? (grant!.scope as string[]) : SUPPORT_SCOPE,
  };
};

/** Scan every row of a table, following pagination. Small tables only
 *  (orgs + grants are one row per org). */
const scanAll = async (tableName: string): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }),
    );
    for (const item of res.Items ?? []) out.push(item as Record<string, unknown>);
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return out;
};

/** GET /inventory/support/orgs — operator-only directory of every org with its
 *  live support-grant status, so the console offers a searchable picker instead
 *  of forcing operators to hunt org ids. Reading an org's data still requires a
 *  live grant; this only lists names + which orgs have granted access. */
export const handleListSupportOrgs = async (ctx: RouteContext) => {
  const { access } = ctx;
  if (!access.platformSupportGroupMember) {
    return json(403, { error: "Not authorized." });
  }
  if (!ORG_TABLE) return json(200, { orgs: [] });

  const [orgs, grants] = await Promise.all([
    scanAll(ORG_TABLE),
    SUPPORT_GRANT_TABLE ? scanAll(SUPPORT_GRANT_TABLE) : Promise.resolve([]),
  ]);

  const grantByOrg = new Map<string, GrantStatus>();
  for (const g of grants) {
    grantByOrg.set(String(g.id ?? g.organizationId ?? ""), toStatus(g));
  }

  const rows = orgs
    .map((org) => {
      const id = String(org.id ?? "");
      const status = grantByOrg.get(id);
      return {
        organizationId: id,
        name: String(org.name ?? ""),
        plan: String(org.plan ?? ""),
        grantActive: status?.active ?? false,
        grantExpiresAt: status?.expiresAt ?? null,
      };
    })
    .filter((r) => r.organizationId)
    // Orgs with an active grant float to the top, then alphabetical by name.
    .sort((a, b) => {
      if (a.grantActive !== b.grantActive) return a.grantActive ? -1 : 1;
      return (a.name || a.organizationId).localeCompare(b.name || b.organizationId);
    });

  return json(200, { orgs: rows });
};

/** GET /inventory/support-access — current grant status for the caller's org. */
export const handleGetSupportAccess = async (ctx: RouteContext) => {
  const { access } = ctx;
  if (!SUPPORT_GRANT_TABLE) {
    return json(200, { active: false, expiresAt: null, scope: SUPPORT_SCOPE });
  }
  const grant = await readGrant(access.organizationId);
  return json(200, toStatus(grant));
};

/** POST /inventory/support-access — owner opens a time-boxed support window. */
export const handleGrantSupportAccess = async (ctx: RouteContext) => {
  const { access, body, storage } = ctx;
  if (!OWNER_ROLES.has(access.role)) {
    return json(403, { error: "Only the organization owner can grant support access." });
  }
  if (!SUPPORT_GRANT_TABLE) {
    return json(503, { error: "Support access is not configured." });
  }

  const requested = Number(body?.durationHours ?? DEFAULT_DURATION_HOURS);
  const durationHours = (ALLOWED_DURATION_HOURS as readonly number[]).includes(requested)
    ? requested
    : DEFAULT_DURATION_HOURS;

  const now = new Date();
  const grantedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000).toISOString();

  await ddb.send(
    new PutCommand({
      TableName: SUPPORT_GRANT_TABLE,
      Item: {
        id: access.organizationId,
        organizationId: access.organizationId,
        status: "active",
        scope: SUPPORT_SCOPE,
        grantedByUserId: access.userId,
        grantedByEmail: access.email,
        grantedAt,
        expiresAt,
        lastAccessedAt: null,
        revokedAt: null,
        revokedByUserId: null,
      },
    }),
  );

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "SUPPORT_ACCESS_GRANTED", null, null, {
      expiresAt,
      durationHours,
      scope: SUPPORT_SCOPE,
    }),
  ]);

  return json(200, { active: true, expiresAt, grantedAt, scope: SUPPORT_SCOPE });
};

/** DELETE /inventory/support-access — owner closes the window early. */
export const handleRevokeSupportAccess = async (ctx: RouteContext) => {
  const { access, storage } = ctx;
  if (!OWNER_ROLES.has(access.role)) {
    return json(403, { error: "Only the organization owner can revoke support access." });
  }
  if (!SUPPORT_GRANT_TABLE) {
    return json(200, { active: false, expiresAt: null });
  }

  const grant = await readGrant(access.organizationId);
  const wasActive = toStatus(grant).active;

  if (grant) {
    await ddb.send(
      new UpdateCommand({
        TableName: SUPPORT_GRANT_TABLE,
        Key: { id: access.organizationId },
        UpdateExpression: "SET #s = :revoked, revokedAt = :now, revokedByUserId = :uid",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":revoked": "revoked",
          ":now": new Date().toISOString(),
          ":uid": access.userId,
        },
      }),
    );
  }

  if (wasActive) {
    await writeAuditEvents(storage.auditTable, [
      buildAuditEvent(access, "SUPPORT_ACCESS_REVOKED", null, null, {
        reason: "owner_revoked",
      }),
    ]);
  }

  return json(200, { active: false, expiresAt: null });
};
