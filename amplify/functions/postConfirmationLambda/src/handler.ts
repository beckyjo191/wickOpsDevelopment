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
  const USER_POOL_ID = event.userPoolId;

  const isPersonal = !orgNameInput || orgNameInput.trim() === "";
  const organizationName = isPersonal
    ? `Personal - ${displayName}`
    : orgNameInput.trim();

  const organizationId = isPersonal
    ? `personal_${email.replace(/[^a-zA-Z0-9]/g, "_")}`
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
        email,
        displayName,
        organizationId,
        role: isAdmin ? "ADMIN" : "MEMBER",
        accessSuspended: true, // until payment confirmed
        createdAt: new Date().toISOString(),
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
