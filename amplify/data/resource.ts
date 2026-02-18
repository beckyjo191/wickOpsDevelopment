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

  }),
});
