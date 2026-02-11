import { defineFunction } from "@aws-amplify/backend";

export const stripeWebhook = defineFunction({
  name: "stripeWebhook",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY",
    STRIPE_WEBHOOK_SECRET: "STRIPE_WEBHOOK_SECRET",
    ORG_TABLE: "ORG_TABLE",
    USER_TABLE: "USER_TABLE"
  },
  
  layers: {
    "stripe": "stripe-layer:1"
  },
  
});
