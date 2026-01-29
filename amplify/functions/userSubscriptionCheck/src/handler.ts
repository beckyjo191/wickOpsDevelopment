import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));
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
    const { userId } = event.queryStringParameters || {};
    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: "userId required" }) };

    // Lookup user to get orgId
    const userResult = await ddbClient.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
    if (!userResult.Item) return { statusCode: 404, headers, body: JSON.stringify({ error: "User not found" }) };

    const orgId = userResult.Item.organizationId;
    const orgResult = await ddbClient.send(new GetCommand({ TableName: ORG_TABLE, Key: { id: orgId } }));
    if (!orgResult.Item) return { statusCode: 404, headers, body: JSON.stringify({ error: "Organization not found" }) };

    const subscribed = orgResult.Item.paymentStatus === "Paid";
    const maxUsers = orgResult.Item.seatLimit ?? 5;
    const seatsUsed = orgResult.Item.seatsUsed ?? orgResult.Item.users?.length ?? 0;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ subscribed, maxUsers, seatsUsed }),
    };
  } catch (err: unknown) {
    console.error("Subscription check failed:", getErrorMessage(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: getErrorMessage(err) }) };
  }
};
