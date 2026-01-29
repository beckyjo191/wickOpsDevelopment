import { defineFunction } from "@aws-amplify/backend";

// --- userSubscriptionCheck Lambda ---
export const userSubscriptionCheck = defineFunction({
  name: "userSubscriptionCheck",
  entry: "./src/handler.ts",
  environment: {
    ORG_TABLE: "ORG_TABLE",
    USER_TABLE: "USER_TABLE",
  },
});
