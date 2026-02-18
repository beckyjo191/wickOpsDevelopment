#!/usr/bin/env node

import {
  BillingMode,
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

const INVENTORY_COLUMN_BY_ORG_INDEX = "ByOrganizationSortOrder";
const INVENTORY_ITEM_BY_ORG_INDEX = "ByOrganizationPosition";
const INVENTORY_COLUMN_BY_MODULE_INDEX = "ByModuleSortOrder";
const INVENTORY_ITEM_BY_MODULE_INDEX = "ByModulePosition";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
    out[key] = value;
    if (value !== "true") i += 1;
  }
  return out;
};

const args = parseArgs();

const region = args.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-2";
const orgTable = args["org-table"] || process.env.ORG_TABLE;
const sharedColumnTable = args["shared-column-table"] || process.env.INVENTORY_COLUMN_TABLE;
const sharedItemTable = args["shared-item-table"] || process.env.INVENTORY_ITEM_TABLE;
const prefix = args.prefix || process.env.INVENTORY_ORG_TABLE_PREFIX || "wickops-inventory";
const dryRun = String(args["dry-run"] || "false").toLowerCase() === "true";

if (!orgTable || !sharedColumnTable || !sharedItemTable) {
  console.error(
    "Missing required table names. Provide --org-table, --shared-column-table, --shared-item-table (or env vars ORG_TABLE, INVENTORY_COLUMN_TABLE, INVENTORY_ITEM_TABLE).",
  );
  process.exit(1);
}

const rawDdb = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(rawDdb);

const sanitizeOrgIdForTableName = (organizationId) =>
  organizationId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "org";

const buildOrgScopedTableName = (organizationId, suffix) => {
  const safeOrg = sanitizeOrgIdForTableName(organizationId);
  const hash = createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
  return `${prefix}-${safeOrg}-${hash}-${suffix}`;
};

const sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const describeTable = async (tableName) => {
  try {
    return await rawDdb.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err) {
    if (err?.name === "ResourceNotFoundException") return null;
    throw err;
  }
};

const waitForTableActive = async (tableName) => {
  for (let i = 0; i < 30; i += 1) {
    const result = await describeTable(tableName);
    if (result?.Table?.TableStatus === "ACTIVE") return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ACTIVE table: ${tableName}`);
};

const ensureOrgTable = async (tableName, gsiName, gsiSortKey) => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      await waitForTableActive(tableName);
    }
    return false;
  }
  if (dryRun) {
    console.log(`[dry-run] create table ${tableName}`);
    return true;
  }

  await rawDdb.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: BillingMode.PAY_PER_REQUEST,
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: ScalarAttributeType.S },
        { AttributeName: "module", AttributeType: ScalarAttributeType.S },
        { AttributeName: gsiSortKey, AttributeType: ScalarAttributeType.N },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
      GlobalSecondaryIndexes: [
        {
          IndexName: gsiName,
          KeySchema: [
            { AttributeName: "module", KeyType: KeyType.HASH },
            { AttributeName: gsiSortKey, KeyType: KeyType.RANGE },
          ],
          Projection: { ProjectionType: ProjectionType.ALL },
        },
      ],
    }),
  );
  await waitForTableActive(tableName);
  return true;
};

const listOrganizations = async () => {
  const ids = [];
  let lastEvaluatedKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: orgTable,
        ProjectionExpression: "id",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const id = String(item.id ?? "").trim();
      if (id) ids.push(id);
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return ids;
};

const queryOrgRows = async (tableName, indexName, organizationId) => {
  const rows = [];
  let lastEvaluatedKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: "organizationId = :org",
        ExpressionAttributeValues: { ":org": organizationId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    rows.push(...(page.Items ?? []));
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return rows.filter((row) => String(row.module ?? "") === "inventory");
};

const migrateOrg = async (organizationId) => {
  const columnTable = buildOrgScopedTableName(organizationId, "columns");
  const itemTable = buildOrgScopedTableName(organizationId, "items");

  const createdColumns = await ensureOrgTable(
    columnTable,
    INVENTORY_COLUMN_BY_MODULE_INDEX,
    "sortOrder",
  );
  const createdItems = await ensureOrgTable(itemTable, INVENTORY_ITEM_BY_MODULE_INDEX, "position");

  const rowsColumns = await queryOrgRows(
    sharedColumnTable,
    INVENTORY_COLUMN_BY_ORG_INDEX,
    organizationId,
  );
  const rowsItems = await queryOrgRows(sharedItemTable, INVENTORY_ITEM_BY_ORG_INDEX, organizationId);

  if (dryRun) {
    console.log(
      `[dry-run] org=${organizationId} tables=${columnTable},${itemTable} createFlags=${createdColumns}/${createdItems} rows=${rowsColumns.length}/${rowsItems.length}`,
    );
    return;
  }

  for (const row of rowsColumns) {
    await ddb.send(new PutCommand({ TableName: columnTable, Item: row }));
  }
  for (const row of rowsItems) {
    await ddb.send(new PutCommand({ TableName: itemTable, Item: row }));
  }

  console.log(
    `migrated org=${organizationId} tables=${columnTable},${itemTable} rows=${rowsColumns.length}/${rowsItems.length}`,
  );
};

const main = async () => {
  console.log(
    `Starting org inventory migration region=${region} prefix=${prefix} dryRun=${String(dryRun)}`,
  );
  const orgIds = await listOrganizations();
  console.log(`Found ${orgIds.length} organizations`);

  for (const orgId of orgIds) {
    await migrateOrg(orgId);
  }
  console.log("Migration complete");
};

main().catch((err) => {
  console.error("Migration failed", err);
  process.exit(1);
});
