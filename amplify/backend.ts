import { defineBackend } from "@aws-amplify/backend";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { createCheckoutSession } from "./functions/createCheckoutSession/resource";
import { stripeWebhook } from "./functions/stripeWebhook/resource";
import { userSubscriptionCheck } from "./functions/userSubscriptionCheck/resource";
import { sendInvites } from "./functions/sendInvites/resource";
import { inventoryApi } from "./functions/inventoryApi/resource";
import { createBillingPortalSession } from "./functions/createBillingPortalSession/resource";

const backend = defineBackend({
  auth,
  data,
  createCheckoutSession,
  stripeWebhook,
  userSubscriptionCheck,
  sendInvites,
  inventoryApi,
  createBillingPortalSession,
});

const deploymentEnv = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();
const corsAllowedOrigins =
  deploymentEnv === "prod" || deploymentEnv === "production"
    ? ["https://systems.wickops.com"]
    : ["http://localhost:5173"];
const corsAllowedHeaders = ["Authorization", "Content-Type"];
const browserCorsMethods = [
  CorsHttpMethod.GET,
  CorsHttpMethod.POST,
  CorsHttpMethod.DELETE,
  CorsHttpMethod.OPTIONS,
];
const createAuthenticatedHttpApi = (stackName: string, id: string) =>
  new HttpApi(backend.createStack(stackName), id, {
    corsPreflight: {
      allowOrigins: corsAllowedOrigins,
      allowHeaders: corsAllowedHeaders,
      allowMethods: browserCorsMethods,
    },
  });

const inventoryHttpApi = createAuthenticatedHttpApi("inventory-api-gateway", "InventoryHttpApi");
const coreHttpApi = createAuthenticatedHttpApi("core-api-gateway", "CoreHttpApi");
const invitesHttpApi = createAuthenticatedHttpApi("invites-api-gateway", "InvitesHttpApi");
const billingWebhookHttpApi = new HttpApi(
  backend.createStack("billing-webhook-api-gateway"),
  "BillingWebhookHttpApi",
);

const createUserPoolAuthorizer = (id: string) =>
  new HttpUserPoolAuthorizer(id, backend.auth.resources.userPool, {
    userPoolClients: [backend.auth.resources.userPoolClient],
  });
const inventoryAuthorizer = createUserPoolAuthorizer("InventoryUserPoolAuthorizer");
const coreAuthorizer = createUserPoolAuthorizer("CoreUserPoolAuthorizer");
const invitesAuthorizer = createUserPoolAuthorizer("InvitesUserPoolAuthorizer");

const inventoryLambdaIntegration = new HttpLambdaIntegration(
  "InventoryLambdaIntegration",
  backend.inventoryApi.resources.lambda,
);
const userSubscriptionIntegration = new HttpLambdaIntegration(
  "UserSubscriptionIntegration",
  backend.userSubscriptionCheck.resources.lambda,
);
const createCheckoutSessionIntegration = new HttpLambdaIntegration(
  "CreateCheckoutSessionIntegration",
  backend.createCheckoutSession.resources.lambda,
);
const sendInvitesIntegration = new HttpLambdaIntegration(
  "SendInvitesIntegration",
  backend.sendInvites.resources.lambda,
);
const stripeWebhookIntegration = new HttpLambdaIntegration(
  "StripeWebhookIntegration",
  backend.stripeWebhook.resources.lambda,
);
const createBillingPortalSessionIntegration = new HttpLambdaIntegration(
  "CreateBillingPortalSessionIntegration",
  backend.createBillingPortalSession.resources.lambda,
);

const addInventoryRoute = (path: string, methods: HttpMethod[]) => {
  inventoryHttpApi.addRoutes({
    path,
    methods,
    integration: inventoryLambdaIntegration,
    authorizer: inventoryAuthorizer,
  });
};

addInventoryRoute("/inventory/org-modules", [HttpMethod.GET, HttpMethod.POST]);
addInventoryRoute("/inventory/module-access/users", [HttpMethod.GET]);
addInventoryRoute("/inventory/module-access/users/{userId}", [HttpMethod.POST]);
addInventoryRoute("/inventory/profile/display-name", [HttpMethod.POST]);
addInventoryRoute("/inventory/profile/email/sync", [HttpMethod.POST]);
addInventoryRoute("/inventory/bootstrap", [HttpMethod.GET]);
addInventoryRoute("/inventory/items", [HttpMethod.GET]);
addInventoryRoute("/inventory/items/save", [HttpMethod.POST]);
addInventoryRoute("/inventory/usage/submit", [HttpMethod.POST]);
addInventoryRoute("/inventory/import-csv", [HttpMethod.POST]);
addInventoryRoute("/inventory/columns", [HttpMethod.POST]);
addInventoryRoute("/inventory/columns/{columnId}/visibility", [HttpMethod.POST]);
addInventoryRoute("/inventory/columns/{columnId}/label", [HttpMethod.POST]);
addInventoryRoute("/inventory/columns/{columnId}", [HttpMethod.DELETE]);
addInventoryRoute("/inventory/organization-storage", [HttpMethod.DELETE]);

