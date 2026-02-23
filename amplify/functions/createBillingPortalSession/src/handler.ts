import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "";
// Return URL after the user closes the portal — send them back to Settings
const RETURN_URL = FRONTEND_URL ? `${FRONTEND_URL}/settings` : "";

export const handler = async (event: any) => {
  try {
    // Get userId from Cognito JWT authorizer claims (same pattern as createCheckoutSession)
    const claims =
      event.requestContext?.authorizer?.jwt?.claims ??
      event.requestContext?.authorizer?.claims;

    const userId = claims?.sub;
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Load user → organizationId
    const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
    if (!userRes.Item) return { statusCode: 404, body: JSON.stringify({ error: "User not found" }) };
    const user = userRes.Item;

    if (!user.organizationId) {
      return { statusCode: 400, body: JSON.stringify({ error: "User has no organization" }) };
    }

    // Load org → stripeCustomerId
    const orgRes = await ddb.send(new GetCommand({ TableName: ORG_TABLE, Key: { id: user.organizationId } }));
    if (!orgRes.Item) return { statusCode: 404, body: JSON.stringify({ error: "Organization not found" }) };
    const org = orgRes.Item;

    const stripeCustomerId = org.stripeCustomerId;
    if (!stripeCustomerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "No billing account on file. Complete your initial checkout first.",
        }),
      };
    }

    // Create Stripe Customer Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: RETURN_URL || "https://app.wickops.com/settings",
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err: any) {
    console.error("createBillingPortalSession error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message ?? String(err) }) };
  }
};
