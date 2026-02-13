import { defineFunction, secret } from "@aws-amplify/backend";

export const sendInvites = defineFunction({
  name: "sendInvites",
  entry: "./src/handler.ts",
  environment: {
    ORG_TABLE: secret("ORG_TABLE"),
    USER_TABLE: secret("USER_TABLE"),
    INVITE_TABLE: secret("INVITE_TABLE"),
  },
});
