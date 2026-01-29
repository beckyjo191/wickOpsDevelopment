import { defineFunction } from '@aws-amplify/backend';

// --- PostConfirmation Lambda ---
export const postConfirmationLambda = defineFunction({
  name: 'postConfirmationLambda',
    entry: "./src/handler.ts",
environment: {
    ORG_TABLE: "ORG_TABLE",
    USER_TABLE: "USER_TABLE",
  },
});
