// ── Route handlers: profile ─────────────────────────────────────────────────
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { USER_TABLE } from "../config";
import { ddb } from "../clients";
import { json } from "../http";

export const handleUpdateCurrentUserDisplayName = async (ctx: RouteContext) => {
  const { access, body } = ctx;
  const displayName = String(body?.displayName ?? "").trim();
  if (!displayName) {
    return json(400, { error: "displayName is required." });
  }
  if (displayName.length > 120) {
    return json(400, { error: "displayName is too long." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: access.userId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET displayName = :displayName",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":displayName": displayName,
      },
    }),
  );

  return json(200, {
    ok: true,
    displayName,
  });
};

export const handleSyncCurrentUserEmail = async (ctx: RouteContext) => {
  const { access } = ctx;
  if (!access.email) {
    return json(400, { error: "Email claim is required." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: access.userId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET email = :email",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":email": access.email,
      },
    }),
  );

  return json(200, {
    ok: true,
    email: access.email,
  });
};

export const handleSaveUserColumnVisibility = async (ctx: RouteContext) => {
  const { access, body } = ctx;
  const overrides = body?.overrides;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return json(400, { error: "overrides object is required" });
  }
  for (const [key, val] of Object.entries(overrides)) {
    if (typeof key !== "string" || typeof val !== "boolean") {
      return json(400, { error: "overrides must be a map of columnId to boolean" });
    }
  }

  // Read current columnVisibility JSON from user record
  const userRes = await ddb.send(
    new GetCommand({ TableName: USER_TABLE, Key: { id: access.userId } }),
  );
  const existing = userRes.Item?.columnVisibility;
  let allOrgs: Record<string, Record<string, boolean>> = {};
  if (existing) {
    try {
      allOrgs = JSON.parse(existing);
    } catch {
      // reset if malformed
    }
  }

  allOrgs[access.organizationId] = overrides as Record<string, boolean>;

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: access.userId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET columnVisibility = :cv",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":cv": JSON.stringify(allOrgs),
      },
    }),
  );

  return json(200, { ok: true });
};