coreHttpApi.addRoutes({
  path: "/user-subscription",
  methods: [HttpMethod.GET],
  integration: userSubscriptionIntegration,
  authorizer: coreAuthorizer,
});
coreHttpApi.addRoutes({
  path: "/create-checkout-session",
  methods: [HttpMethod.POST],
  integration: createCheckoutSessionIntegration,
  authorizer: coreAuthorizer,
});
coreHttpApi.addRoutes({
  path: "/create-portal-session",
  methods: [HttpMethod.POST],
  integration: createBillingPortalSessionIntegration,
  authorizer: coreAuthorizer,
});

invitesHttpApi.addRoutes({
  path: "/send-invites",
  methods: [HttpMethod.POST],
  integration: sendInvitesIntegration,
  authorizer: invitesAuthorizer,
});

billingWebhookHttpApi.addRoutes({
  path: "/stripe-webhook",
  methods: [HttpMethod.POST],
  integration: stripeWebhookIntegration,
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
const userSubscriptionLambda = backend.userSubscriptionCheck.resources.lambda as any;
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
const organizationTable = (backend.data.resources as any)?.tables?.organization;
const inviteTable = (backend.data.resources as any)?.tables?.invite;

if (userTable) {
  inventoryApiLambda.addEnvironment("USER_TABLE", userTable.tableName);
  userTable.grantReadData(backend.inventoryApi.resources.lambda);
}

// inventoryApi needs read-write on the org table for getAccessContext (two-layer module
// access) and the new org-module management endpoints.
if (organizationTable) {
  inventoryApiLambda.addEnvironment("ORG_TABLE", organizationTable.tableName);
  organizationTable.grantReadWriteData(backend.inventoryApi.resources.lambda);
}

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
userSubscriptionLambda.addEnvironment(
  "INVENTORY_ORG_TABLE_PREFIX",
  inventoryOrgTablePrefix,
);
userSubscriptionLambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "dynamodb:CreateTable",
      "dynamodb:DescribeTable",
    ],
    resources: [inventoryDynamicTableArn, `${inventoryDynamicTableArn}/index/*`],
  }),
);

wireCoreDataTables(backend.sendInvites.resources.lambda, {
  user: "read",
  organization: "read",
  invite: "readwrite",
});
const userPool = (backend.auth.resources as any)?.userPool;
if (userPool) {
  backend.sendInvites.resources.lambda.addToRolePolicy(
    new PolicyStatement({
      actions: ["cognito-idp:AdminCreateUser"],
      resources: [userPool.userPoolArn],
    }),
  );
}

wireCoreDataTables(backend.createCheckoutSession.resources.lambda, {
  user: "read",
  organization: "readwrite",
});

wireCoreDataTables(backend.createBillingPortalSession.resources.lambda, {
  user: "read",
  organization: "read",
});

wireCoreDataTables(backend.stripeWebhook.resources.lambda, {
  user: "write",
  organization: "write",
});

// Forward Stripe price IDs (monthly + yearly for each plan) to the Lambdas that need them.
// These are set in the build environment and are safe to embed (price IDs are public).
const PRICE_ENV_KEYS = [
  "STRIPE_PRICE_PERSONAL_MONTHLY",
  "STRIPE_PRICE_PERSONAL_YEARLY",
  "STRIPE_PRICE_DEPARTMENT_MONTHLY",
  "STRIPE_PRICE_DEPARTMENT_YEARLY",
  "STRIPE_PRICE_ORGANIZATION_MONTHLY",
  "STRIPE_PRICE_ORGANIZATION_YEARLY",
] as const;

for (const key of PRICE_ENV_KEYS) {
  const val = process.env[key];
  // Only call addEnvironment when the value is present at CDK synthesis time.
  // If omitted, the secret() bindings in each function's resource.ts take effect.
  // Passing an empty string would silently overwrite those secret references.
  if (val) {
    (backend.stripeWebhook.resources.lambda as any).addEnvironment(key, val);
    (backend.createCheckoutSession.resources.lambda as any).addEnvironment(key, val);
  }
}

// Seat add-on price (users buy via Stripe Customer Portal to add seats beyond the base plan)
(backend.stripeWebhook.resources.lambda as any).addEnvironment(
  "STRIPE_PRICE_SEAT_ADDON",
  process.env.STRIPE_PRICE_SEAT_ADDON ?? "",
);
