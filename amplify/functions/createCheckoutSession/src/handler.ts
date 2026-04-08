import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const FRONTEND_URL = process.env.FRONTEND_URL!;

const DEPLOYMENT_ENV = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();
const CORS_ALLOW_ORIGIN =
  DEPLOYMENT_ENV === "prod" || DEPLOYMENT_ENV === "production"
    ? "https://systems.wickops.com"
    : "http://localhost:5173";
const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  Vary: "Origin",
};
const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...corsHeaders },
  body: JSON.stringify(body),
});

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
    const orgName = String(requestBody.orgName ?? "").trim().slice(0, 100);

    if (!VALID_PLAN_KEYS.has(planKey) || !VALID_BILLING_PERIODS.has(billingPeriod)) {
      return json(400, { error: "Invalid plan or billing period." });
    }

    const priceId = PRICE_ID_MAP[planKey as PlanKey][billingPeriod as BillingPeriod];
    if (!priceId) {
      return json(500, { error: "Price not configured for this plan. Contact support." });
    }

    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const userId = claims?.sub;
    if (!userId) {
      return json(401, { error: "Unauthorized" });
    }

    // Load user
    const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
    if (!userRes.Item) return json(404, { error: "User not found" });
    const user = userRes.Item;

    // Only OWNER or ADMIN can manage billing
    const role = String(user.role ?? "").toUpperCase();
    if (role !== "OWNER" && role !== "ADMIN" && role !== "ACCOUNT_OWNER") {
      return json(403, { error: "Only account owners and admins can manage billing" });
    }

    if (!user.organizationId) {
      return json(500, { error: "User missing organizationId" });
    }

    // Load organization
    const orgRes = await ddb.send(new GetCommand({ TableName: ORG_TABLE, Key: { id: user.organizationId } }));
    if (!orgRes.Item) return json(404, { error: "Organization not found" });
    const org = orgRes.Item;

    // Update org name if the user provided one on the subscription page
    if (orgName) {
      await ddb.send(
        new UpdateCommand({
          TableName: ORG_TABLE,
          Key: { id: org.id },
          UpdateExpression: "SET #name = :name",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": orgName },
        })
      );
    }

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

    return json(200, { url: session.url });
  } catch (err: any) {
    console.error("createCheckoutSession error:", err);
    return json(500, { error: "Internal server error" });
  }
};
