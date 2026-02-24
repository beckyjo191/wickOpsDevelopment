import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Stripe initialization
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});

// DynamoDB client
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const FRONTEND_URL = process.env.FRONTEND_URL!;

type PlanKey = "Personal" | "Department" | "Organization";
type BillingPeriod = "monthly" | "yearly";

// Resolve price ID server-side from secrets — the frontend only sends planKey + billingPeriod.
const PRICE_ID_MAP: Record<PlanKey, Record<BillingPeriod, string | undefined>> = {
  Personal: {
    monthly: process.env.STRIPE_PRICE_PERSONAL_MONTHLY,
    yearly:  process.env.STRIPE_PRICE_PERSONAL_YEARLY,
  },
  Department: {
    monthly: process.env.STRIPE_PRICE_DEPARTMENT_MONTHLY,
    yearly:  process.env.STRIPE_PRICE_DEPARTMENT_YEARLY,
  },
  Organization: {
    monthly: process.env.STRIPE_PRICE_ORGANIZATION_MONTHLY,
    yearly:  process.env.STRIPE_PRICE_ORGANIZATION_YEARLY,
  },
};

const VALID_PLAN_KEYS = new Set<string>(["Personal", "Department", "Organization"]);
const VALID_BILLING_PERIODS = new Set<string>(["monthly", "yearly"]);

export const handler = async (event: any) => {
  try {
    const requestBody = event.body ? JSON.parse(event.body) : {};
    const planKey = String(requestBody.planKey ?? "").trim();
    const billingPeriod = String(requestBody.billingPeriod ?? "").trim();

    if (!VALID_PLAN_KEYS.has(planKey) || !VALID_BILLING_PERIODS.has(billingPeriod)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid plan or billing period." }),
      };
    }

    const priceId = PRICE_ID_MAP[planKey as PlanKey][billingPeriod as BillingPeriod];
    if (!priceId) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Price not configured for this plan. Contact support." }),
      };
    }

    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const userId = claims?.sub;
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Load user
    const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
    if (!userRes.Item) return { statusCode: 404, body: JSON.stringify({ error: "User not found" }) };
    const user = userRes.Item;

    if (!user.organizationId) {
      return { statusCode: 500, body: JSON.stringify({ error: "User missing organizationId" }) };
    }

    // Load organization
    const orgRes = await ddb.send(new GetCommand({ TableName: ORG_TABLE, Key: { id: user.organizationId } }));
    if (!orgRes.Item) return { statusCode: 404, body: JSON.stringify({ error: "Organization not found" }) };
    const org = orgRes.Item;

    // Create Stripe customer if needed
    let stripeCustomerId = org.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { organizationId: org.id },
      });
      stripeCustomerId = customer.id;

      await ddb.send(
        new UpdateCommand({
          TableName: ORG_TABLE,
          Key: { id: org.id },
          UpdateExpression: "SET stripeCustomerId = :cid",
          ExpressionAttributeValues: { ":cid": stripeCustomerId },
        })
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/?checkout=success`,
      cancel_url: `${FRONTEND_URL}/app`,
      metadata: {
        organizationId: org.id,
        userId: user.id,
      },
      subscription_data: {
        metadata: {
          organizationId: org.id,
          userId: user.id, // ✅ pass userId
        },
      },
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err: any) {
    console.error("createCheckoutSession error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message ?? String(err) }) };
  }
};
