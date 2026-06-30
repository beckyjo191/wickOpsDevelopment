import {
  BillingMode,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
  UpdateContinuousBackupsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

const rawDdb = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(rawDdb);

const DEPLOYMENT_ENV = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();
const CORS_ALLOW_ORIGIN =
  DEPLOYMENT_ENV === "prod" || DEPLOYMENT_ENV === "production"
    ? "https://systems.wickops.com"
    : "http://localhost:5173";
const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  Vary: "Origin",
};
const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...corsHeaders },
  body: JSON.stringify(body),
});

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const INVITE_TABLE = process.env.INVITE_TABLE!;
const INVENTORY_ORG_TABLE_PREFIX =
  String(process.env.INVENTORY_ORG_TABLE_PREFIX ?? "wickops-inventory").trim() ||
  "wickops-inventory";
const INVENTORY_STORAGE_NAMESPACE = createHash("sha256")
  .update(`${USER_TABLE}|${INVENTORY_ORG_TABLE_PREFIX}`)
  .digest("hex")
  .slice(0, 8);
const INVENTORY_COLUMN_BY_MODULE_INDEX = "ByModuleSortOrder";
const INVENTORY_ITEM_BY_MODULE_INDEX = "ByModulePosition";
const PROVISIONING_RETRY_AFTER_MS = 2000;
const INVITE_ALLOWED_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);

// ── Platform support (see inventoryApi: supportAccessGrant) ──────────────────
const SUPPORT_GRANT_TABLE = process.env.SUPPORT_GRANT_TABLE ?? "";
const PLATFORM_SUPPORT_GROUP = "PLATFORM_SUPPORT";
const PLATFORM_SUPPORT_ROLE = "PLATFORM_SUPPORT";
const SUPPORT_ORG_HEADER = "x-wickops-support-org";

/** Parse cognito:groups (array or bracketed string) into clean group names. */
const parseCognitoGroups = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s.replace(/^\[|\]$/g, "").split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
};

/** Read the (case-insensitive) target-org support header off the event. */
const readSupportOrgHeader = (event: any): string => {
  const headers = event?.headers ?? {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === SUPPORT_ORG_HEADER) return String(headers[key] ?? "").trim();
  }
  return "";
};

/** Return the grant's ISO expiry if the org has a live support grant, else null. */
const readLiveSupportGrant = async (orgId: string): Promise<string | null> => {
  if (!SUPPORT_GRANT_TABLE || !orgId) return null;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: SUPPORT_GRANT_TABLE, Key: { id: orgId } }),
    );
    const grant = res.Item;
    const expiresAt = String(grant?.expiresAt ?? "");
    const live =
      grant && String(grant.status ?? "") === "active" && !!expiresAt && Date.parse(expiresAt) > Date.now();
    return live ? expiresAt : null;
  } catch (err) {
    console.warn("readLiveSupportGrant failed", err);
    return null;
  }
};

/** Subscription-shaped response for a support operator who is NOT impersonating
 *  (no org of their own). Subscribed so the app shell loads, but org-less and
 *  module-less — the frontend renders the operator landing + org picker. */
const buildOperatorShellResponse = (extra: Record<string, unknown> = {}) =>
  json(200, {
    displayName: "WickOps Support",
    organizationId: "",
    orgName: "WickOps Support",
    subscribed: true,
    accessSuspended: false,
    plan: "",
    seatLimit: 0,
    seatsUsed: 0,
    paymentStatus: "Free",
    role: PLATFORM_SUPPORT_ROLE,
    canInviteUsers: false,
    orgAvailableModules: [],
    orgEnabledModules: [],
    allowedModules: [],
    onboardingCompleted: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    platformSupport: true,
    supportOperator: true,
    ...extra,
  });
