import { defineData, a } from '@aws-amplify/backend';

export const data = defineData({
  schema: a.schema({
    organization: a
  .model({
    id: a.id(),
    name: a.string().required(),
    seatLimit: a.integer().required(),
    seatsUsed: a.integer().required(),
    plan: a.string().required(),
    paymentStatus: a.string().required(), // Paid | Unpaid
    createdAt: a.datetime().required(),
    // Modules the org owner has activated from their plan's available pool.
    // null/absent = all plan-available modules enabled (backward-compat default).
    enabledModules: a.string().array(),
    // Mirrors Stripe subscription.cancel_at_period_end so the UI can show a
    // pending-cancellation countdown and userSubscriptionCheck can self-heal
    // a missed customer.subscription.deleted webhook.
    cancelAtPeriodEnd: a.boolean(),
    currentPeriodEnd: a.integer(), // Unix seconds (matches Stripe)
  })
  .authorization((allow) => [allow.authenticated()]),

    user: a
  .model({
    id: a.id(),                         // PK = email
    organizationId: a.id().required(),
    email: a.string().required(),
    role: a.string().required(),        // ADMIN | MEMBER
    accessSuspended: a.boolean().required(),
    createdAt: a.datetime().required(),
  })
  .authorization((allow) => [allow.authenticated()]),

    invite: a
  .model({
    id: a.id(),
    email: a.string().required(),
    organizationId: a.id().required(),
    role: a.string().required(),        // ADMIN | EDITOR | VIEWER
    status: a.string().required(),      // PENDING | ACCEPTED | REVOKED
    invitedBy: a.id().required(),
    createdAt: a.datetime().required(),
    expiresAt: a.datetime(),
    acceptedAt: a.datetime(),
  })
  .authorization((allow) => [allow.authenticated()]),

    // Consent record for time-boxed WickOps platform-support read access.
    // One row per org (PK = organizationId): re-granting overwrites. The org
    // OWNER creates/revokes it; the inventoryApi Lambda checks for a live,
    // unexpired grant before letting a PLATFORM_SUPPORT operator read the org's
    // data. This row IS the consent + audit artifact (who authorized, when, for
    // how long, last accessed) — keep it indefinitely (no TTL).
    supportAccessGrant: a
  .model({
    id: a.id(),                         // PK = organizationId
    organizationId: a.id().required(),
    status: a.string().required(),      // active | revoked
    scope: a.string().array(),          // e.g. ["inventory:read"]
    grantedByUserId: a.id().required(),
    grantedByEmail: a.string().required(),
    grantedAt: a.datetime().required(),
    expiresAt: a.datetime().required(), // time-box — read access dies at this instant
    lastAccessedAt: a.datetime(),       // bumped when a support operator reads
    revokedAt: a.datetime(),
    revokedByUserId: a.id(),
  })
  .authorization((allow) => [allow.authenticated()]),

  }),
});
