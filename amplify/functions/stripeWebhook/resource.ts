import { defineFunction, secret } from "@aws-amplify/backend";

export const stripeWebhook = defineFunction({
  name: "stripeWebhook",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),
    ORG_TABLE: secret("ORG_TABLE"),
    USER_TABLE: secret("USER_TABLE")
  },
  
  layers: {
    "stripe": "stripe-layer:1"
  },
  
});