// ── MODULE SYNC NOTE ────────────────────────────────────────────────────────
// This list must be kept in sync with AppModuleKey in src/lib/moduleRegistry.ts.
// When a new module goes stable:
//   1. Add its key to ALL_MODULE_KEYS here (and in inventoryApi/config.ts)
//   2. Add it to PLAN_MODULE_MAP for each plan that should unlock it (both handlers)
//   3. Follow remaining steps documented in src/lib/moduleRegistry.ts
// ────────────────────────────────────────────────────────────────────────────
const ALL_MODULE_KEYS = ["inventory"] as const;
type ModuleKey = (typeof ALL_MODULE_KEYS)[number];

// Legacy keys folded into a current module. Stored records may still contain
// these; remap on read so permissions survive the consolidation.
const LEGACY_MODULE_ALIASES: Record<string, ModuleKey> = {
  usage: "inventory",
};

// Plan → module mapping. Unrecognized plan = no modules (no fallback to all).
const PLAN_MODULE_MAP: Record<string, ModuleKey[]> = {
  Personal:     ["inventory"],
  Department:   ["inventory"],
  Organization: ["inventory"],
  Sponsored:    ["inventory"],
};
const getAvailableModulesForPlan = (plan: string): ModuleKey[] =>
  PLAN_MODULE_MAP[plan] ?? [];

const coerceModuleKey = (raw: unknown, valid: Set<ModuleKey>): ModuleKey | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (valid.has(normalized as ModuleKey)) return normalized as ModuleKey;
  const aliased = LEGACY_MODULE_ALIASES[normalized];
  return aliased && valid.has(aliased) ? aliased : null;
};

// Normalize a raw DDB value into a valid subset of allValid.
// null/absent → allValid (backward-compat: existing orgs without enabledModules get full access).
const normalizeModuleSubset = (value: unknown, allValid: ModuleKey[]): ModuleKey[] => {
  if (!Array.isArray(value)) return [...allValid];
  const s = new Set(allValid);
  const out = new Set<ModuleKey>();
  for (const raw of value) {
    const key = coerceModuleKey(raw, s);
    if (key) out.add(key);
  }
  return out.size > 0 ? [...out] : [...allValid];
};

// Intersect user's stored allowedModules against the org-enabled superset.
const getUserAllowedModules = (value: unknown, superset: ModuleKey[]): ModuleKey[] => {
  if (!Array.isArray(value)) return [...superset];
  const s = new Set(superset);
  const out = new Set<ModuleKey>();
  for (const raw of value) {
    const key = coerceModuleKey(raw, s);
    if (key) out.add(key);
  }
  return out.size > 0 ? [...out] : [...superset];
};
const normalizeEmail = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase();
const isPaidStatus = (value: unknown): boolean => {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "active" || normalized === "paid" || normalized === "sponsored";
};

const countOrgUsers = async (organizationId: string): Promise<number> => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: USER_TABLE,
        Select: "COUNT",
        FilterExpression: "organizationId = :orgId",
        ExpressionAttributeValues: {
          ":orgId": organizationId,
        },
      })
    );
    return result.Count ?? 0;
  } catch (err) {
    console.warn("countOrgUsers failed, defaulting to 0", err);
    return 0;
  }
};

const countPendingInvites = async (organizationId: string): Promise<number> => {
  if (!INVITE_TABLE) {
    return 0;
  }

  try {
  // Count only non-expired pending invites
  const result = await ddb.send(
    new ScanCommand({
      TableName: INVITE_TABLE,
      FilterExpression:
        "organizationId = :orgId AND #status = :pending AND (attribute_not_exists(expiresAt) OR expiresAt > :now)",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":orgId": organizationId,
        ":pending": "PENDING",
        ":now": new Date().toISOString(),
      },
      ProjectionExpression: "id",
    })
  );
  return result.Items?.length ?? 0;
  } catch (err) {
    console.warn("countPendingInvites failed, defaulting to 0", err);
    return 0;
  }
};

const normalizeRole = (value: unknown): string => String(value ?? "").trim().toUpperCase();
const normalizeOrgId = (value: unknown): string => String(value ?? "").trim().toLowerCase();
const incrementOrgSeatsUsed = async (organizationId: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName: ORG_TABLE,
      Key: { id: organizationId },
      UpdateExpression: "SET seatsUsed = if_not_exists(seatsUsed, :zero) + :inc",
      ExpressionAttributeValues: {
        ":zero": 0,
        ":inc": 1,
      },
    })
  );
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const sanitizeOrgIdForTableName = (organizationId: string): string =>
  organizationId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "org";

