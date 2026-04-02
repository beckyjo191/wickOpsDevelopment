// ── Foundation: clients.ts ──────────────────────────────────────────────────
// AWS SDK client singletons extracted from handler.ts.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

export const rawDdb = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(rawDdb);
export const cognito = new CognitoIdentityProviderClient({});
