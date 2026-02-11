import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

export const handler = async (event: any) => {
  const sig =
    event.headers?.["stripe-signature"] ?? event.headers?.["Stripe-Signature"];
  let stripeEvent: Stripe.Event;

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    console.log(
      "sig_present",
      !!(event.headers?.["stripe-signature"] ?? event.headers?.["Stripe-Signature"])
    );
    console.log("body_type", typeof event.body, "isBase64", event.isBase64Encoded);
    console.log("body_len", typeof event.body === "string" ? event.body.length : -1);

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return { statusCode: 400, body: "Invalid signature" };
  }

  const handleSubscription = async (
    subscription: Stripe.Subscription,
    fallbackMetadata?: { organizationId?: string | null; userId?: string | null }
  ) => {
    const organizationId =
      subscription.metadata?.organizationId ??
      fallbackMetadata?.organizationId ??
      undefined;
    const userId =
      subscription.metadata?.userId ?? fallbackMetadata?.userId ?? undefined;

    if (!organizationId) {
      console.error("Missing organizationId in subscription metadata");
      return;
    }

    // 1️⃣ Update org
    await ddb.send(
      new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: organizationId },
        UpdateExpression: `
          SET paymentStatus = :active,
              #plan = :plan,
              stripeSubscriptionId = :sid
        `,
        ExpressionAttributeNames: {
          "#plan": "plan",
        },
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
  };

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object as Stripe.Checkout.Session;
    if (session.mode === "subscription") {
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(
          subscriptionId
        );
        await handleSubscription(subscription, {
          organizationId: session.metadata?.organizationId ?? null,
          userId: session.metadata?.userId ?? null,
        });
      }
    }
  }

  // Also handle subscription creation directly
  if (stripeEvent.type === "customer.subscription.created") {
    const subscription = stripeEvent.data.object as Stripe.Subscription;
    await handleSubscription(subscription);
  }

  return { statusCode: 200, body: "ok" };
};
