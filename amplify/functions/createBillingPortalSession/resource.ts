import { defineFunction, secret } from "@aws-amplify/backend";

export const createBillingPortalSession = defineFunction({
  name: "createBillingPortalSession",
  entry: "./src/handler.ts",
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    FRONTEND_URL: secret("FRONTEND_URL"),
  },
});
