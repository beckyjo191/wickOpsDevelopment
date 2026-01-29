import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {  });
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-2" }));

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}

export const handler: Handler = async (event) => {
  try {
    const sig = event.headers["stripe-signature"];
    if (!sig) return { statusCode: 400 };

    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body!,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err: unknown) {
      console.error("Webhook signature verification failed:", getErrorMessage(err));
      return { statusCode: 400 };
    }

    if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organizationId;
      if (!organizationId) {
        console.error("Stripe session missing organizationId");
        return { statusCode: 400 };
      }

      // Mark org as Paid
      await ddbClient.send(new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: organizationId },
        UpdateExpression: "SET paymentStatus = :paid",
        ExpressionAttributeValues: { ":paid": "Paid" },
      }));

      // Reactivate all users
      const usersResult = await ddbClient.send(new ScanCommand({
        TableName: USER_TABLE,
        FilterExpression: "organizationId = :orgId",
        ExpressionAttributeValues: { ":orgId": organizationId },
      }));

      for (const user of usersResult.Items ?? []) {
        if (!user.id) continue;
        await ddbClient.send(new UpdateCommand({
          TableName: USER_TABLE,
          Key: { id: user.id },
          UpdateExpression: "SET accessSuspended = :false",
          ExpressionAttributeValues: { ":false": false },
        }));
      }

      console.log(`Organization ${organizationId} marked Paid`);
    }

    return { statusCode: 200 };
  } catch (err: unknown) {
    console.error("Stripe webhook failed:", getErrorMessage(err));
    return { statusCode: 500 };
  }
};
