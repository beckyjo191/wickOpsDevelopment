import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ORG_TABLE = process.env.ORG_TABLE!;
const USER_TABLE = process.env.USER_TABLE!;

// Map every Stripe price ID (monthly + yearly) to the plan name it represents.
const PRICE_TO_PLAN: Record<string, string> = Object.fromEntries(
  (
    [
      [process.env.STRIPE_PRICE_PERSONAL_MONTHLY,     "Personal"],
      [process.env.STRIPE_PRICE_PERSONAL_YEARLY,      "Personal"],
      [process.env.STRIPE_PRICE_DEPARTMENT_MONTHLY,   "Department"],
      [process.env.STRIPE_PRICE_DEPARTMENT_YEARLY,    "Department"],
      [process.env.STRIPE_PRICE_ORGANIZATION_MONTHLY, "Organization"],
      [process.env.STRIPE_PRICE_ORGANIZATION_YEARLY,  "Organization"],
    ] as [string | undefined, string][]
  ).filter(([k]) => k) as [string, string][],
);

const PLAN_SEAT_LIMITS: Record<string, number> = {
  Personal:     1,
  Department:   5,
  Organization: 15,
};

// Per-seat add-on price IDs — users purchase these via the Stripe Customer Portal
const SEAT_ADDON_PRICE_IDS = new Set(
  [process.env.STRIPE_PRICE_SEAT_ADDON].filter(Boolean) as string[]
);

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

    // Determine plan name + seat limit from all subscription line items.
    // Base plan items set the plan and base seat count.
    // Seat add-on items (bought via Customer Portal) add to the seat count.
    const items = subscription.items?.data ?? [];
    let plan = "Personal";
    let baseSeats = 1;
    let addonSeats = 0;

    for (const item of items) {
      const itemPriceId = item.price?.id ?? "";
      if (PRICE_TO_PLAN[itemPriceId]) {
        plan = PRICE_TO_PLAN[itemPriceId];
        baseSeats = PLAN_SEAT_LIMITS[plan] ?? 1;
      } else if (SEAT_ADDON_PRICE_IDS.has(itemPriceId)) {
        addonSeats += item.quantity ?? 0;
      }
    }

    const seatLimit = baseSeats + addonSeats;
    const stripeCustomerId = typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? "";

    // 1️⃣ Update org
    await ddb.send(
      new UpdateCommand({
        TableName: ORG_TABLE,
        Key: { id: organizationId },
        UpdateExpression: `
          SET paymentStatus = :active,
              #plan = :plan,
              seatLimit = :seats,
              stripeSubscriptionId = :sid,
              stripeCustomerId = :cid
        `,
        ExpressionAttributeNames: {
          "#plan": "plan",
        },
        ExpressionAttributeValues: {
          ":active": "Active",
          ":plan": plan,
          ":seats": seatLimit,
          ":sid": subscription.id,
          ":cid": stripeCustomerId,
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

  // Handle plan upgrades/downgrades and seat add-on changes via Customer Portal
  if (stripeEvent.type === "customer.subscription.updated") {
    const subscription = stripeEvent.data.object as Stripe.Subscription;
    await handleSubscription(subscription);
  }

  return { statusCode: 200, body: "ok" };
};
