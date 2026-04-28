#!/usr/bin/env npx tsx
/**
 * Wipe a single test org back to its freshly-created state.
 *
 * Two-phase: without --confirm, prints a summary and exits. With
 * --confirm <orgId> matching --org-id, performs the wipe.
 *
 * What it does:
 *   - Deletes every row in the org's items / pending / auditlog / restock-orders tables
 *   - Deletes only non-core columns from the org's columns table (core columns
 *     are reseeded by ensureColumns on next API call anyway)
 *   - Sets onboardingCompleted = false on the org row
 *
 * What it does NOT touch:
 *   - The org row itself (other than onboardingCompleted)
 *   - Users in the user table
 *   - Invites
 *   - Cognito users
 *   - Per-org tables for any other org
 *
 * Safety mechanisms:
 *   - --org-id is required (no default)
 *   - The org must exist in --org-table; we read and print its full details
 *   - --confirm <orgId> must exactly match --org-id
 *   - Every table to be touched is listed before any writes
 *   - Tables whose namespaced prefix doesn't match --user-table are refused
 *
 * Usage (sandbox — region and table names baked in):
 *   # Dry run
 *   npx tsx scripts/wipe-test-org.ts --use-sandbox-defaults --org-id org_abc123
 *   # Real run
 *   npx tsx scripts/wipe-test-org.ts --use-sandbox-defaults --org-id org_abc123 --confirm org_abc123
 *
 * Usage (explicit — any environment):
 *   npx tsx scripts/wipe-test-org.ts \
 *     --org-id org_abc123 \
 *     --user-table User-xxxx-NONE \
 *     --org-table Organization-xxxx-NONE \
 *     --invite-table Invite-xxxx-NONE \
 *     [--region us-east-2] \
 *     [--confirm org_abc123]
 */

