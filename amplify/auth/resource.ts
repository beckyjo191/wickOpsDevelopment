import { defineAuth } from "@aws-amplify/backend";

export const auth = defineAuth({
  loginWith: {
    email: true,
  },

  userAttributes: {
    email: {
      required: true,
      mutable: true,
    },

    "custom:organizationName": {
      dataType: "String",
      mutable: false,
      maxLen: 100,
    },
  },
});
