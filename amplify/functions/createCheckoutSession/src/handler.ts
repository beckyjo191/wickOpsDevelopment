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
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID!;

export const handler = async (event: any) => {
  try {
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
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/billing`,
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
