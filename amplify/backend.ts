import { defineBackend } from "@aws-amplify/backend";
import { CustomResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { createCheckoutSession } from "./functions/createCheckoutSession/resource";
import { stripeWebhook } from "./functions/stripeWebhook/resource";
import { userSubscriptionCheck } from "./functions/userSubscriptionCheck/resource";
import { sendInvites } from "./functions/sendInvites/resource";
import { inventoryApi } from "./functions/inventoryApi/resource";
import { createBillingPortalSession } from "./functions/createBillingPortalSession/resource";
import { postConfirmationLambda } from "./functions/postConfirmationLambda/resource";

const backend = defineBackend({
  auth,
  data,
  createCheckoutSession,
  stripeWebhook,
  userSubscriptionCheck,
  sendInvites,
  inventoryApi,
  createBillingPortalSession,
  postConfirmationLambda,
});

const deploymentEnv = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();
const deployedBranch = process.env.AWS_BRANCH ?? process.env.AMPLIFY_BRANCH ?? "";
const isDeployed = deployedBranch !== "" || deploymentEnv === "prod" || deploymentEnv === "production";
const corsAllowedOrigins = isDeployed
  ? ["https://systems.wickops.com", "http://localhost:5173"]
  : ["http://localhost:5173"];
const corsAllowedHeaders = ["Authorization", "Content-Type"];
const browserCorsMethods = [
  CorsHttpMethod.GET,
  CorsHttpMethod.POST,
  CorsHttpMethod.DELETE,
  CorsHttpMethod.OPTIONS,
];
// All functions use resourceGroupName: "data", so colocate API gateways in the
// same stack to avoid cross-stack Lambda integration permissions (which cause
// CloudFormation circular dependencies between nested stacks).
const apiStack = Stack.of(backend.inventoryApi.resources.lambda);

const createHttpApiWithCors = (id: string) =>
  new HttpApi(apiStack, id, {
    corsPreflight: {
      allowOrigins: corsAllowedOrigins,
      allowHeaders: corsAllowedHeaders,
      allowMethods: browserCorsMethods,
    },
  });

const inventoryHttpApi = createHttpApiWithCors("InventoryHttpApi");
const coreHttpApi = createHttpApiWithCors("CoreHttpApi");
const invitesHttpApi = createHttpApiWithCors("InvitesHttpApi");
const billingWebhookHttpApi = new HttpApi(apiStack, "BillingWebhookHttpApi");

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

// Two catch-all proxy routes replace 34+ per-route registrations.
// The Lambda already handles routing internally via event.rawPath, so API Gateway
// only needs to know where to forward requests — not which specific paths exist.
// This keeps the Lambda resource-based policy at 2 statements instead of 34+,
// permanently staying under the 20KB AWS limit regardless of future endpoints added.
// Use explicit methods instead of ANY so that OPTIONS preflight requests
// are handled by API Gateway's built-in CORS handler (corsPreflight config above)
// rather than hitting the Cognito authorizer (which rejects unauthenticated OPTIONS with 401).
const inventoryMethods = [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE];
inventoryHttpApi.addRoutes({
  path: "/{proxy+}",
  methods: inventoryMethods,
  integration: inventoryLambdaIntegration,
  authorizer: inventoryAuthorizer,
});

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
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
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

const userTable = (backend.data.resources as any)?.tables?.user;
const organizationTable = (backend.data.resources as any)?.tables?.organization;
const inviteTable = (backend.data.resources as any)?.tables?.invite;

if (userTable) {
  inventoryApiLambda.addEnvironment("USER_TABLE", userTable.tableName);
}
if (organizationTable) {
  inventoryApiLambda.addEnvironment("ORG_TABLE", organizationTable.tableName);
}

const inventoryApiStack = Stack.of(inventoryApiLambda);
const inventoryDynamicTableArn = `arn:aws:dynamodb:${inventoryApiStack.region}:${inventoryApiStack.account}:table/${inventoryOrgTablePrefix}-*`;

// Split into two least-privilege policies to stay under the 20KB limit:
// 1) CRUD on all tables this Lambda touches (static + dynamic)
const crudResources: string[] = [
  inventoryColumnTable.tableArn, `${inventoryColumnTable.tableArn}/index/*`,
  inventoryItemTable.tableArn, `${inventoryItemTable.tableArn}/index/*`,
  inventoryDynamicTableArn, `${inventoryDynamicTableArn}/index/*`,
];
if (userTable) crudResources.push(userTable.tableArn, `${userTable.tableArn}/index/*`);
if (organizationTable) crudResources.push(organizationTable.tableArn, `${organizationTable.tableArn}/index/*`);

inventoryApiLambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:Batch*",
    ],
    resources: crudResources,
  }),
);

// 2) Table management — only on dynamic per-org tables (not user/org/static tables)
inventoryApiLambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable",
      "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateTimeToLive",
    ],
    resources: [inventoryDynamicTableArn],
  }),
);

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
  inventoryApiLambda.addEnvironment("USER_POOL_ID", userPool.userPoolId);
  (backend.sendInvites.resources.lambda as any).addEnvironment("USER_POOL_ID", userPool.userPoolId);
  // Cognito permissions for inventoryApi (user revocation)
  inventoryApiLambda.addToRolePolicy(
    new PolicyStatement({
      actions: ["cognito-idp:AdminDisableUser", "cognito-idp:AdminUserGlobalSignOut"],
      resources: [userPool.userPoolArn],
    }),
  );
}

// Customize the invite email Cognito sends when AdminCreateUser is called.
// Using cfnResources override because defineAuth's userInvitation gets silently
// dropped during CDK synthesis (aws-cdk #30315).
const { cfnUserPool } = backend.auth.resources.cfnResources;