import { createHash } from "node:crypto";
import {
  DynamoDBClient,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const INVENTORY_ORG_TABLE_PREFIX = "wickops-inventory";
const TABLE_SUFFIXES = ["columns", "items", "pending", "auditlog", "restock-orders"] as const;
type TableSuffix = (typeof TABLE_SUFFIXES)[number];

// Hardcoded sandbox stack identity. Resolved 2026-04-27 by matching the user
// pool in amplify_outputs.json (us-east-2_6L58cz12j) to its CloudFormation
// stack (amplify-…-bekahwick-sandbox-…) and confirming the User/Org/Invite
// tables share the same suffix. The prod stack uses a different suffix
// (c7cde3w7zzhftpqtbxnfbkloee) and must NEVER appear here.
const SANDBOX = {
  region: "us-east-2",
  stackSuffix: "2ruustu2ezhovbtje3etwdc4ei",
  userTable: "user-2ruustu2ezhovbtje3etwdc4ei-NONE",
  orgTable: "organization-2ruustu2ezhovbtje3etwdc4ei-NONE",
  inviteTable: "invite-2ruustu2ezhovbtje3etwdc4ei-NONE",
} as const;

// Suffix that must never be used by this script. If the resolved tables ever
// contain this string, abort — it means the sandbox stack was rebuilt and the
// constants above are stale, or someone passed prod tables explicitly.
const FORBIDDEN_PROD_SUFFIX = "c7cde3w7zzhftpqtbxnfbkloee";

interface Args {
  orgId: string;
  userTable: string;
  orgTable: string;
  inviteTable: string | null;
  region: string;
  confirm: string | null;
  useSandboxDefaults: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let orgId = "";
  let userTable = "";
  let orgTable = "";
  let inviteTable: string | null = null;
  let region = "";
  let confirm: string | null = null;
  let useSandboxDefaults = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org-id") orgId = args[++i];
    else if (args[i] === "--user-table") userTable = args[++i];
    else if (args[i] === "--org-table") orgTable = args[++i];
    else if (args[i] === "--invite-table") inviteTable = args[++i];
    else if (args[i] === "--region") region = args[++i];
    else if (args[i] === "--confirm") confirm = args[++i];
    else if (args[i] === "--use-sandbox-defaults") useSandboxDefaults = true;
  }

  if (useSandboxDefaults) {
    // Refuse to merge sandbox defaults with explicit table overrides — that
    // combination is almost certainly a mistake and could land you on prod.
    if (userTable || orgTable || inviteTable || region) {
      console.error(
        "✗ --use-sandbox-defaults cannot be combined with --user-table, --org-table, --invite-table, or --region.\n" +
          "  Drop the sandbox flag and pass tables explicitly, or drop the explicit overrides.",
      );
      process.exit(1);
    }
    userTable = SANDBOX.userTable;
    orgTable = SANDBOX.orgTable;
    inviteTable = SANDBOX.inviteTable;
    region = SANDBOX.region;
  }

  if (!region) region = "us-east-2";

  if (!orgId || !userTable || !orgTable) {
    console.error(
      "Usage:\n" +
        "  # Sandbox (region/tables baked in):\n" +
        "  npx tsx scripts/wipe-test-org.ts --use-sandbox-defaults --org-id <ORG_ID> [--confirm <ORG_ID>]\n" +
        "\n" +
        "  # Explicit (any environment):\n" +
        "  npx tsx scripts/wipe-test-org.ts \\\n" +
        "    --org-id <ORG_ID> \\\n" +
        "    --user-table <USER_TABLE> \\\n" +
        "    --org-table <ORG_TABLE> \\\n" +
        "    [--invite-table <INVITE_TABLE>] \\\n" +
        "    [--region <REGION>] \\\n" +
        "    [--confirm <ORG_ID>]",
    );
    process.exit(1);
  }

  // Belt-and-suspenders: refuse if any provided table name contains the
  // known prod stack suffix, no matter how it got there.
  for (const t of [userTable, orgTable, inviteTable].filter(Boolean) as string[]) {
    if (t.includes(FORBIDDEN_PROD_SUFFIX)) {
      console.error(
        `✗ Table "${t}" contains the forbidden prod stack suffix "${FORBIDDEN_PROD_SUFFIX}".\n` +
          `  This script is not allowed to operate on prod tables. Aborting.`,
      );
      process.exit(1);
    }
  }

  return { orgId, userTable, orgTable, inviteTable, region, confirm, useSandboxDefaults };
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

function buildOrgTableName(orgId: string, namespace: string, suffix: TableSuffix): string {
  const safeOrg = sanitizeOrgIdForTableName(orgId);
  const hash = createHash("sha256").update(orgId).digest("hex").slice(0, 10);
  return `${INVENTORY_ORG_TABLE_PREFIX}-${namespace}-${safeOrg}-${hash}-${suffix}`;
}

async function tableExists(raw: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await raw.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

async function countAll(ddb: DynamoDBDocumentClient, tableName: string): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        Select: "COUNT",
        ExclusiveStartKey: lastKey,
      }),
    );
    total += res.Count ?? 0;
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return total;
}

async function countWithFilter(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  filter: { expression: string; values: Record<string, unknown>; names?: Record<string, string> },
): Promise<number> {
  let total = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        Select: "COUNT",
        FilterExpression: filter.expression,
        ExpressionAttributeValues: filter.values,
        ExpressionAttributeNames: filter.names,
        ExclusiveStartKey: lastKey,
      }),
    );
    total += res.Count ?? 0;
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return total;
}

async function* scanAllKeys(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  projection: string,
  names?: Record<string, string>,
): AsyncGenerator<Record<string, unknown>> {
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) yield item;
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
}

async function batchDelete(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  keys: Array<Record<string, unknown>>,
): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    let unprocessed: any = {
      [tableName]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
    };
    let attempt = 0;
    while (unprocessed && Object.keys(unprocessed).length > 0) {
      const res: any = await ddb.send(new BatchWriteCommand({ RequestItems: unprocessed }));
      unprocessed = res.UnprocessedItems ?? {};
      if (Object.keys(unprocessed).length > 0) {
        attempt += 1;
        if (attempt > 6) throw new Error(`UnprocessedItems remain on ${tableName} after 6 retries`);
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }
}

