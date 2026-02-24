import { defineFunction, secret } from "@aws-amplify/backend";

export const stripeWebhook = defineFunction({
  name: "stripeWebhook",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),
    // Price IDs are needed so the webhook can map Stripe price → plan name + seat limit.
    // Without these, PRICE_TO_PLAN is empty and every checkout silently defaults to Personal/1 seat.
    STRIPE_PRICE_PERSONAL_MONTHLY: secret("STRIPE_PRICE_PERSONAL_MONTHLY"),
    STRIPE_PRICE_PERSONAL_YEARLY: secret("STRIPE_PRICE_PERSONAL_YEARLY"),
    STRIPE_PRICE_DEPARTMENT_MONTHLY: secret("STRIPE_PRICE_DEPARTMENT_MONTHLY"),
    STRIPE_PRICE_DEPARTMENT_YEARLY: secret("STRIPE_PRICE_DEPARTMENT_YEARLY"),
    STRIPE_PRICE_ORGANIZATION_MONTHLY: secret("STRIPE_PRICE_ORGANIZATION_MONTHLY"),
    STRIPE_PRICE_ORGANIZATION_YEARLY: secret("STRIPE_PRICE_ORGANIZATION_YEARLY"),
    STRIPE_PRICE_SEAT_ADDON: secret("STRIPE_PRICE_SEAT_ADDON"),
  },
  
  layers: {
    "stripe": "stripe-layer:1"
  },
  
});
