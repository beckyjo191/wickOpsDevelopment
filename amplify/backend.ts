import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { createCheckoutSession } from "./functions/createCheckoutSession/resource";
import { stripeWebhook } from "./functions/stripeWebhook/resource";
import { userSubscriptionCheck } from "./functions/userSubscriptionCheck/resource";
import { sendInvites } from "./functions/sendInvites/resource";

defineBackend({
  auth,
  data,
  createCheckoutSession,
  stripeWebhook,
  userSubscriptionCheck,
  sendInvites,
});
