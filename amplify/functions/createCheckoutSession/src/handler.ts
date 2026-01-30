import type { Handler } from "aws-lambda";
import Stripe from "stripe";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  
});

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-2" })
);

/**
 * Allowed frontend origins
 * Add preview domains here if needed
 */
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "https://systems.wickops.com",
]);

function getCorsHeaders(origin?: string) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://systems.wickops.com";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
  };
}

export const handler: Handler = async (event) => {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const headers = getCorsHeaders(origin);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: "",
    };
  }

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing request body" }),
      };
    }

    const { organizationId, organizationName } = JSON.parse(event.body);

    if (!organizationId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "organizationId required" }),
      };
    }

    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error("FRONTEND_URL is not configured");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID!,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/billing/cancel`,
      metadata: {
        organizationId,
        organizationName,
      },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Checkout session creation failed:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