const buildOrgScopedTableName = (organizationId: string, suffix: "columns" | "items"): string => {
  const safeOrg = sanitizeOrgIdForTableName(organizationId);
  const hash = createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
  return `${INVENTORY_ORG_TABLE_PREFIX}-${INVENTORY_STORAGE_NAMESPACE}-${safeOrg}-${hash}-${suffix}`;
};

const describeTable = async (tableName: string) => {
  try {
    return await rawDdb.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") return null;
    throw err;
  }
};

const waitForTableActive = async (tableName: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const described = await describeTable(tableName);
    if (described?.Table?.TableStatus === "ACTIVE") return;
    await sleep(750);
  }
  throw new Error(`Timed out waiting for table to become ACTIVE: ${tableName}`);
};

class InventoryStorageProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryStorageProvisioningError";
  }
}

const isResourceInUse = (err: any): boolean =>
  err?.name === "ResourceInUseException" ||
  String(err?.__type ?? "").includes("ResourceInUseException");

const enablePitr = async (tableName: string): Promise<void> => {
  try {
    await rawDdb.send(
      new UpdateContinuousBackupsCommand({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    );
  } catch {
    // best-effort — table is usable without PITR
  }
};

const createOrgTableIfMissing = async (
  tableName: string,
  gsiName: string,
  gsiSortKey: "sortOrder" | "position",
): Promise<void> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      try {
        await waitForTableActive(tableName);
      } catch {
        throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
      }
    }
    await enablePitr(tableName);
    return;
  }

  try {
    await rawDdb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: ScalarAttributeType.S },
          { AttributeName: "module", AttributeType: ScalarAttributeType.S },
          { AttributeName: gsiSortKey, AttributeType: ScalarAttributeType.N },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
        GlobalSecondaryIndexes: [
          {
            IndexName: gsiName,
            KeySchema: [
              { AttributeName: "module", KeyType: KeyType.HASH },
              { AttributeName: gsiSortKey, KeyType: KeyType.RANGE },
            ],
            Projection: { ProjectionType: ProjectionType.ALL },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (!isResourceInUse(err)) throw err;
  }

  try {
    await waitForTableActive(tableName);
    await enablePitr(tableName);
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

const ensureInventoryTablesForOrganization = async (organizationId: string): Promise<void> => {
  await Promise.all([
    createOrgTableIfMissing(
      buildOrgScopedTableName(organizationId, "columns"),
      INVENTORY_COLUMN_BY_MODULE_INDEX,
      "sortOrder",
    ),
    createOrgTableIfMissing(
      buildOrgScopedTableName(organizationId, "items"),
      INVENTORY_ITEM_BY_MODULE_INDEX,
      "position",
    ),
  ]);
};

type InviteRecord = {
  id?: string;
  email?: string;
  displayName?: string;
  status?: string;
  organizationId?: string;
  acceptedUserId?: string;
};

const findInviteByNormalizedEmail = async (
  normalizedEmail: string
): Promise<{ invite: InviteRecord | undefined; inviteId: string | undefined }> => {
  const inviteByIdRes = await ddb.send(
    new GetCommand({
      TableName: INVITE_TABLE,
      Key: { id: normalizedEmail },
    })
  );
  const inviteById = inviteByIdRes.Item as InviteRecord | undefined;
  if (inviteById) {
    return { invite: inviteById, inviteId: normalizedEmail };
  }

  // Legacy fallback: some older rows may not use normalized email as id.
  const scanRes = await ddb.send(
    new ScanCommand({
      TableName: INVITE_TABLE,
      ProjectionExpression: "id, email, organizationId, #status",
      ExpressionAttributeNames: { "#status": "status" },
      FilterExpression: "#status = :pending",
      ExpressionAttributeValues: { ":pending": "PENDING" },
    })
  );
  const items = (scanRes.Items ?? []) as InviteRecord[];
  const match = items.find((item) => {
    const itemId = normalizeEmail(item.id);
    const itemEmail = normalizeEmail(item.email);
    return itemId === normalizedEmail || itemEmail === normalizedEmail;
  });
  if (!match) {
    return { invite: undefined, inviteId: undefined };
  }
  return { invite: match, inviteId: match.id };
};

const reconcileInviteAcceptance = async (
  userId: string,
  email: string | undefined,
  organizationId: string | undefined
): Promise<boolean> => {
  if (!email || !organizationId) return false;

  try {
    const matchingInviteIds = new Set<string>();

    const { invite, inviteId } = await findInviteByNormalizedEmail(email);
    const directMatchOrg =
      normalizeOrgId(invite?.organizationId) === normalizeOrgId(organizationId);
    if (invite?.status === "PENDING" && directMatchOrg && inviteId) {
      matchingInviteIds.add(inviteId);
    }

    // Full paginated fallback to catch legacy rows not discoverable by Key lookup.
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: INVITE_TABLE,
          ProjectionExpression: "id, email, organizationId, #status, acceptedUserId",
          ExpressionAttributeNames: { "#status": "status" },
          FilterExpression: "#status = :pending",
          ExpressionAttributeValues: { ":pending": "PENDING" },
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      const items = (page.Items ?? []) as InviteRecord[];
      for (const item of items) {
        if (!item.id) continue;
        const matchesEmail =
          normalizeEmail(item.id) === email || normalizeEmail(item.email) === email;
        const matchesOrg =
          normalizeOrgId(item.organizationId) === normalizeOrgId(organizationId);
        if (matchesEmail && matchesOrg) {
          matchingInviteIds.add(item.id);
        }
      }

      lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    if (matchingInviteIds.size === 0) {
      return false;
    }

    let updatedAny = false;
    for (const pendingInviteId of matchingInviteIds) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: INVITE_TABLE,
            Key: { id: pendingInviteId },
            ConditionExpression:
              "#status = :pending AND (attribute_not_exists(acceptedUserId) OR acceptedUserId = :uid)",
            UpdateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt, acceptedUserId = :uid",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pending": "PENDING",
              ":accepted": "ACCEPTED",
              ":acceptedAt": new Date().toISOString(),
              ":uid": userId,
            },
          })
        );
        updatedAny = true;
      } catch (updateErr: any) {
        if (updateErr?.name !== "ConditionalCheckFailedException") {
          throw updateErr;
        }
      }
    }

    return updatedAny;
  } catch (err) {
    if ((err as any)?.name === "ConditionalCheckFailedException") {
      return false;
    }
    console.warn("Failed to reconcile invite status", err);
    return false;
  }
};

