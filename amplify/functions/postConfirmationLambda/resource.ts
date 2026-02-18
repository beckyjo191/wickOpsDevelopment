import { defineFunction, secret } from "@aws-amplify/backend";

// --- PostConfirmation Lambda ---
export const postConfirmationLambda = defineFunction({
  name: "postConfirmationLambda",
  entry: "./src/handler.ts",
  resourceGroupName: "auth",
  environment: {
    ORG_TABLE: secret("ORG_TABLE"),
    USER_TABLE: secret("USER_TABLE"),
    INVITE_TABLE: secret("INVITE_TABLE"),
  },
});
