import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-2" })
);

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const isPaidStatus = (value: unknown): boolean => {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "active" || normalized === "paid";
};

export const handler: Handler = async (event) => {
  console.log("PostConfirmation event:", JSON.stringify(event, null, 2));

  const email = event.request.userAttributes?.email;
  if (!email) throw new Error("Email attribute missing");

  const displayName =
    event.request.clientMetadata?.displayName ??
    event.request.userAttributes?.name ??
    email;

  const orgNameInput = event.request.userAttributes?.["custom:organizationName"];

  const ORG_TABLE = process.env.ORG_TABLE!;
  const USER_TABLE = process.env.USER_TABLE!;
  const INVITE_TABLE = process.env.INVITE_TABLE!;
  const USER_POOL_ID = event.userPoolId;

  const normalizedEmail = email.trim().toLowerCase();

  // If this user has a pending invite, consume it and assign the invited role/org.
  let invite:
    | {
        organizationId?: string;
        role?: string;
        status?: string;
      }
    | undefined;
  try {
    const inviteResult = await ddb.send(
      new GetCommand({ TableName: INVITE_TABLE, Key: { id: normalizedEmail } })
    );
    invite = inviteResult.Item as
      | {
          organizationId?: string;
          role?: string;
          status?: string;
        }
      | undefined;
  } catch (err) {
    console.warn("Invite lookup failed in postConfirmation", err);
  }

  const inviteOrganizationId = invite?.organizationId;
  if (invite?.status === "PENDING" && inviteOrganizationId) {
    const orgResult = await ddb.send(
      new GetCommand({ TableName: ORG_TABLE, Key: { id: inviteOrganizationId } })
    );
    if (!orgResult.Item) {
      throw new Error(`Organization not found for invite: ${inviteOrganizationId}`);
    }

    const invitedRole =
      invite.role === "ADMIN" || invite.role === "EDITOR" || invite.role === "VIEWER"
        ? invite.role
        : "VIEWER";
    const isAdmin = invitedRole === "ADMIN";

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: INVITE_TABLE,
          Key: { id: normalizedEmail },
          ConditionExpression: "#status = :pending",
          UpdateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt, acceptedUserId = :uid",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":pending": "PENDING",
            ":accepted": "ACCEPTED",
            ":acceptedAt": new Date().toISOString(),
            ":uid": event.userName,
          },
        })
      );
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        console.log(`Invite for ${normalizedEmail} already consumed`);
        return event;
      }
      throw err;
    }

    await ddb.send(
      new PutCommand({
        TableName: USER_TABLE,
        Item: {
          id: event.userName,
          email: normalizedEmail,
          displayName,
          organizationId: inviteOrganizationId,
          role: invitedRole,
          accessSuspended: !isPaidStatus(orgResult.Item.paymentStatus),
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(id) OR email = :email",
        ExpressionAttributeValues: {
          ":email": normalizedEmail,
        },
      })
    );

    await ddb.send(
      new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: inviteOrganizationId },
        UpdateExpression: "SET seatsUsed = if_not_exists(seatsUsed, :zero) + :inc",
        ExpressionAttributeValues: {
          ":zero": 0,
          ":inc": 1,
        },
      })
    );

    if (isAdmin) {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: event.userName,
          GroupName: "Admins",
        })
      );
    }

    console.log(`✅ Invited user ${normalizedEmail} created with role=${invitedRole}`);
    return event;
  }

  const isPersonal = !orgNameInput || orgNameInput.trim() === "";
  const organizationName = isPersonal
    ? `Personal - ${displayName}`
    : orgNameInput.trim();

  const organizationId = isPersonal
    ? `personal_${normalizedEmail.replace(/[^a-zA-Z0-9]/g, "_")}`
    : organizationName.toLowerCase().replace(/\s+/g, "_");

  const seatLimit = isPersonal ? 1 : 5;
  let isAdmin = false;

  // Check org exists
  const orgResult = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: organizationId } })
  );

  if (!orgResult.Item) {
    isAdmin = true;
    await ddb.send(
      new PutCommand({
        TableName: ORG_TABLE,
        Item: {
          id: organizationId,
          name: organizationName,
          type: isPersonal ? "PERSONAL" : "ORG",
          seatLimit,
          seatsUsed: 1,
          plan: "Free",
          paymentStatus: "Pending",
          createdAt: new Date().toISOString(),
        },
      })
    );
  } else {
    await ddb.send(
      new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: organizationId },
        UpdateExpression: "SET seatsUsed = seatsUsed + :inc",
        ExpressionAttributeValues: { ":inc": 1 },
      })
    );
  }

  // Create user with Cognito UUID as id
  await ddb.send(
    new PutCommand({
      TableName: USER_TABLE,
      Item: {
        id: event.userName, // Cognito UUID
        email: normalizedEmail,
        displayName,
        organizationId,
        role: isAdmin ? "ADMIN" : "MEMBER",
        accessSuspended: true, // until payment confirmed
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(id) OR email = :email",
      ExpressionAttributeValues: {
        ":email": normalizedEmail,
      },
    })
  );

  if (isAdmin) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: event.userName,
        GroupName: "Admins",
      })
    );
  }

  console.log(`✅ User ${email} created (admin=${isAdmin})`);
  return event;
};
