import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

// Allowed origins for CORS
const allowedOrigins = [
  "http://localhost:5174",
  "https://systems.wickops.com",
];

export const handler: Handler = async (event) => {
  const origin = event.headers.origin;
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Access-Control-Allow-Credentials": "false",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const { organizationId, organizationName } = JSON.parse(event.body || "{}");

  if (!organizationId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "organizationId required" }) };
  }

  try {
    // Use FRONTEND_URL for Stripe URLs to ensure full valid URL
    const frontendUrl = process.env.FRONTEND_URL!;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/billing/cancel`,
      metadata: {
        organizationId,
        ...(organizationName && { organizationName }),
      },
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };
  } catch (err: unknown) {
    console.error("Checkout creation failed:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal server error" }) };
  }
};