export const handler = async (event: any) => {
  try {
const claims =
  event.requestContext?.authorizer?.jwt?.claims ??
  event.requestContext?.authorizer?.claims;

const userId = claims?.sub;
const email = claims?.email ? normalizeEmail(claims.email) : undefined;

    if (!userId) {
      return json(401, { error: "Unauthorized" });
    }

    // 0️⃣ Platform-support operator paths (before the normal user lookup, since a
    // dedicated support account has no org of its own).
    const isPlatformSupportGroupMember =
      parseCognitoGroups(claims?.["cognito:groups"]).includes(PLATFORM_SUPPORT_GROUP);
    const supportOrgId = readSupportOrgHeader(event);

    if (isPlatformSupportGroupMember && supportOrgId) {
      // Impersonating a customer org: load the whole shell as that org, read-only,
      // but only while a live consent grant exists.
      const grantExpiresAt = await readLiveSupportGrant(supportOrgId);
      if (!grantExpiresAt) {
        return buildOperatorShellResponse({ supportError: "no_grant", supportViewingOrgId: supportOrgId });
      }
      const targetRes = await ddb.send(
        new GetCommand({ TableName: ORG_TABLE, Key: { id: supportOrgId } }),
      );
      const targetOrg = targetRes.Item;
      if (!targetOrg) {
        return buildOperatorShellResponse({ supportError: "org_not_found", supportViewingOrgId: supportOrgId });
      }
      const targetPlan = String(targetOrg.plan ?? "");
      const targetAvailable = getAvailableModulesForPlan(targetPlan);
      const targetEnabled = normalizeModuleSubset(targetOrg.enabledModules, targetAvailable);
      try {
        await ensureInventoryTablesForOrganization(supportOrgId);
      } catch (err) {
        if (err instanceof InventoryStorageProvisioningError || isResourceInUse(err)) throw err;
        console.warn("support impersonation: ensure tables failed", err);
      }
      return json(200, {
        displayName: "WickOps Support",
        organizationId: supportOrgId,
        orgName: String(targetOrg.name ?? ""),
        subscribed: true,
        accessSuspended: false,
        plan: targetPlan,
        seatLimit: Number(targetOrg.seatLimit ?? 0),
        seatsUsed: Number(targetOrg.seatsUsed ?? 0),
        paymentStatus: String(targetOrg.paymentStatus ?? "Free"),
        role: PLATFORM_SUPPORT_ROLE,
        canInviteUsers: false,
        orgAvailableModules: targetAvailable,
        orgEnabledModules: targetEnabled,
        // Support reads whatever the org has enabled, read-only.
        allowedModules: targetEnabled,
        onboardingCompleted: true,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        platformSupport: true,
        supportViewingOrgId: supportOrgId,
        supportGrantExpiresAt: grantExpiresAt,
      });
    }

    // 1️⃣ Load user
    const userRes = await ddb.send(
      new GetCommand({
        TableName: USER_TABLE,
        Key: { id: userId },
      })
    );

    let user = userRes.Item;
    if (user && email) {
      const persistedEmail = normalizeEmail(user.email);
      if (persistedEmail && persistedEmail !== email) {
        await ddb.send(
          new UpdateCommand({
            TableName: USER_TABLE,
            Key: { id: userId },
            UpdateExpression: "SET email = :email",
            ExpressionAttributeValues: {
              ":email": email,
            },
          }),
        );
        user.email = email;
      }
    }

    if (!user) {
      // Dedicated support account (support@wickops): no org membership, not
      // currently impersonating → land on the operator shell + org picker.
      if (isPlatformSupportGroupMember) {
        return buildOperatorShellResponse();
      }
      if (!email) {
        return json(404, { error: "User not found" });
      }

      try {
        // First login for invited users: consume invite and create user profile.
        const { invite } = await findInviteByNormalizedEmail(email);
        const normalizedInvite = invite as
          | {
              organizationId?: string;
              role?: string;
              status?: string;
              displayName?: string;
            }
          | undefined;

        const inviteOrganizationId = normalizedInvite?.organizationId;
        const inviteStatusUsable =
          normalizedInvite?.status === "PENDING" || normalizedInvite?.status === "ACCEPTED";
        if (!inviteOrganizationId || !inviteStatusUsable) {
          return json(404, { error: "User not found" });
        }

        const orgResForInvite = await ddb.send(
          new GetCommand({
            TableName: ORG_TABLE,
            Key: { id: inviteOrganizationId },
          })
        );

        if (!orgResForInvite.Item) {
          return json(404, { error: "Organization not found" });
        }

        const role =
          normalizedInvite?.role === "ADMIN" ||
          normalizedInvite?.role === "EDITOR" ||
          normalizedInvite?.role === "VIEWER"
            ? normalizedInvite.role
            : "VIEWER";

        user = {
          id: userId,
          email,
          displayName: String(normalizedInvite?.displayName ?? "").trim() || email.split("@")[0],
          organizationId: inviteOrganizationId,
          role,
          allowedModules: ["inventory"],
          accessSuspended: !isPaidStatus(orgResForInvite.Item.paymentStatus),
          createdAt: new Date().toISOString(),
        };

        let acceptedNow = false;
        if (normalizedInvite?.status === "PENDING") {
          acceptedNow = await reconcileInviteAcceptance(userId, email, inviteOrganizationId);
        }

        await ddb.send(
          new PutCommand({
            TableName: USER_TABLE,
            Item: user,
            ConditionExpression: "attribute_not_exists(id)",
          })
        );

        if (acceptedNow) {
          await incrementOrgSeatsUsed(inviteOrganizationId);
        }
      } catch (inviteErr) {
        if ((inviteErr as any)?.name !== "ConditionalCheckFailedException") {
          console.warn("Invite lookup/consume failed", inviteErr);
        }
        if ((inviteErr as any)?.name === "ConditionalCheckFailedException") {
          const existingUserRes = await ddb.send(
            new GetCommand({
              TableName: USER_TABLE,
              Key: { id: userId },
            })
          );
          user = existingUserRes.Item;
          if (user) {
            // Continue normal flow with the existing user.
            const reconcileEmail =
              email ??
              (typeof user.email === "string" ? normalizeEmail(user.email) : undefined);
            await reconcileInviteAcceptance(userId, reconcileEmail, user.organizationId);
          } else {
            return json(404, { error: "User not found" });
          }
        } else {
          return json(404, { error: "User not found" });
        }
      }
    }

    if (!user.organizationId) {
      return json(500, { error: "User missing organizationId" });
    }

    const reconcileEmail =
      email ??
      (typeof user.email === "string" ? normalizeEmail(user.email) : undefined);
    const acceptedNow = await reconcileInviteAcceptance(
      userId,
      reconcileEmail,
      user.organizationId
    );
    if (acceptedNow) {
      await incrementOrgSeatsUsed(user.organizationId);
    }

    // 2️⃣ Load organization
    const orgRes = await ddb.send(
      new GetCommand({
        TableName: ORG_TABLE,
        Key: { id: user.organizationId },
      })
    );

    if (!orgRes.Item) {
      return json(404, { error: "Organization not found" });
    }

    const org = orgRes.Item;
    const computedSeatsUsed =
      (await countOrgUsers(user.organizationId)) +
      (await countPendingInvites(user.organizationId));
    const seatsUsed = computedSeatsUsed > 0
      ? computedSeatsUsed
      : Number(org.seatsUsed ?? 0);

    // Reconcile seatsUsed if it has drifted from the stored value
    const storedSeatsUsed = Number(org.seatsUsed ?? 0);
    if (computedSeatsUsed > 0 && computedSeatsUsed !== storedSeatsUsed) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: ORG_TABLE,
            Key: { id: user.organizationId },
            UpdateExpression: "SET seatsUsed = :seats",
            ExpressionAttributeValues: { ":seats": computedSeatsUsed },
          })
        );
      } catch (err) {
        console.warn("seatsUsed reconciliation failed", err);
      }
    }

    // Self-heal: if subscription was set to cancel at period end and the deadline
    // has passed (with grace) but the customer.subscription.deleted webhook never
    // fired, recover by marking the org Canceled here. Surfaces a webhook miss
    // in CloudWatch so we know to investigate.
    const SELF_HEAL_GRACE_SECONDS = 24 * 60 * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    let effectivePaymentStatus = String(org.paymentStatus ?? "");
    let effectiveCancelAtPeriodEnd = !!org.cancelAtPeriodEnd;
    let effectiveCurrentPeriodEnd = Number(org.currentPeriodEnd ?? 0) || undefined;

    const subscriptionExpiredViaCancel =
      isPaidStatus(effectivePaymentStatus) &&
      effectiveCancelAtPeriodEnd &&
      effectiveCurrentPeriodEnd !== undefined &&
      effectiveCurrentPeriodEnd + SELF_HEAL_GRACE_SECONDS < nowSec;

    if (subscriptionExpiredViaCancel) {
      console.warn(
        `[userSubscriptionCheck] Self-healing canceled subscription for org ${user.organizationId}: ` +
        `paymentStatus was "${effectivePaymentStatus}", currentPeriodEnd=${effectiveCurrentPeriodEnd} ` +
        `(grace=${SELF_HEAL_GRACE_SECONDS}s, now=${nowSec}). ` +
        `customer.subscription.deleted webhook likely missed — investigate Stripe webhook delivery.`
      );
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: ORG_TABLE,
            Key: { id: user.organizationId },
            UpdateExpression:
              "SET paymentStatus = :canceled REMOVE cancelAtPeriodEnd, currentPeriodEnd",
            ExpressionAttributeValues: { ":canceled": "Canceled" },
          })
        );
        // Suspend non-owner users to converge state with what the webhook would have done.
        const usersRes = await ddb.send(
          new ScanCommand({
            TableName: USER_TABLE,
            FilterExpression: "organizationId = :orgId",
            ExpressionAttributeValues: { ":orgId": user.organizationId },
          })
        );
        for (const u of usersRes.Items ?? []) {
          const uRole = String(u.role ?? "").toUpperCase();
          if (uRole === "OWNER" || uRole === "ACCOUNT_OWNER") continue;
          if (u.accessSuspended === true) continue;
          await ddb.send(
            new UpdateCommand({
              TableName: USER_TABLE,
              Key: { id: u.id },
              UpdateExpression: "SET accessSuspended = :true",
              ExpressionAttributeValues: { ":true": true },
            })
          );
        }
      } catch (selfHealErr) {
        console.warn("[userSubscriptionCheck] self-heal write failed", selfHealErr);
      }
      effectivePaymentStatus = "Canceled";
      effectiveCancelAtPeriodEnd = false;
      effectiveCurrentPeriodEnd = undefined;
    }

    const paymentStatus = effectivePaymentStatus.toLowerCase();
    const plan = String(org.plan ?? "");
    const subscribed = isPaidStatus(paymentStatus);
    const normalizedRole = normalizeRole(user.role);
    const canInviteUsers = INVITE_ALLOWED_ROLES.has(normalizedRole);

    // Three-layer module access: plan → org owner → user
    const orgAvailableModules = getAvailableModulesForPlan(plan);
    const orgEnabledModules = normalizeModuleSubset(org.enabledModules, orgAvailableModules);
    const allowedModules = getUserAllowedModules(user.allowedModules, orgEnabledModules);

    if (subscribed) {
      await ensureInventoryTablesForOrganization(String(user.organizationId));
    }

    // If org is paid/active, make sure this user is not stuck suspended.
    let accessSuspended = !!user.accessSuspended;
    if (subscribed && accessSuspended) {
      await ddb.send(
        new UpdateCommand({
          TableName: USER_TABLE,
          Key: { id: userId },
          UpdateExpression: "SET accessSuspended = :false",
          ExpressionAttributeValues: { ":false": false },
        })
      );
      accessSuspended = false;
    }

    // onboardingCompleted: absent on legacy/pre-feature orgs → treat as true.
    // Only show onboarding when explicitly set to false (new orgs set this in postConfirmation).
    const onboardingCompleted = org.onboardingCompleted !== false;

    return json(200, {
      displayName: String(user.displayName ?? ""),
      organizationId: user.organizationId,
      orgName: String(org.name ?? ""),
      subscribed,
      accessSuspended,
      plan,
      seatLimit: org.seatLimit ?? 1,
      seatsUsed,
      paymentStatus: effectivePaymentStatus || "Free",
      role: normalizedRole,
      canInviteUsers,
      orgAvailableModules,
      orgEnabledModules,
      allowedModules,
      onboardingCompleted,
      cancelAtPeriodEnd: effectiveCancelAtPeriodEnd,
      currentPeriodEnd: effectiveCurrentPeriodEnd ?? null,
    });
  } catch (err) {
    if (err instanceof InventoryStorageProvisioningError || isResourceInUse(err)) {
      return json(202, {
        error: "Inventory storage is still provisioning",
        code: "INVENTORY_STORAGE_PROVISIONING",
        retryAfterMs: PROVISIONING_RETRY_AFTER_MS,
      });
    }
    console.error("user-subscription error:", err);
    return json(500, { error: "Internal server error" });
  }
};
