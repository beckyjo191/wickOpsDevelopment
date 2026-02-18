import { defineFunction } from "@aws-amplify/backend";

export const sendInvites = defineFunction({
  name: "sendInvites",
  entry: "./src/handler.ts",
});
