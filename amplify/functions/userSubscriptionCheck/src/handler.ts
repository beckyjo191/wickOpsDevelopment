import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-2" })
);

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    const { email } = event.queryStringParameters || {};
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Email required" }) };
    }

    // Lookup user by email
    const userResult = await ddb.send(
      new GetCommand({ TableName: USER_TABLE, Key: { id: email } })
    );

    if (!userResult.Item) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };
    }

    const user = userResult.Item;
    const orgId = user.organizationId;

    // Lookup organization
    const orgResult = await ddb.send(
      new GetCommand({ TableName: ORG_TABLE, Key: { id: orgId } })
    );

    if (!orgResult.Item) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Organization not found" }) };
    }

    const org = orgResult.Item;

    const subscribed = org.paymentStatus === "Paid";
    const maxUsers = org.seatLimit ?? 5;
    const seatsUsed = org.seatsUsed ?? org.users?.length ?? 0;
    const accessSuspended = user.accessSuspended ?? !subscribed;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ subscribed, maxUsers, seatsUsed, accessSuspended }),
    };
  } catch (err: unknown) {
    console.error("Subscription check failed:", getErrorMessage(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: getErrorMessage(err) }) };
  }
};
