import { defineFunction } from "@aws-amplify/backend";

// --- userSubscriptionCheck Lambda ---
export const userSubscriptionCheck = defineFunction({
  name: "userSubscriptionCheck",
  entry: "./src/handler.ts",
  environment: {
    ORG_TABLE: "organization-p33a5aswtneufg7htwgzwivayu-NONE",
    USER_TABLE: "user-p33a5aswtneufg7htwgzwivayu-NONE",
  },
});
