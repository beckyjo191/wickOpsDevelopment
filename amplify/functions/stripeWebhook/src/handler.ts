import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

export const handler = async (event: any) => {
  const sig = event.headers["stripe-signature"];
  let stripeEvent: Stripe.Event;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return { statusCode: 400, body: "Invalid signature" };
  }

  // Only handle subscription creation for now
  if (stripeEvent.type === "customer.subscription.created") {
    const subscription = stripeEvent.data.object as Stripe.Subscription;
    const organizationId = subscription.metadata?.organizationId;
    const userId = subscription.metadata?.userId;

    if (!organizationId) {
      console.error("Missing organizationId in subscription metadata");
      return { statusCode: 200, body: "ok" };
    }

    // 1️⃣ Update org
    await ddb.send(
      new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: organizationId },
        UpdateExpression: `
          SET paymentStatus = :active,
              plan = :plan,
              stripeSubscriptionId = :sid
        `,
        ExpressionAttributeValues: {
          ":active": "Active",
          ":plan": "Pro",
          ":sid": subscription.id,
        },
      })
    );

    // 2️⃣ Unsuspend the single user
    if (userId) {
      await ddb.send(
        new UpdateCommand({
          TableName: USER_TABLE,
          Key: { id: userId },
          UpdateExpression: "SET accessSuspended = :false",
          ExpressionAttributeValues: { ":false": false },
        })
      );
    }
  }

  return { statusCode: 200, body: "ok" };
};