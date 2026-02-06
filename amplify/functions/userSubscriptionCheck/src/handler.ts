import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;

export const handler = async (event: any) => {
  try {
const claims =
  event.requestContext?.authorizer?.jwt?.claims ??
  event.requestContext?.authorizer?.claims;

const userId = claims?.sub;

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

    if (!userRes.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "User not found" }),
      };
    }

    const user = userRes.Item;

    // 🔒 Suspended users are always blocked
    if (user.accessSuspended === true) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          subscribed: false,
          accessSuspended: true,
          plan: "Free",
          seatLimit: 1,
          seatsUsed: 0,
          paymentStatus: "Suspended",
        }),
      };
    }

    if (!user.organizationId) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "User missing organizationId",
        }),
      };
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

    const subscribed =
      org.paymentStatus === "Active" && org.plan !== "Free";

    return {
      statusCode: 200,
      body: JSON.stringify({
        subscribed,
        accessSuspended: false,
        plan: org.plan ?? "Free",
        seatLimit: org.seatLimit ?? 1,
        seatsUsed: org.seatsUsed ?? 0,
        paymentStatus: org.paymentStatus ?? "Free",
      }),
    };
  } catch (err) {
    console.error("user-subscription error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
