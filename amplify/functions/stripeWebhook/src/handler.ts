import type { Handler } from "aws-lambda";
import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : "Unknown error";
}

export const handler: Handler = async (event) => {
  const sig = event.headers["stripe-signature"];
  if (!sig || !event.body) return { statusCode: 400 };

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", getErrorMessage(err));
    return { statusCode: 400 };
  }

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        if (!organizationId) break;

        // ✅ Mark org as Paid
        await ddb.send(
          new UpdateCommand({
            TableName: ORG_TABLE,
            Key: { id: organizationId },
            UpdateExpression: "SET paymentStatus = :paid",
            ExpressionAttributeValues: { ":paid": "Paid" },
          })
        );

        // ✅ Unsuspend all users in org
        const users = await ddb.send(
          new ScanCommand({
            TableName: USER_TABLE,
            FilterExpression: "organizationId = :orgId",
            ExpressionAttributeValues: { ":orgId": organizationId },
          })
        );

        for (const user of users.Items ?? []) {
          if (!user.id) continue;

          await ddb.send(
            new UpdateCommand({
              TableName: USER_TABLE,
              Key: { id: user.id },
              UpdateExpression: "SET accessSuspended = :false",
              ExpressionAttributeValues: { ":false": false },
            })
          );
        }

        console.log(`✅ Org ${organizationId} marked Paid`);
        break;
      }

      case "invoice.payment_failed":
      case "customer.subscription.deleted": {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        const organizationId = subscription.metadata?.organizationId;
        if (!organizationId) break;

        // 🔒 Mark org Unpaid
        await ddb.send(
          new UpdateCommand({
            TableName: ORG_TABLE,
            Key: { id: organizationId },
            UpdateExpression: "SET paymentStatus = :unpaid",
            ExpressionAttributeValues: { ":unpaid": "Unpaid" },
          })
        );

        // 🔒 Suspend all users
        const users = await ddb.send(
          new ScanCommand({
            TableName: USER_TABLE,
            FilterExpression: "organizationId = :orgId",
            ExpressionAttributeValues: { ":orgId": organizationId },
          })
        );

        for (const user of users.Items ?? []) {
          if (!user.id) continue;

          await ddb.send(
            new UpdateCommand({
              TableName: USER_TABLE,
              Key: { id: user.id },
              UpdateExpression: "SET accessSuspended = :true",
              ExpressionAttributeValues: { ":true": true },
            })
          );
        }

        console.log(`⚠️ Org ${organizationId} suspended`);
        break;
      }
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error("❌ Stripe webhook processing failed:", getErrorMessage(err));
    return { statusCode: 500 };
  }
};
