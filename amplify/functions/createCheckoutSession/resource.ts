import { defineFunction, secret } from "@aws-amplify/backend";

export const createCheckoutSession = defineFunction({
  name: "createCheckoutSession",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    FRONTEND_URL: secret("FRONTEND_URL"),
    STRIPE_PRICE_PERSONAL_MONTHLY: secret("STRIPE_PRICE_PERSONAL_MONTHLY"),
    STRIPE_PRICE_PERSONAL_YEARLY: secret("STRIPE_PRICE_PERSONAL_YEARLY"),
    STRIPE_PRICE_DEPARTMENT_MONTHLY: secret("STRIPE_PRICE_DEPARTMENT_MONTHLY"),
    STRIPE_PRICE_DEPARTMENT_YEARLY: secret("STRIPE_PRICE_DEPARTMENT_YEARLY"),
    STRIPE_PRICE_ORGANIZATION_MONTHLY: secret("STRIPE_PRICE_ORGANIZATION_MONTHLY"),
    STRIPE_PRICE_ORGANIZATION_YEARLY: secret("STRIPE_PRICE_ORGANIZATION_YEARLY"),
  },
  layers: {
    "stripe": "stripe-layer:1"
  },
});
