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
  }),
});
