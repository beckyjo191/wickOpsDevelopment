import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "";
const RETURN_URL = FRONTEND_URL ? `${FRONTEND_URL}/settings` : "";

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

export const handler = async (event: any) => {
  try {
    // Get userId from Cognito JWT authorizer claims (same pattern as createCheckoutSession)
    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const userId = claims?.sub;
    if (!userId) {
      return json(401, { error: "Unauthorized" });
    }

    // Load user → organizationId
    const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
    if (!userRes.Item) return json(404, { error: "User not found" });
    const user = userRes.Item;

    // Only OWNER or ADMIN can access the billing portal
    const role = String(user.role ?? "").toUpperCase();
    if (role !== "OWNER" && role !== "ADMIN" && role !== "ACCOUNT_OWNER") {
      return json(403, { error: "Only account owners and admins can manage billing" });
    }

    if (!user.organizationId) {
      return json(400, { error: "User has no organization" });
    }

    // Load org → stripeCustomerId
    const orgRes = await ddb.send(new GetCommand({ TableName: ORG_TABLE, Key: { id: user.organizationId } }));
    if (!orgRes.Item) return json(404, { error: "Organization not found" });
    const org = orgRes.Item;

    const stripeCustomerId = org.stripeCustomerId;
    if (!stripeCustomerId) {
      return json(400, { error: "No billing account on file. Complete your initial checkout first." });
    }

    // Create Stripe Customer Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: RETURN_URL || "https://app.wickops.com/settings",
    });

    return json(200, { url: session.url });
  } catch (err: any) {
    console.error("createBillingPortalSession error:", err);
    return json(500, { error: "Internal server error" });
  }
};
