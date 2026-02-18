import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
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

const inventoryColumnTable = new Table(inventoryStack, "InventoryColumnTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
inventoryColumnTable.addGlobalSecondaryIndex({
  indexName: "ByOrganizationSortOrder",
  partitionKey: { name: "organizationId", type: AttributeType.STRING },
  sortKey: { name: "sortOrder", type: AttributeType.NUMBER },
});

const inventoryItemTable = new Table(inventoryStack, "InventoryItemTable", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  pointInTimeRecovery: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
inventoryItemTable.addGlobalSecondaryIndex({
  indexName: "ByOrganizationPosition",
  partitionKey: { name: "organizationId", type: AttributeType.STRING },
  sortKey: { name: "position", type: AttributeType.NUMBER },
});

const inventoryApiLambda = backend.inventoryApi.resources.lambda as any;
const inventoryOrgTablePrefix = "wickops-inventory";

inventoryApiLambda.addEnvironment(
  "INVENTORY_COLUMN_TABLE",
  inventoryColumnTable.tableName,
);
inventoryApiLambda.addEnvironment(
  "INVENTORY_ITEM_TABLE",
  inventoryItemTable.tableName,
);
inventoryApiLambda.addEnvironment("ENABLE_PER_ORG_INVENTORY_TABLES", "true");
inventoryApiLambda.addEnvironment("INVENTORY_ORG_TABLE_PREFIX", inventoryOrgTablePrefix);

inventoryColumnTable.grantReadWriteData(backend.inventoryApi.resources.lambda);
inventoryItemTable.grantReadWriteData(backend.inventoryApi.resources.lambda);

const inventoryApiStack = Stack.of(inventoryApiLambda);
const inventoryDynamicTableArn = `arn:aws:dynamodb:${inventoryApiStack.region}:${inventoryApiStack.account}:table/${inventoryOrgTablePrefix}-*`;
inventoryApiLambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "dynamodb:CreateTable",
      "dynamodb:DeleteTable",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
    ],
    resources: [inventoryDynamicTableArn, `${inventoryDynamicTableArn}/index/*`],
  }),
);

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