async function deleteAllItemsByIdKey(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<number> {
  const keys: Array<Record<string, unknown>> = [];
  for await (const item of scanAllKeys(ddb, tableName, "id")) {
    if (typeof item.id === "string") keys.push({ id: item.id });
  }
  if (keys.length > 0) await batchDelete(ddb, tableName, keys);
  return keys.length;
}

async function deleteAllAuditEvents(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<number> {
  const keys: Array<Record<string, unknown>> = [];
  for await (const item of scanAllKeys(ddb, tableName, "pk, sk")) {
    if (typeof item.pk === "string" && typeof item.sk === "string") {
      keys.push({ pk: item.pk, sk: item.sk });
    }
  }
  if (keys.length > 0) await batchDelete(ddb, tableName, keys);
  return keys.length;
}

async function deleteNonCoreColumns(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<{ deleted: number; kept: number }> {
  const toDelete: Array<Record<string, unknown>> = [];
  let kept = 0;
  for await (const item of scanAllKeys(ddb, tableName, "id")) {
    const id = item.id;
    if (typeof id !== "string") continue;
    if (id.startsWith("inventory-core-")) {
      kept += 1;
    } else {
      toDelete.push({ id });
    }
  }
  if (toDelete.length > 0) await batchDelete(ddb, tableName, toDelete);
  return { deleted: toDelete.length, kept };
}

interface ResolvedTables {
  byOrg: Record<TableSuffix, { name: string; exists: boolean; itemCount: number }>;
}

async function resolveOrgTables(
  ddb: DynamoDBDocumentClient,
  raw: DynamoDBClient,
  orgId: string,
  namespace: string,
): Promise<ResolvedTables> {
  const out = {} as ResolvedTables["byOrg"];
  for (const suffix of TABLE_SUFFIXES) {
    const name = buildOrgTableName(orgId, namespace, suffix);
    const exists = await tableExists(raw, name);
    let itemCount = 0;
    if (exists) itemCount = await countAll(ddb, name);
    out[suffix] = { name, exists, itemCount };
  }
  return { byOrg: out };
}

async function main() {
  const args = parseArgs();
  const raw = new DynamoDBClient({ region: args.region });
  const ddb = DynamoDBDocumentClient.from(raw);
  const namespace = buildNamespace(args.userTable);

  console.log("─────────────────────────────────────────────────────────────");
  console.log(" wipe-test-org");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`Mode:          ${args.useSandboxDefaults ? "sandbox (baked-in defaults)" : "explicit (caller-supplied tables)"}`);
  console.log(`Region:        ${args.region}`);
  console.log(`Org ID:        ${args.orgId}`);
  console.log(`User table:    ${args.userTable}`);
  console.log(`Org table:     ${args.orgTable}`);
  console.log(`Invite table:  ${args.inviteTable ?? "(not provided — pending invites won't be counted)"}`);
  console.log(`Namespace:     ${namespace}  (sha256 of "${args.userTable}|${INVENTORY_ORG_TABLE_PREFIX}")`);
  console.log();

  const orgRes = await ddb.send(new GetCommand({ TableName: args.orgTable, Key: { id: args.orgId } }));
  if (!orgRes.Item) {
    console.error(`✗ Org "${args.orgId}" not found in ${args.orgTable}. Refusing to do anything.`);
    process.exit(2);
  }
  const org = orgRes.Item;

  const userCount = await countWithFilter(ddb, args.userTable, {
    expression: "organizationId = :orgId",
    values: { ":orgId": args.orgId },
  });

  let pendingInviteCount: number | null = null;
  if (args.inviteTable) {
    pendingInviteCount = await countWithFilter(ddb, args.inviteTable, {
      expression: "organizationId = :orgId AND #status = :pending",
      names: { "#status": "status" },
      values: { ":orgId": args.orgId, ":pending": "PENDING" },
    });
  }

  const tables = await resolveOrgTables(ddb, raw, args.orgId, namespace);

  console.log("Org row");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  name:                 ${org.name}`);
  console.log(`  createdAt:            ${org.createdAt}`);
  console.log(`  plan:                 ${org.plan || "(empty)"}`);
  console.log(`  paymentStatus:        ${org.paymentStatus}`);
  console.log(`  seatLimit:            ${org.seatLimit}`);
  console.log(`  seatsUsed:            ${org.seatsUsed}`);
  console.log(`  onboardingCompleted:  ${org.onboardingCompleted ?? "(undefined)"}`);
  console.log(`  enabledModules:       ${JSON.stringify(org.enabledModules ?? null)}`);
  console.log();
  console.log("Members & invites");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Users in this org:    ${userCount}`);
  if (pendingInviteCount !== null) {
    console.log(`  Pending invites:      ${pendingInviteCount}`);
  }
  console.log();
  console.log("Per-org inventory tables (will be wiped)");
  console.log("─────────────────────────────────────────────────────────────");
  for (const suffix of TABLE_SUFFIXES) {
    const t = tables.byOrg[suffix];
    const status = t.exists ? `${t.itemCount} rows` : "(table does not exist — skip)";
    console.log(`  ${suffix.padEnd(15)} ${t.name}`);
    console.log(`  ${"".padEnd(15)}   → ${status}`);
  }
  console.log();

  if (args.confirm === null) {
    console.log("This was a DRY RUN. No changes made.");
    console.log();
    console.log("If everything above matches your test org, re-run with:");
    console.log(`  --confirm ${args.orgId}`);
    console.log();
    console.log("Reminder: this script will NOT delete users, invites, the org row,");
    console.log("or Cognito accounts. The org owner can keep using the same login.");
    return;
  }

  if (args.confirm !== args.orgId) {
    console.error(
      `✗ --confirm value does not match --org-id.\n` +
        `   --org-id:  ${args.orgId}\n` +
        `   --confirm: ${args.confirm}\n` +
        `Refusing to proceed.`,
    );
    process.exit(3);
  }

  console.log("─────────────────────────────────────────────────────────────");
  console.log(" Confirmed. Wiping…");
  console.log("─────────────────────────────────────────────────────────────");

  // 1. Items
  if (tables.byOrg.items.exists) {
    const n = await deleteAllItemsByIdKey(ddb, tables.byOrg.items.name);
    console.log(`  items:           deleted ${n} rows`);
  }
  // 2. Pending uploads
  if (tables.byOrg.pending.exists) {
    const n = await deleteAllItemsByIdKey(ddb, tables.byOrg.pending.name);
    console.log(`  pending:         deleted ${n} rows`);
  }
  // 3. Audit log (pk+sk)
  if (tables.byOrg.auditlog.exists) {
    const n = await deleteAllAuditEvents(ddb, tables.byOrg.auditlog.name);
    console.log(`  auditlog:        deleted ${n} rows`);
  }
  // 4. Restock orders
  if (tables.byOrg["restock-orders"].exists) {
    const n = await deleteAllItemsByIdKey(ddb, tables.byOrg["restock-orders"].name);
    console.log(`  restock-orders:  deleted ${n} rows`);
  }
  // 5. Non-core columns only — core columns will be reseeded by ensureColumns()
  if (tables.byOrg.columns.exists) {
    const { deleted, kept } = await deleteNonCoreColumns(ddb, tables.byOrg.columns.name);
    console.log(`  columns:         deleted ${deleted} non-core, kept ${kept} core`);
  }
  // 6. Reset onboarding flag
  await ddb.send(
    new UpdateCommand({
      TableName: args.orgTable,
      Key: { id: args.orgId },
      UpdateExpression: "SET onboardingCompleted = :false",
      ExpressionAttributeValues: { ":false": false },
    }),
  );
  console.log(`  org row:         onboardingCompleted → false`);

  console.log();
  console.log("✓ Done. The org is back to its freshly-created state.");
  console.log("  Next login will re-show the onboarding/template picker for OWNER.");
}

main().catch((err) => {
  console.error("Error:", err?.message ?? err);
  process.exit(1);
});
