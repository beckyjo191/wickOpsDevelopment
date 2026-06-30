import { defineAuth } from "@aws-amplify/backend";

export const auth = defineAuth({
  loginWith: {
    email: true,
  },

  // PLATFORM_SUPPORT: WickOps staff who can read a customer org's data for
  // troubleshooting — but ONLY while that org has a live, time-boxed support
  // grant (see supportAccessGrant). Membership is checked server-side from the
  // signed `cognito:groups` claim, so a normal user can never self-assign it.
  // Add operators to this group via the Cognito console / AdminAddUserToGroup.
  groups: ["PLATFORM_SUPPORT"],

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
