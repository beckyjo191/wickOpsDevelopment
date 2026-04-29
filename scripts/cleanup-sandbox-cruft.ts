#!/usr/bin/env npx tsx
/**
 * Audit and clean up sandbox cruft: ghost org rows, ghost user rows, dead
 * invites, and (optionally) full-delete a specific org with all its
 * dependencies.
 *
 * What "cruft" means here:
 *   - GHOST ORG: org row that has no `name` AND no `createdAt`
 *     AND zero users referencing its organizationId. Pattern matches
 *     postConfirmationLambda half-completes (org row created, signup never
 *     finished). We deliberately require ALL THREE conditions so a real org
 *     missing a single field can't be wiped.
 *   - GHOST USER: user row with no `email` AND no `organizationId`
 *     AND no `role`. Stub left behind by partial signups.
 *   - DEAD INVITE: invite row with status in
 *     {CANCELLED, EXPIRED, REVOKED, SEAT_LIMIT_REACHED}.
 *
 * --also-delete-org <ORG_ID> opts in a full-blown org deletion:
 *   - All Cognito users that own the org's user rows (admin-delete-user)
 *   - All user rows with that organizationId
 *   - All invite rows with that organizationId (any status)
 *   - The org row itself
 *   - All five per-org inventory tables (DeleteTable, not row-by-row)
 * Requires a separate --confirm-delete-org <ORG_ID> match.
 *
 * Usage:
 *   # Sandbox dry run (default):
 *   npx tsx scripts/cleanup-sandbox-cruft.ts --use-sandbox-defaults
 *
 *   # Sandbox real run, ghosts only:
 *   npx tsx scripts/cleanup-sandbox-cruft.ts --use-sandbox-defaults --confirm
 *
 *   # Sandbox real run, including full org deletion:
 *   npx tsx scripts/cleanup-sandbox-cruft.ts \
 *     --use-sandbox-defaults --confirm \
 *     --also-delete-org org_xxx --confirm-delete-org org_xxx
 */

