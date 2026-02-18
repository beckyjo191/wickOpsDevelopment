import {
  BillingMode,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
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
const normalizeEmail = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase();
const isPaidStatus = (value: unknown): boolean => {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "active" || normalized === "paid";
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
  const result = await ddb.send(
    new ScanCommand({
      TableName: INVITE_TABLE,
      Select: "COUNT",
      FilterExpression: "organizationId = :orgId AND #status = :pending",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":orgId": organizationId,
        ":pending": "PENDING",
      },
    })
  );
  return result.Count ?? 0;
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
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
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
        console.error("Identity mismatch for user", { userId, claimEmail: email, persistedEmail });
        return {
          statusCode: 403,
          body: JSON.stringify({ error: "Identity mismatch" }),
        };
      }
    }

    if (!user) {
      if (!email) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "User not found" }),
        };
      }

      try {
        // First login for invited users: consume invite and create user profile.
        const { invite } = await findInviteByNormalizedEmail(email);
        const normalizedInvite = invite as
          | {
              organizationId?: string;
              role?: string;
              status?: string;
            }
          | undefined;

        const inviteOrganizationId = normalizedInvite?.organizationId;
        const inviteStatusUsable =
          normalizedInvite?.status === "PENDING" || normalizedInvite?.status === "ACCEPTED";
        if (!inviteOrganizationId || !inviteStatusUsable) {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: "User not found" }),
          };
        }

        const orgResForInvite = await ddb.send(
          new GetCommand({
            TableName: ORG_TABLE,
            Key: { id: inviteOrganizationId },
          })
        );

        if (!orgResForInvite.Item) {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: "Organization not found" }),
          };
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
          displayName: email.split("@")[0],
          organizationId: inviteOrganizationId,
          role,
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
            return {
              statusCode: 404,
              body: JSON.stringify({ error: "User not found" }),
            };
          }
        } else {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: "User not found" }),
          };
        }
      }
    }

    if (!user.organizationId) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "User missing organizationId",
        }),
      };
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
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Organization not found" }),
      };
    }

    const org = orgRes.Item;
    const computedSeatsUsed =
      (await countOrgUsers(user.organizationId)) +
      (await countPendingInvites(user.organizationId));
    const seatsUsed = computedSeatsUsed > 0
      ? computedSeatsUsed
      : Number(org.seatsUsed ?? 0);

    const paymentStatus = String(org.paymentStatus ?? "").toLowerCase();
    const plan = String(org.plan ?? "Free");
    const subscribed = isPaidStatus(paymentStatus);
    const normalizedRole = normalizeRole(user.role);
    const canInviteUsers = INVITE_ALLOWED_ROLES.has(normalizedRole);

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

    return {
      statusCode: 200,
      body: JSON.stringify({
        displayName: String(user.displayName ?? ""),
        organizationId: user.organizationId,
        orgName: String(org.name ?? ""),
        subscribed,
        accessSuspended,
        plan,
        seatLimit: org.seatLimit ?? 1,
        seatsUsed,
        paymentStatus: org.paymentStatus ?? "Free",
        role: normalizedRole,
        canInviteUsers,
      }),
    };
  } catch (err) {
    if (err instanceof InventoryStorageProvisioningError || isResourceInUse(err)) {
      return {
        statusCode: 202,
        body: JSON.stringify({
          error: "Inventory storage is still provisioning",
          code: "INVENTORY_STORAGE_PROVISIONING",
          retryAfterMs: PROVISIONING_RETRY_AFTER_MS,
        }),
      };
    }
    console.error("user-subscription error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
