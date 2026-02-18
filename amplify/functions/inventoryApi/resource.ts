import { defineFunction } from "@aws-amplify/backend";

export const inventoryApi = defineFunction({
  name: "inventoryApi",
  entry: "./src/handler.ts",
  resourceGroupName: "data",
});