import { createHash } from "node:crypto";
import {
  DynamoDBClient,
  DeleteTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const INVENTORY_ORG_TABLE_PREFIX = "wickops-inventory";
const PER_ORG_TABLE_SUFFIXES = [
  "columns",
  "items",
  "pending",
  "auditlog",
  "restock-orders",
] as const;

const SANDBOX = {
  region: "us-east-2",
  stackSuffix: "2ruustu2ezhovbtje3etwdc4ei",
  userTable: "user-2ruustu2ezhovbtje3etwdc4ei-NONE",
  orgTable: "organization-2ruustu2ezhovbtje3etwdc4ei-NONE",
  inviteTable: "invite-2ruustu2ezhovbtje3etwdc4ei-NONE",
  userPoolId: "us-east-2_6L58cz12j",
} as const;

const FORBIDDEN_PROD_SUFFIX = "c7cde3w7zzhftpqtbxnfbkloee";
const DEAD_INVITE_STATUSES = new Set([
  "CANCELLED",
  "EXPIRED",
  "REVOKED",
  "SEAT_LIMIT_REACHED",
]);

interface Args {
  userTable: string;
  orgTable: string;
  inviteTable: string;
  userPoolId: string;
  region: string;
  confirm: boolean;
  alsoDeleteOrg: string | null;
  confirmDeleteOrg: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let useSandboxDefaults = false;
  let userTable = "";
  let orgTable = "";
  let inviteTable = "";
  let userPoolId = "";
  let region = "";
  let confirm = false;
  let alsoDeleteOrg: string | null = null;
  let confirmDeleteOrg: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--use-sandbox-defaults") useSandboxDefaults = true;
    else if (a === "--user-table") userTable = argv[++i];
    else if (a === "--org-table") orgTable = argv[++i];
    else if (a === "--invite-table") inviteTable = argv[++i];
    else if (a === "--user-pool-id") userPoolId = argv[++i];
    else if (a === "--region") region = argv[++i];
    else if (a === "--confirm") confirm = true;
    else if (a === "--also-delete-org") alsoDeleteOrg = argv[++i];
    else if (a === "--confirm-delete-org") confirmDeleteOrg = argv[++i];
  }

  if (useSandboxDefaults) {
    if (userTable || orgTable || inviteTable || userPoolId || region) {
      console.error(
        "✗ --use-sandbox-defaults cannot be combined with --user-table, --org-table, --invite-table, --user-pool-id, or --region.",
      );
      process.exit(1);
    }
    userTable = SANDBOX.userTable;
    orgTable = SANDBOX.orgTable;
    inviteTable = SANDBOX.inviteTable;
    userPoolId = SANDBOX.userPoolId;
    region = SANDBOX.region;
  }

  if (!region) region = "us-east-2";

  if (!userTable || !orgTable || !inviteTable || !userPoolId) {
    console.error(
      "Usage:\n" +
        "  # Sandbox:\n" +
        "  npx tsx scripts/cleanup-sandbox-cruft.ts --use-sandbox-defaults [--confirm]\n" +
        "  npx tsx scripts/cleanup-sandbox-cruft.ts --use-sandbox-defaults --confirm \\\n" +
        "    --also-delete-org <ORG_ID> --confirm-delete-org <ORG_ID>\n" +
        "\n" +
        "  # Explicit:\n" +
        "  npx tsx scripts/cleanup-sandbox-cruft.ts \\\n" +
        "    --user-table <T> --org-table <T> --invite-table <T> \\\n" +
        "    --user-pool-id <ID> [--region <R>] [--confirm] \\\n" +
        "    [--also-delete-org <ID> --confirm-delete-org <ID>]",
    );
    process.exit(1);
  }

  for (const t of [userTable, orgTable, inviteTable]) {
    if (t.includes(FORBIDDEN_PROD_SUFFIX)) {
      console.error(`✗ Table "${t}" contains the forbidden prod stack suffix. Aborting.`);
      process.exit(1);
    }
  }

  if (alsoDeleteOrg && !confirmDeleteOrg) {
    console.error("✗ --also-delete-org requires --confirm-delete-org for safety.");
    process.exit(1);
  }
  if (alsoDeleteOrg && confirmDeleteOrg && alsoDeleteOrg !== confirmDeleteOrg) {
    console.error(
      `✗ --also-delete-org (${alsoDeleteOrg}) and --confirm-delete-org (${confirmDeleteOrg}) do not match.`,
    );
    process.exit(1);
  }

  return {
    userTable,
    orgTable,
    inviteTable,
    userPoolId,
    region,
    confirm,
    alsoDeleteOrg,
    confirmDeleteOrg,
  };
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

function buildPerOrgTableNames(orgId: string, namespace: string): string[] {
  const safeOrg = sanitizeOrgIdForTableName(orgId);
  const hash = createHash("sha256").update(orgId).digest("hex").slice(0, 10);
  return PER_ORG_TABLE_SUFFIXES.map(
    (suffix) => `${INVENTORY_ORG_TABLE_PREFIX}-${namespace}-${safeOrg}-${hash}-${suffix}`,
  );
}

async function scanAll<T = Record<string, unknown>>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }),
    );
    for (const item of res.Items ?? []) items.push(item as T);
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items;
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

