import { defineFunction } from "@aws-amplify/backend";

export const createCheckoutSession = defineFunction({
  name: "createCheckoutSession",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY",
    ORG_TABLE: "ORG_TABLE",
    STRIPE_PRICE_ID: "STRIPE_PRICE_ID",
    FRONTEND_URL: "http://localhost:5174"
  },
  layers: {
    "stripe": "stripe-layer:1"
  },
});
