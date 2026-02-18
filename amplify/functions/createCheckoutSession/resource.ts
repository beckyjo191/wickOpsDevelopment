import { defineFunction, secret } from "@aws-amplify/backend";

export const createCheckoutSession = defineFunction({
  name: "createCheckoutSession",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_PRICE_ID: secret("STRIPE_PRICE_ID"),
  },
  layers: {
    "stripe": "stripe-layer:1"
  },
});