async function cognitoUserExists(
  cog: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<boolean> {
  try {
    await cog.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    return true;
  } catch (err: any) {
    if (err?.name === "UserNotFoundException") return false;
    throw err;
  }
}

interface OrgRow {
  id: string;
  name?: string;
  createdAt?: string;
  plan?: string;
  paymentStatus?: string;
}

interface UserRow {
  id: string;
  email?: string;
  organizationId?: string;
  role?: string;
  createdAt?: string;
}

interface InviteRow {
  id: string;
  email?: string;
  organizationId?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
}

interface Audit {
  ghostOrgs: OrgRow[];
  ghostUsers: UserRow[];
  deadInvites: InviteRow[];
  fullDelete: null | {
    org: OrgRow;
    users: UserRow[];
    invites: InviteRow[];
    cognitoUsernames: string[];
    perOrgTables: { name: string; exists: boolean }[];
  };
}

async function buildAudit(
  ddb: DynamoDBDocumentClient,
  raw: DynamoDBClient,
  cog: CognitoIdentityProviderClient,
  args: Args,
): Promise<Audit> {
  const namespace = buildNamespace(args.userTable);

  const [orgs, users, invites] = await Promise.all([
    scanAll<OrgRow>(ddb, args.orgTable),
    scanAll<UserRow>(ddb, args.userTable),
    scanAll<InviteRow>(ddb, args.inviteTable),
  ]);

  const usersByOrg = new Map<string, UserRow[]>();
  for (const u of users) {
    if (!u.organizationId) continue;
    const list = usersByOrg.get(u.organizationId) ?? [];
    list.push(u);
    usersByOrg.set(u.organizationId, list);
  }

  // GHOST ORGS: no name AND no createdAt AND no users assigned.
  const ghostOrgs = orgs.filter(
    (o) =>
      !o.name &&
      !o.createdAt &&
      (usersByOrg.get(o.id)?.length ?? 0) === 0,
  );

  // GHOST USERS: no email AND no organizationId AND no role.
  const ghostUsers = users.filter((u) => !u.email && !u.organizationId && !u.role);

  // DEAD INVITES: status in DEAD_INVITE_STATUSES.
  const deadInvites = invites.filter(
    (i) => i.status && DEAD_INVITE_STATUSES.has(i.status.toUpperCase()),
  );

  let fullDelete: Audit["fullDelete"] = null;
  if (args.alsoDeleteOrg) {
    const target = orgs.find((o) => o.id === args.alsoDeleteOrg);
    if (!target) {
      console.error(
        `✗ --also-delete-org ${args.alsoDeleteOrg} not found in ${args.orgTable}. Aborting before any writes.`,
      );
      process.exit(2);
    }
    const orgUsers = usersByOrg.get(target.id) ?? [];
    const orgInvites = invites.filter((i) => i.organizationId === target.id);
    const cognitoUsernames: string[] = [];
    for (const u of orgUsers) {
      if (await cognitoUserExists(cog, args.userPoolId, u.id)) {
        cognitoUsernames.push(u.id);
      }
    }
    const perOrgTables: NonNullable<Audit["fullDelete"]>["perOrgTables"] = [];
    for (const name of buildPerOrgTableNames(target.id, namespace)) {
      perOrgTables.push({ name, exists: await tableExists(raw, name) });
    }
    fullDelete = { org: target, users: orgUsers, invites: orgInvites, cognitoUsernames, perOrgTables };
  }

  return { ghostOrgs, ghostUsers, deadInvites, fullDelete };
}

function printAudit(audit: Audit, args: Args) {
  console.log("─────────────────────────────────────────────────────────────");
  console.log(" cleanup-sandbox-cruft");
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`Region:        ${args.region}`);
  console.log(`User table:    ${args.userTable}`);
  console.log(`Org table:     ${args.orgTable}`);
  console.log(`Invite table:  ${args.inviteTable}`);
  console.log(`User pool:     ${args.userPoolId}`);
  console.log();

  console.log(`Ghost orgs (no name + no createdAt + no users): ${audit.ghostOrgs.length}`);
  for (const o of audit.ghostOrgs) console.log(`  - ${o.id}`);
  console.log();

  console.log(`Ghost users (no email + no orgId + no role): ${audit.ghostUsers.length}`);
  for (const u of audit.ghostUsers) console.log(`  - ${u.id}`);
  console.log();

  console.log(`Dead invites (status in CANCELLED/EXPIRED/REVOKED/SEAT_LIMIT_REACHED): ${audit.deadInvites.length}`);
  for (const i of audit.deadInvites) {
    console.log(`  - ${i.id}  (${i.status}, → org ${i.organizationId ?? "?"})`);
  }
  console.log();

  if (audit.fullDelete) {
    const fd = audit.fullDelete;
    console.log("Full-org delete plan");
    console.log("─────────────────────────────────────────────────────────────");
    console.log(`  Org:    ${fd.org.id}  "${fd.org.name ?? ""}"  created ${fd.org.createdAt ?? "?"}`);
    console.log(`  Users to delete (${fd.users.length}):`);
    for (const u of fd.users) console.log(`    - ${u.id}  ${u.email ?? ""}  role=${u.role ?? "?"}`);
    console.log(`  Cognito usernames to admin-delete (${fd.cognitoUsernames.length}):`);
    for (const n of fd.cognitoUsernames) console.log(`    - ${n}`);
    console.log(`  Invite rows to delete (${fd.invites.length}):`);
    for (const i of fd.invites) console.log(`    - ${i.id}  status=${i.status ?? "?"}`);
    console.log(`  Per-org tables to DROP (${fd.perOrgTables.length}):`);
    for (const t of fd.perOrgTables) {
      console.log(`    - ${t.name}  ${t.exists ? "(exists, will drop)" : "(absent, skip)"}`);
    }
    console.log();
  }
}

