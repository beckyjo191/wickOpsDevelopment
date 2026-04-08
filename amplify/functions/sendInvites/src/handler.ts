import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const INVITE_TABLE = process.env.INVITE_TABLE!;
const INVITE_ALLOWED_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);

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
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  Vary: "Origin",
};
const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...corsHeaders },
  body: JSON.stringify(body),
});

type InviteRole = "ADMIN" | "EDITOR" | "VIEWER";

type InviteInput = {
  name: string;
  email: string;
  role: InviteRole;
};

type InviteRequest = {
  invites?: InviteInput[];
};

const USER_POOL_ID = process.env.USER_POOL_ID ?? "";

const countOrgUsers = async (organizationId: string): Promise<number> => {
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
};

const countPendingInvites = async (organizationId: string): Promise<number> => {
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
};

// Mark expired pending invites as EXPIRED so they stop counting against seats.
const expireStaleInvites = async (organizationId: string): Promise<number> => {
  const now = new Date().toISOString();
  const result = await ddb.send(
    new ScanCommand({
      TableName: INVITE_TABLE,
      FilterExpression:
        "organizationId = :orgId AND #status = :pending AND expiresAt <= :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":orgId": organizationId,
        ":pending": "PENDING",
        ":now": now,
      },
      ProjectionExpression: "id",
    })
  );
  let expired = 0;
  for (const item of result.Items ?? []) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: INVITE_TABLE,
          Key: { id: item.id },
          ConditionExpression: "#status = :pending",
          UpdateExpression: "SET #status = :expired",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "PENDING",
            ":expired": "EXPIRED",
          },
        })
      );
      expired++;
    } catch {
      // Already changed by another process — skip
    }
  }
  return expired;
};

export const handler = async (event: any) => {
  try {
    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const requesterUserId = claims?.sub;

    if (!requesterUserId || !USER_POOL_ID) {
      return json(401, { error: "Unauthorized" });
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event.body ?? "";
    const body: InviteRequest = rawBody ? JSON.parse(rawBody) : {};

    const normalizedInviteMap = new Map<string, { name: string; role: InviteRole }>();
    if (Array.isArray(body.invites)) {
      for (const invite of body.invites) {
        const name = String(invite?.name ?? "").trim();
        const email = String(invite?.email ?? "").trim().toLowerCase();
        const role = String(invite?.role ?? "VIEWER").toUpperCase() as InviteRole;
        if (!email) continue;
        if (!name) continue;
        if (role !== "ADMIN" && role !== "EDITOR" && role !== "VIEWER") continue;
        normalizedInviteMap.set(email, { name, role });
      }
    }
    const invites = Array.from(normalizedInviteMap.entries()).map(([email, value]) => ({
      name: value.name,
      email,
      role: value.role,
    }));

    if (invites.length === 0) {
      return json(400, { error: "No invites provided" });
    }

    const requesterRes = await ddb.send(
      new GetCommand({ TableName: USER_TABLE, Key: { id: requesterUserId } })
    );
    const requester = requesterRes.Item;

    if (!requester) {
      return json(404, { error: "Requester not found" });
    }

    const requesterRole = String(requester.role ?? "").trim().toUpperCase();
    if (!INVITE_ALLOWED_ROLES.has(requesterRole)) {
      return json(403, { error: "Only admins or account owners can invite users" });
    }

    const orgId = requester.organizationId;
    if (!orgId) {
      return json(400, { error: "Requester missing organizationId" });
    }

    const orgRes = await ddb.send(
      new GetCommand({ TableName: ORG_TABLE, Key: { id: orgId } })
    );
    const org = orgRes.Item;
    if (!org) {
      return json(404, { error: "Organization not found" });
    }

    // Clean up expired invites first so they don't count against seats
    await expireStaleInvites(orgId);

    const seatLimit = Number(org.seatLimit ?? 1);
    const seatsUsed =
      (await countOrgUsers(orgId)) + (await countPendingInvites(orgId));
    const seatsRemaining = Math.max(0, seatLimit - seatsUsed);

    if (invites.length > seatsRemaining) {
      return json(400, { error: `Only ${seatsRemaining} seat(s) available` });
    }

    const invited: { name: string; email: string; role: InviteRole }[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const invite of invites) {
      const { name, email, role } = invite;
      try {
        await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: email,
            DesiredDeliveryMediums: ["EMAIL"],
            UserAttributes: [
              { Name: "name", Value: name },
              { Name: "email", Value: email },
              { Name: "email_verified", Value: "true" },
              { Name: "custom:organizationName", Value: String(org.name ?? "") },
            ],
          })
        );

        await ddb.send(
          new PutCommand({
            TableName: INVITE_TABLE,
            Item: {
              id: email,
              email,
              displayName: name,
              organizationId: orgId,
              role,
              status: "PENDING",
              invitedBy: requesterUserId,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            },
          })
        );

        invited.push({ name, email, role });
      } catch (error: any) {
        console.error("Invite failed", { email, error });
        failed.push({
          email,
          error: "Failed to send invite",
        });
      }
    }

    return json(200, { invitedCount: invited.length, invited, failed });
  } catch (error: any) {
    console.error("sendInvites error", error);
    return json(500, { error: "Internal server error" });
  }
};
