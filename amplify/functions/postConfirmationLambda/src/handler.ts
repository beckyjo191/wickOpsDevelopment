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
  new DynamoDBClient({ region: "us-east-2" })
);

const cognito = new CognitoIdentityProviderClient({ region: "us-east-2" });

export const handler: Handler = async (event) => {
  const email = event.userName;
  const orgNameInput = event.request.userAttributes["custom:organizationName"];

  // 👇 Custom UI field
  const displayName =
    event.request.clientMetadata?.displayName ?? email;

  const ORG_TABLE = process.env.ORG_TABLE!;
  const USER_TABLE = process.env.USER_TABLE!;
  const USER_POOL_ID = event.userPoolId;

  const isPersonal = !orgNameInput || orgNameInput.trim() === "";

  const organizationName = isPersonal
    ? `Personal - ${displayName}`
    : orgNameInput;

  const organizationId = isPersonal
    ? `personal_${email.replace(/[^a-zA-Z0-9]/g, "_")}`
    : organizationName.toLowerCase().replace(/\s+/g, "_");

  const seatLimit = isPersonal ? 1 : 5;
  let isAdmin = false;

  // 1️⃣ Organization
  const orgResult = await ddb.send(
    new GetCommand({
      TableName: ORG_TABLE,
      Key: { id: organizationId },
    })
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

  // 2️⃣ User
  await ddb.send(
    new PutCommand({
      TableName: USER_TABLE,
      Item: {
        id: email,
        organizationId,
        email,
        displayName,
        role: isAdmin ? "ADMIN" : "MEMBER",
        accessSuspended: true,
        createdAt: new Date().toISOString(),
      },
    })
  );

  // 3️⃣ Admin group
  if (isAdmin) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        GroupName: "Admins",
      })
    );
  }

  return event;
};
