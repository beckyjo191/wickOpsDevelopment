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
  AdminDeleteUserCommand,
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
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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

type RequesterContext = {
  userId: string;
  orgId: string;
  orgName: string;
};

const authorizeAdmin = async (
  event: any,
): Promise<
  | { ok: true; ctx: RequesterContext }
  | { ok: false; response: ReturnType<typeof json> }
> => {
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ??
    event.requestContext?.authorizer?.claims;
  const requesterUserId = claims?.sub;
  if (!requesterUserId || !USER_POOL_ID) {
    return { ok: false, response: json(401, { error: "Unauthorized" }) };
  }
  const requesterRes = await ddb.send(
    new GetCommand({ TableName: USER_TABLE, Key: { id: requesterUserId } }),
  );
  const requester = requesterRes.Item;
  if (!requester) {
    return { ok: false, response: json(404, { error: "Requester not found" }) };
  }
  const requesterRole = String(requester.role ?? "").trim().toUpperCase();
  if (!INVITE_ALLOWED_ROLES.has(requesterRole)) {
    return {
      ok: false,
      response: json(403, {
        error: "Only admins or account owners can manage invites",
      }),
    };
  }
  const orgId = requester.organizationId;
  if (!orgId) {
    return {
      ok: false,
      response: json(400, { error: "Requester missing organizationId" }),
    };
  }
  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: orgId } }),
  );
  const org = orgRes.Item;
  if (!org) {
    return { ok: false, response: json(404, { error: "Organization not found" }) };
  }
  return {
    ok: true,
    ctx: {
      userId: String(requesterUserId),
      orgId: String(orgId),
      orgName: String(org.name ?? ""),
    },
  };
};

// ── Route handlers ──────────────────────────────────────────────────────────

const handleSendInvites = async (event: any, ctx: RequesterContext) => {
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

  // Clean up expired invites first so they don't count against seats
  await expireStaleInvites(ctx.orgId);

  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: ctx.orgId } }),
  );
  const org = orgRes.Item ?? {};
  const seatLimit = Number(org.seatLimit ?? 1);
  const seatsUsed =
    (await countOrgUsers(ctx.orgId)) + (await countPendingInvites(ctx.orgId));
  const seatsRemaining = Math.max(0, seatLimit - seatsUsed);

  if (invites.length > seatsRemaining) {
    return json(400, { error: `Only ${seatsRemaining} seat(s) available` });
  }

  const invited: { name: string; email: string; role: InviteRole }[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const invite of invites) {
    const { name, email, role } = invite;
    try {
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
              { Name: "custom:organizationName", Value: ctx.orgName },
            ],
          }),
        );
      } catch (err: any) {
        // If a prior invite left an unconfirmed Cognito user, resend the temp password email
        // instead of failing. RESEND only works while the user is in FORCE_CHANGE_PASSWORD state.
        if (err?.name === "UsernameExistsException") {
          await cognito.send(
            new AdminCreateUserCommand({
              UserPoolId: USER_POOL_ID,
              Username: email,
              MessageAction: "RESEND",
              DesiredDeliveryMediums: ["EMAIL"],
            }),
          );
        } else {
          throw err;
        }
      }

      await ddb.send(
        new PutCommand({
          TableName: INVITE_TABLE,
          Item: {
            id: email,
            email,
            displayName: name,
            organizationId: ctx.orgId,
            role,
            status: "PENDING",
            invitedBy: ctx.userId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
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
};

const handleListPendingInvites = async (ctx: RequesterContext) => {
  await expireStaleInvites(ctx.orgId);
  const result = await ddb.send(
    new ScanCommand({
      TableName: INVITE_TABLE,
      FilterExpression: "organizationId = :orgId AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":orgId": ctx.orgId,
        ":pending": "PENDING",
      },
    }),
  );
  const invites = (result.Items ?? [])
    .map((item) => ({
      email: String(item.email ?? item.id ?? ""),
      displayName: String(item.displayName ?? ""),
      role: String(item.role ?? "VIEWER") as InviteRole,
      createdAt: String(item.createdAt ?? ""),
      expiresAt: String(item.expiresAt ?? ""),
      invitedBy: String(item.invitedBy ?? ""),
    }))
    .filter((inv) => inv.email.length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(200, { invites });
};

const parseEmailFromBody = (event: any): string | null => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const email = String(parsed?.email ?? "").trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
};

const handleResendInvite = async (event: any, ctx: RequesterContext) => {
  const email = parseEmailFromBody(event);
  if (!email) return json(400, { error: "Missing email" });

  // Confirm the invite belongs to this org
  const existingRes = await ddb.send(
    new GetCommand({ TableName: INVITE_TABLE, Key: { id: email } }),
  );
  const existing = existingRes.Item;
  if (!existing || existing.organizationId !== ctx.orgId) {
    return json(404, { error: "Invite not found" });
  }

  // Resend the Cognito temp-password email. RESEND requires the user still be in
  // FORCE_CHANGE_PASSWORD state. If Cognito reports the user doesn't exist,
  // recreate them with their stored name/attributes.
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        MessageAction: "RESEND",
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
  } catch (err: any) {
    if (err?.name === "UserNotFoundException") {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
          DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [
            { Name: "name", Value: String(existing.displayName ?? "") },
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "custom:organizationName", Value: ctx.orgName },
          ],
        }),
      );
    } else {
      console.error("Resend failed", { email, err });
      return json(500, { error: "Failed to resend invite" });
    }
  }

  // Refresh the DB invite: bump createdAt + expiresAt, ensure PENDING.
  await ddb.send(
    new UpdateCommand({
      TableName: INVITE_TABLE,
      Key: { id: email },
      UpdateExpression:
        "SET #status = :pending, createdAt = :now, expiresAt = :exp, invitedBy = :by",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pending": "PENDING",
        ":now": new Date().toISOString(),
        ":exp": new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        ":by": ctx.userId,
      },
    }),
  );

  return json(200, { ok: true, email });
};

