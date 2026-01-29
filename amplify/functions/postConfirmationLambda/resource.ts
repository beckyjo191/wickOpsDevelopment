import { defineFunction } from '@aws-amplify/backend';

// --- PostConfirmation Lambda ---
export const postConfirmationLambda = defineFunction({
  name: 'postConfirmationLambda',
    entry: "./src/handler.ts",
environment: {
    ORG_TABLE: "organization-p33a5aswtneufg7htwgzwivayu-NONE",
    USER_TABLE: "user-p33a5aswtneufg7htwgzwivayu-NONE",
  },
});
