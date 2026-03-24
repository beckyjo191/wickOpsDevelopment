#!/usr/bin/env npx tsx
/**
 * Find orphaned per-org DynamoDB inventory tables.
 *
 * Lists all wickops-inventory-* tables, cross-references against the org table,
 * and reports which tables don't belong to any existing org.
 *
 * Usage:
 *   npx tsx scripts/find-orphaned-tables.ts --user-table <USER_TABLE> --org-table <ORG_TABLE> [--region <REGION>]
 *
 * Example:
 *   npx tsx scripts/find-orphaned-tables.ts \
 *     --user-table User-abc123-NONE \
 *     --org-table Organization-abc123-NONE
 */

import { createHash } from "node:crypto";
import {
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const INVENTORY_ORG_TABLE_PREFIX = "wickops-inventory";

function parseArgs() {
  const args = process.argv.slice(2);
  let userTable = "";
  let orgTable = "";
  let region = "us-east-1";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-table") userTable = args[++i];
    else if (args[i] === "--org-table") orgTable = args[++i];
    else if (args[i] === "--region") region = args[++i];
  }

  if (!userTable || !orgTable) {
    console.error("Usage: npx tsx scripts/find-orphaned-tables.ts --user-table <USER_TABLE> --org-table <ORG_TABLE> [--region <REGION>]");
    process.exit(1);
  }

  return { userTable, orgTable, region };
}

function buildNamespace(userTable: string): string {
  return createHash("sha256")
    .update(`${userTable}|${INVENTORY_ORG_TABLE_PREFIX}`)
    .digest("hex")
    .slice(0, 8);
}

function sanitizeOrgIdForTableName(organizationId: string): string {
  return (
    organizationId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "org"
  );
}

function buildExpectedTableNames(
  organizationId: string,
  namespace: string,
): string[] {
  const safeOrg = sanitizeOrgIdForTableName(organizationId);
  const hash = createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
  const base = `${INVENTORY_ORG_TABLE_PREFIX}-${namespace}-${safeOrg}-${hash}`;
  return [`${base}-columns`, `${base}-items`, `${base}-pending`];
}

async function listAllInventoryTables(client: DynamoDBClient): Promise<string[]> {
  const tables: string[] = [];
  let lastEvaluated: string | undefined;

  do {
    const res = await client.send(
      new ListTablesCommand({
        ExclusiveStartTableName: lastEvaluated,
        Limit: 100,
      }),
    );
    for (const name of res.TableNames ?? []) {
      if (name.startsWith(`${INVENTORY_ORG_TABLE_PREFIX}-`)) {
        tables.push(name);
      }
    }
    lastEvaluated = res.LastEvaluatedTableName;
  } while (lastEvaluated);

  return tables;
}

async function scanAllOrgIds(ddb: DynamoDBDocumentClient, orgTable: string): Promise<string[]> {
  const ids: string[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: orgTable,
        ProjectionExpression: "id",
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      if (item.id) ids.push(item.id as string);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return ids;
}

async function main() {
  const { userTable, orgTable, region } = parseArgs();
  const rawClient = new DynamoDBClient({ region });
  const ddb = DynamoDBDocumentClient.from(rawClient);

  const namespace = buildNamespace(userTable);
  console.log(`Namespace: ${namespace}`);
  console.log(`Table prefix: ${INVENTORY_ORG_TABLE_PREFIX}-${namespace}-*\n`);

  console.log("Scanning org table for all organization IDs...");
  const orgIds = await scanAllOrgIds(ddb, orgTable);
  console.log(`Found ${orgIds.length} org(s)\n`);

  const expectedTables = new Set<string>();
  for (const orgId of orgIds) {
    for (const name of buildExpectedTableNames(orgId, namespace)) {
      expectedTables.add(name);
    }
  }

  console.log("Listing all inventory tables in DynamoDB...");
  const allTables = await listAllInventoryTables(rawClient);
  console.log(`Found ${allTables.length} inventory table(s)\n`);

  // Filter to only tables matching our namespace
  const namespacedPrefix = `${INVENTORY_ORG_TABLE_PREFIX}-${namespace}-`;
  const relevantTables = allTables.filter((t) => t.startsWith(namespacedPrefix));
  const orphaned = relevantTables.filter((t) => !expectedTables.has(t));
  const matched = relevantTables.filter((t) => expectedTables.has(t));

  console.log(`Tables matching this namespace: ${relevantTables.length}`);
  console.log(`  Matched to an org: ${matched.length}`);
  console.log(`  Orphaned:          ${orphaned.length}\n`);

  if (orphaned.length > 0) {
    console.log("=== ORPHANED TABLES ===");
    for (const name of orphaned.sort()) {
      console.log(`  ${name}`);
    }
    console.log(
      `\nTo delete these tables, run:\n  aws dynamodb delete-table --table-name <TABLE_NAME> --region ${region}`,
    );
  } else {
    console.log("No orphaned tables found.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
