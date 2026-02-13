import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
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

type InviteRole = "ADMIN" | "EDITOR" | "VIEWER";

type InviteInput = {
  email: string;
  role: InviteRole;
};

type InviteRequest = {
  invites?: InviteInput[];
};

const parseUserPoolIdFromIssuer = (iss?: string): string | null => {
  if (!iss) return null;
  const parts = iss.split("/");
  return parts[parts.length - 1] || null;
};

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
};

export const handler = async (event: any) => {
  try {
    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const requesterUserId = claims?.sub;
    const userPoolId = parseUserPoolIdFromIssuer(claims?.iss);

    if (!requesterUserId || !userPoolId) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event.body ?? "";
    const body: InviteRequest = rawBody ? JSON.parse(rawBody) : {};

    const normalizedInviteMap = new Map<string, InviteRole>();
    if (Array.isArray(body.invites)) {
      for (const invite of body.invites) {
        const email = String(invite?.email ?? "").trim().toLowerCase();
        const role = String(invite?.role ?? "VIEWER").toUpperCase() as InviteRole;
        if (!email) continue;
        if (role !== "ADMIN" && role !== "EDITOR" && role !== "VIEWER") continue;
        normalizedInviteMap.set(email, role);
      }
    }
    const invites = Array.from(normalizedInviteMap.entries()).map(([email, role]) => ({
      email,
      role,
    }));

    if (invites.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "No invites provided" }) };
    }

    const requesterRes = await ddb.send(
      new GetCommand({ TableName: USER_TABLE, Key: { id: requesterUserId } })
    );
    const requester = requesterRes.Item;

    if (!requester) {
      return { statusCode: 404, body: JSON.stringify({ error: "Requester not found" }) };
    }

    const requesterRole = String(requester.role ?? "").trim().toUpperCase();
    if (!INVITE_ALLOWED_ROLES.has(requesterRole)) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Only admins or account owners can invite users" }),
      };
    }

    const orgId = requester.organizationId;
    if (!orgId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Requester missing organizationId" }) };
    }

    const orgRes = await ddb.send(
      new GetCommand({ TableName: ORG_TABLE, Key: { id: orgId } })
    );
    const org = orgRes.Item;
    if (!org) {
      return { statusCode: 404, body: JSON.stringify({ error: "Organization not found" }) };
    }

    const seatLimit = Number(org.seatLimit ?? 1);
    const seatsUsed =
      (await countOrgUsers(orgId)) + (await countPendingInvites(orgId));
    const seatsRemaining = Math.max(0, seatLimit - seatsUsed);

    if (invites.length > seatsRemaining) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Only ${seatsRemaining} seat(s) available`,
        }),
      };
    }

    const invited: { email: string; role: InviteRole }[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const invite of invites) {
      const { email, role } = invite;
      try {
        await cognito.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            DesiredDeliveryMediums: ["EMAIL"],
            UserAttributes: [
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
              organizationId: orgId,
              role,
              status: "PENDING",
              invitedBy: requesterUserId,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
            },
          })
        );

        invited.push({ email, role });
      } catch (error: any) {
        console.error("Invite failed", { email, error });
        failed.push({
          email,
          error: error?.name ?? error?.message ?? "Unknown error",
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        invitedCount: invited.length,
        invited,
        failed,
      }),
    };
  } catch (error: any) {
    console.error("sendInvites error", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error?.message ?? "Internal server error" }),
    };
  }
};