// Ensure email auto-verification is set (required when AttributesRequireVerificationBeforeUpdate
// includes email — Cognito rejects updates if AutoVerifiedAttributes is missing the attribute).
cfnUserPool.autoVerifiedAttributes = ["email"];

cfnUserPool.adminCreateUserConfig = {
  ...cfnUserPool.adminCreateUserConfig as any,
  inviteMessageTemplate: {
    emailSubject: "You've been invited to WickOps",
    emailMessage:
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">' +
      '<div style="text-align:center;padding:20px 0;border-bottom:2px solid #2472B1">' +
      '<h1 style="color:#2472B1;margin:0;font-size:28px">WickOps</h1>' +
      "</div>" +
      '<div style="padding:30px 0">' +
      '<h2 style="color:#333;margin-top:0">You\'re invited!</h2>' +
      '<p style="color:#555;font-size:16px;line-height:1.5">' +
      "A team member has invited you to join their organization on WickOps." +
      "</p>" +
      '<p style="color:#555;font-size:16px;line-height:1.5">Your login credentials are:</p>' +
      '<div style="background:#f5f5f5;border-radius:8px;padding:15px 20px;margin:20px 0">' +
      '<p style="margin:5px 0;font-size:15px"><strong>Email:</strong> {username}</p>' +
      '<p style="margin:5px 0;font-size:15px"><strong>Temporary Password:</strong> {####}</p>' +
      "</div>" +
      '<p style="color:#555;font-size:16px;line-height:1.5">' +
      "Click the button below to sign in. You'll be asked to set a new password on your first login." +
      "</p>" +
      '<div style="text-align:center;margin:30px 0">' +
      '<a href="https://systems.wickops.com" style="background:#2472B1;color:#ffffff;padding:12px 30px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold">Sign In to WickOps</a>' +
      "</div>" +
      "</div>" +
      '<div style="border-top:1px solid #eee;padding-top:15px;text-align:center">' +
      '<p style="color:#999;font-size:13px">' +
      "This is an automated message from WickOps. If you did not expect this invitation, you can safely ignore this email." +
      "</p>" +
      "</div>" +
      "</div>",
  },
};

// ── Post-confirmation trigger wiring ────────────────────────────────────────
// The trigger is set up in a dedicated "wiring" stack instead of defineAuth's
// triggers property.  This avoids the auth ↔ data circular dependency:
//   • data → auth  (allow.authenticated in defineData)
//   • auth → data  (trigger referencing a data-stack Lambda)   ← eliminated
// The wiring stack depends on both auth and data (one-way each), breaking the cycle.
const wiringStack = backend.createStack("wiring");
const postConfirmLambda = backend.postConfirmationLambda.resources.lambda;
const userPoolForTrigger = backend.auth.resources.userPool;

// Allow Cognito to invoke the Lambda
postConfirmLambda.addPermission("CognitoPostConfirmInvoke", {
  principal: new ServicePrincipal("cognito-idp.amazonaws.com"),
  sourceArn: userPoolForTrigger.userPoolArn,
});

// Custom resource Lambda that calls UpdateUserPool to set the trigger.
// UpdateUserPool resets any field not explicitly included, so we must
// pass through all critical settings from DescribeUserPool.
const triggerSetterFn = new LambdaFunction(wiringStack, "TriggerSetterFn", {
  runtime: Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: Code.fromInline(`
const { CognitoIdentityProviderClient, DescribeUserPoolCommand, UpdateUserPoolCommand } = require("@aws-sdk/client-cognito-identity-provider");

// Build an UpdateUserPool params object that preserves all existing settings.
function buildUpdateParams(pool, overrideLambdaConfig) {
  return {
    UserPoolId: pool.Id,
    LambdaConfig: overrideLambdaConfig,
    // Preserve settings that UpdateUserPool resets if omitted
    AutoVerifiedAttributes: pool.AutoVerifiedAttributes || [],
    Policies: pool.Policies,
    AdminCreateUserConfig: pool.AdminCreateUserConfig,
    UserPoolAddOns: pool.UserPoolAddOns,
    AccountRecoverySetting: pool.AccountRecoverySetting,
    VerificationMessageTemplate: pool.VerificationMessageTemplate,
    MfaConfiguration: pool.MfaConfiguration || "OFF",
    UserAttributeUpdateSettings: pool.UserAttributeUpdateSettings,
  };
}

exports.handler = async (event) => {
  const props = event.ResourceProperties;
  const client = new CognitoIdentityProviderClient({});
  const desc = await client.send(new DescribeUserPoolCommand({ UserPoolId: props.UserPoolId }));
  const pool = desc.UserPool;
  const lambdaCfg = { ...(pool.LambdaConfig || {}) };

  if (event.RequestType === "Delete") {
    delete lambdaCfg.PostConfirmation;
  } else {
    lambdaCfg.PostConfirmation = props.LambdaArn;
  }

  await client.send(new UpdateUserPoolCommand(buildUpdateParams(pool, lambdaCfg)));
  return { PhysicalResourceId: "postconfirm-trigger" };
};
  `),
});
triggerSetterFn.addToRolePolicy(
  new PolicyStatement({
    actions: ["cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool"],
    resources: [userPoolForTrigger.userPoolArn],
  }),
);
const triggerProvider = new Provider(wiringStack, "TriggerProvider", {
  onEventHandler: triggerSetterFn,
});
new CustomResource(wiringStack, "PostConfirmTrigger", {
  serviceToken: triggerProvider.serviceToken,
  properties: {
    UserPoolId: userPoolForTrigger.userPoolId,
    LambdaArn: postConfirmLambda.functionArn,
  },
});

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

wireCoreDataTables(backend.postConfirmationLambda.resources.lambda, {
  user: "readwrite",
  organization: "readwrite",
  invite: "readwrite",
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
