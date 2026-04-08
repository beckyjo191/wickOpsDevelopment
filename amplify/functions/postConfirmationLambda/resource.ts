import { defineFunction } from "@aws-amplify/backend";

// --- PostConfirmation Lambda ---
// Table names + IAM permissions are wired in backend.ts via wireCoreDataTables.
export const postConfirmationLambda = defineFunction({
  name: "postConfirmationLambda",
  entry: "./src/handler.ts",
  resourceGroupName: "auth",
});