async function batchDeleteByPk(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  ids: string[],
): Promise<void> {
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    let unprocessed: any = {
      [tableName]: chunk.map((id) => ({ DeleteRequest: { Key: { id } } })),
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

async function executeAudit(
  ddb: DynamoDBDocumentClient,
  raw: DynamoDBClient,
  cog: CognitoIdentityProviderClient,
  args: Args,
  audit: Audit,
) {
  console.log("─────────────────────────────────────────────────────────────");
  console.log(" Executing…");
  console.log("─────────────────────────────────────────────────────────────");

  if (audit.ghostOrgs.length) {
    await batchDeleteByPk(ddb, args.orgTable, audit.ghostOrgs.map((o) => o.id));
    console.log(`  ghost orgs:    deleted ${audit.ghostOrgs.length}`);
  }
  if (audit.ghostUsers.length) {
    await batchDeleteByPk(ddb, args.userTable, audit.ghostUsers.map((u) => u.id));
    console.log(`  ghost users:   deleted ${audit.ghostUsers.length}`);
  }
  if (audit.deadInvites.length) {
    await batchDeleteByPk(ddb, args.inviteTable, audit.deadInvites.map((i) => i.id));
    console.log(`  dead invites:  deleted ${audit.deadInvites.length}`);
  }

  if (audit.fullDelete) {
    const fd = audit.fullDelete;
    // 1. Delete Cognito users first — once the user row is gone we lose the
    //    mapping back to username. (We already collected usernames in the audit.)
    for (const username of fd.cognitoUsernames) {
      await cog.send(
        new AdminDeleteUserCommand({ UserPoolId: args.userPoolId, Username: username }),
      );
      console.log(`  cognito:       deleted ${username}`);
    }
    // 2. User rows for that org
    if (fd.users.length) {
      await batchDeleteByPk(ddb, args.userTable, fd.users.map((u) => u.id));
      console.log(`  user rows:     deleted ${fd.users.length} for org ${fd.org.id}`);
    }
    // 3. Invite rows for that org
    if (fd.invites.length) {
      await batchDeleteByPk(ddb, args.inviteTable, fd.invites.map((i) => i.id));
      console.log(`  invite rows:   deleted ${fd.invites.length} for org ${fd.org.id}`);
    }
    // 4. Org row itself
    await ddb.send(new DeleteCommand({ TableName: args.orgTable, Key: { id: fd.org.id } }));
    console.log(`  org row:       deleted ${fd.org.id}`);
    // 5. Drop per-org tables
    for (const t of fd.perOrgTables) {
      if (!t.exists) continue;
      await raw.send(new DeleteTableCommand({ TableName: t.name }));
      console.log(`  table dropped: ${t.name}`);
    }
  }

  console.log();
  console.log("✓ Done.");
}

async function main() {
  const args = parseArgs();
  const raw = new DynamoDBClient({ region: args.region });
  const ddb = DynamoDBDocumentClient.from(raw);
  const cog = new CognitoIdentityProviderClient({ region: args.region });

  const audit = await buildAudit(ddb, raw, cog, args);
  printAudit(audit, args);

  const totalGhosts =
    audit.ghostOrgs.length + audit.ghostUsers.length + audit.deadInvites.length;
  const willFullDelete = audit.fullDelete !== null;

  if (totalGhosts === 0 && !willFullDelete) {
    console.log("Nothing to clean up.");
    return;
  }

  if (!args.confirm) {
    console.log("This was a DRY RUN. No changes made.");
    console.log();
    console.log("To actually clean up the ghosts above, re-run with: --confirm");
    if (willFullDelete) {
      console.log(
        `To also full-delete ${audit.fullDelete!.org.id}, keep --also-delete-org ${audit.fullDelete!.org.id} --confirm-delete-org ${audit.fullDelete!.org.id}`,
      );
    }
    return;
  }

  await executeAudit(ddb, raw, cog, args, audit);
}

main().catch((err) => {
  console.error("Error:", err?.message ?? err);
  process.exit(1);
});