const handleCancelInvite = async (event: any, ctx: RequesterContext) => {
  // Support both POST /cancel-invite {email} and DELETE /invites/{email}
  let email = parseEmailFromBody(event);
  if (!email) {
    const path = String(event.pathParameters?.email ?? "").trim().toLowerCase();
    if (path) email = decodeURIComponent(path);
  }
  if (!email) return json(400, { error: "Missing email" });

  const existingRes = await ddb.send(
    new GetCommand({ TableName: INVITE_TABLE, Key: { id: email } }),
  );
  const existing = existingRes.Item;
  if (!existing || existing.organizationId !== ctx.orgId) {
    return json(404, { error: "Invite not found" });
  }

  // Remove the unconfirmed Cognito user. Ignore if already gone.
  try {
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
      }),
    );
  } catch (err: any) {
    if (err?.name !== "UserNotFoundException") {
      console.error("AdminDeleteUser failed", { email, err });
      return json(500, { error: "Failed to cancel invite" });
    }
  }

  await ddb.send(
    new UpdateCommand({
      TableName: INVITE_TABLE,
      Key: { id: email },
      UpdateExpression: "SET #status = :cancelled, cancelledAt = :now, cancelledBy = :by",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":cancelled": "CANCELLED",
        ":now": new Date().toISOString(),
        ":by": ctx.userId,
      },
    }),
  );

  return json(200, { ok: true, email });
};

// ── Router ──────────────────────────────────────────────────────────────────

export const handler = async (event: any) => {
  try {
    const rawPath = String(event.rawPath ?? event.path ?? "").toLowerCase();
    const method = String(
      event.requestContext?.http?.method ?? event.httpMethod ?? "",
    ).toUpperCase();

    const auth = await authorizeAdmin(event);
    if (!auth.ok) return auth.response;

    // GET /pending-invites
    if (method === "GET" && rawPath.endsWith("/pending-invites")) {
      return await handleListPendingInvites(auth.ctx);
    }
    // POST /resend-invite
    if (method === "POST" && rawPath.endsWith("/resend-invite")) {
      return await handleResendInvite(event, auth.ctx);
    }
    // POST /cancel-invite  (also accepts DELETE)
    if (
      (method === "POST" || method === "DELETE") &&
      rawPath.endsWith("/cancel-invite")
    ) {
      return await handleCancelInvite(event, auth.ctx);
    }
    // POST /send-invites (default)
    if (method === "POST" && rawPath.endsWith("/send-invites")) {
      return await handleSendInvites(event, auth.ctx);
    }

    // Back-compat: any POST with a body of {invites:[...]} hits send-invites
    if (method === "POST") {
      return await handleSendInvites(event, auth.ctx);
    }

    return json(404, { error: "Not found" });
  } catch (error: any) {
    console.error("sendInvites error", error);
    return json(500, { error: "Internal server error" });
  }
};
