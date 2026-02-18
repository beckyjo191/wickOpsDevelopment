import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { createCheckoutSession } from "./functions/createCheckoutSession/resource";
import { stripeWebhook } from "./functions/stripeWebhook/resource";
import { userSubscriptionCheck } from "./functions/userSubscriptionCheck/resource";
import { sendInvites } from "./functions/sendInvites/resource";
import { inventoryApi } from "./functions/inventoryApi/resource";

const backend = defineBackend({
  auth,
  data,
  createCheckoutSession,
  stripeWebhook,
  userSubscriptionCheck,
  sendInvites,
  inventoryApi,
});

const inventoryStack = backend.createStack("inventory-storage");
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";

const inventoryColumnTable = new Table(inventoryStack, "InventoryColumnTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const inventoryItemTable = new Table(inventoryStack, "InventoryItemTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const inventoryApiLambda = backend.inventoryApi.resources.lambda as any;

inventoryApiLambda.addEnvironment(
  "INVENTORY_COLUMN_TABLE",
  inventoryColumnTable.tableName,
);
inventoryApiLambda.addEnvironment(
  "INVENTORY_ITEM_TABLE",
  inventoryItemTable.tableName,
);

inventoryColumnTable.grantReadWriteData(backend.inventoryApi.resources.lambda);
inventoryItemTable.grantReadWriteData(backend.inventoryApi.resources.lambda);

const userTable = (backend.data.resources as any)?.tables?.user;
if (userTable) {
  inventoryApiLambda.addEnvironment("USER_TABLE", userTable.tableName);
  userTable.grantReadData(backend.inventoryApi.resources.lambda);
}

const organizationTable = (backend.data.resources as any)?.tables?.organization;
const inviteTable = (backend.data.resources as any)?.tables?.invite;

const wireCoreDataTables = (
  fn: any,
  access: {
    user?: "read" | "write" | "readwrite";
    organization?: "read" | "write" | "readwrite";
    invite?: "read" | "write" | "readwrite";
  },
) => {
  const grant = (table: any, mode: "read" | "write" | "readwrite" | undefined) => {
    if (!table || !mode) return;
    if (mode === "read") table.grantReadData(fn);
    if (mode === "write") table.grantWriteData(fn);
    if (mode === "readwrite") table.grantReadWriteData(fn);
  };

  if (userTable) {
    fn.addEnvironment("USER_TABLE", userTable.tableName);
    grant(userTable, access.user);
  }
  if (organizationTable) {
    fn.addEnvironment("ORG_TABLE", organizationTable.tableName);
    grant(organizationTable, access.organization);
  }
  if (inviteTable) {
    fn.addEnvironment("INVITE_TABLE", inviteTable.tableName);
    grant(inviteTable, access.invite);
  }
};

wireCoreDataTables(backend.userSubscriptionCheck.resources.lambda, {
  user: "readwrite",
  organization: "readwrite",
  invite: "readwrite",
});

wireCoreDataTables(backend.sendInvites.resources.lambda, {
  user: "read",
  organization: "read",
  invite: "readwrite",
});

wireCoreDataTables(backend.createCheckoutSession.resources.lambda, {
  user: "read",
  organization: "readwrite",
});

wireCoreDataTables(backend.stripeWebhook.resources.lambda, {
  user: "write",
  organization: "write",
});

(backend.createCheckoutSession.resources.lambda as any).addEnvironment(
  "FRONTEND_URL",
  frontendUrl,
);
