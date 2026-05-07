// ── Shared: storage.ts ──────────────────────────────────────────────────────
// Per-org DynamoDB table provisioning and storage resolution.

import {
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { rawDdb } from "./clients";
import {
  AUDIT_BY_TIMESTAMP_INDEX,
  AUDIT_BY_USER_INDEX,
  INVENTORY_COLUMN_BY_MODULE_INDEX,
  INVENTORY_ITEM_BY_MODULE_INDEX,
  INVENTORY_VENDOR_PRICING_BY_ITEM_INDEX,
  STORAGE_CACHE_TTL_MS,
} from "./config";
import { buildOrgScopedTableName, sleep } from "./normalize";
import type { InventoryStorage } from "./types";

export class InventoryStorageProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryStorageProvisioningError";
  }
}

export const isResourceInUse = (err: any): boolean =>
  err?.name === "ResourceInUseException" ||
  String(err?.__type ?? "").includes("ResourceInUseException");

export const describeTable = async (tableName: string) => {
  try {
    return await rawDdb.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") return null;
    throw err;
  }
};

export const waitForTableActive = async (tableName: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const described = await describeTable(tableName);
    if (described?.Table?.TableStatus === "ACTIVE") return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for table to become ACTIVE: ${tableName}`);
};

export const enablePitr = async (tableName: string): Promise<void> => {
  try {
    await rawDdb.send(
      new UpdateContinuousBackupsCommand({
        TableName: tableName,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    );
  } catch (err) {
    // Best-effort: table is usable without PITR, but log loudly so a CloudWatch
    // metric / log search can flag it. (We previously swallowed silently and
    // Zack's prod inventory tables ended up without PITR for weeks.)
    console.warn(`[storage] failed to enable PITR on ${tableName}`, err);
  }
};

export const createOrgTableIfMissing = async (
  tableName: string,
  gsiName: string,
  gsiSortKey: "sortOrder" | "position",
): Promise<{ created: boolean }> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      try {
        await waitForTableActive(tableName);
      } catch {
        throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
      }
    }
    await enablePitr(tableName);
    return { created: false };
  }

  try {
    await rawDdb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        DeletionProtectionEnabled: true,
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
  } catch (err: any) {
    if (!isResourceInUse(err)) {
      throw err;
    }
  }

  try {
    await waitForTableActive(tableName);
    await enablePitr(tableName);
    return { created: true };
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

/** Create the per-org `inventoryItemVendorPricing` table (1g). Hash-keyed on
 *  `id` (the composite `${itemId}#${vendorLower}` string), with a GSI on
 *  `itemId` so the item-detail modal can list every vendor for one item in a
 *  single Query. Mirrors the existing pattern used by columns/items tables. */
export const createOrgVendorPricingTableIfMissing = async (tableName: string): Promise<{ created: boolean }> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      try {
        await waitForTableActive(tableName);
      } catch {
        throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
      }
    }
    await enablePitr(tableName);
    return { created: false };
  }

  try {
    await rawDdb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        DeletionProtectionEnabled: true,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: ScalarAttributeType.S },
          { AttributeName: "itemId", AttributeType: ScalarAttributeType.S },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
        GlobalSecondaryIndexes: [
          {
            IndexName: INVENTORY_VENDOR_PRICING_BY_ITEM_INDEX,
            KeySchema: [
              { AttributeName: "itemId", KeyType: KeyType.HASH },
            ],
            Projection: { ProjectionType: ProjectionType.ALL },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (!isResourceInUse(err)) {
      throw err;
    }
  }

  try {
    await waitForTableActive(tableName);
    await enablePitr(tableName);
    return { created: true };
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

export const createOrgPendingTableIfMissing = async (tableName: string): Promise<{ created: boolean }> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      try {
        await waitForTableActive(tableName);
      } catch {
        throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
      }
    }
    await enablePitr(tableName);
    return { created: false };
  }

  try {
    await rawDdb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        DeletionProtectionEnabled: true,
        AttributeDefinitions: [
          { AttributeName: "id", AttributeType: ScalarAttributeType.S },
        ],
        KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
      }),
    );
  } catch (err: any) {
    if (!isResourceInUse(err)) {
      throw err;
    }
  }

  try {
    await waitForTableActive(tableName);
    await enablePitr(tableName);
    return { created: true };
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

export const createOrgAuditTableIfMissing = async (tableName: string): Promise<{ created: boolean }> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      try {
        await waitForTableActive(tableName);
      } catch {
        throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
      }
    }
    await enablePitr(tableName);
    return { created: false };
  }

  try {
    await rawDdb.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        DeletionProtectionEnabled: true,
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: ScalarAttributeType.S },
          { AttributeName: "sk", AttributeType: ScalarAttributeType.S },
          { AttributeName: "orgId", AttributeType: ScalarAttributeType.S },
          { AttributeName: "timestamp", AttributeType: ScalarAttributeType.S },
          { AttributeName: "userId", AttributeType: ScalarAttributeType.S },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: KeyType.HASH },
          { AttributeName: "sk", KeyType: KeyType.RANGE },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: AUDIT_BY_TIMESTAMP_INDEX,
            KeySchema: [
              { AttributeName: "orgId", KeyType: KeyType.HASH },
              { AttributeName: "timestamp", KeyType: KeyType.RANGE },
            ],
            Projection: { ProjectionType: ProjectionType.ALL },
          },
          {
            IndexName: AUDIT_BY_USER_INDEX,
            KeySchema: [
              { AttributeName: "userId", KeyType: KeyType.HASH },
              { AttributeName: "timestamp", KeyType: KeyType.RANGE },
            ],
            Projection: { ProjectionType: ProjectionType.ALL },
          },
        ],
      }),
    );
  } catch (err: any) {
    if (!isResourceInUse(err)) {
      throw err;
    }
  }

  try {
    await waitForTableActive(tableName);
    await enablePitr(tableName);
    // Enable TTL for automatic cleanup of old audit events
    try {
      await rawDdb.send(
        new UpdateTimeToLiveCommand({
          TableName: tableName,
          TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        }),
      );
    } catch { /* best-effort */ }
    return { created: true };
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

export const storageCache = new Map<string, { storage: InventoryStorage; checkedAt: number }>();

export const ensureStorageForOrganization = async (organizationId: string): Promise<InventoryStorage> => {
  const cached = storageCache.get(organizationId);
  const now = Date.now();
  if (cached && now - cached.checkedAt < STORAGE_CACHE_TTL_MS) {
    return cached.storage;
  }

  const storage: InventoryStorage = {
    columnTable: buildOrgScopedTableName(organizationId, "columns"),
    itemTable: buildOrgScopedTableName(organizationId, "items"),
    pendingTable: buildOrgScopedTableName(organizationId, "pending"),
    auditTable: buildOrgScopedTableName(organizationId, "auditlog"),
    restockOrdersTable: buildOrgScopedTableName(organizationId, "restock-orders"),
    vendorPricingTable: buildOrgScopedTableName(organizationId, "vendor-pricing"),
  };

  await Promise.all([
    createOrgTableIfMissing(storage.columnTable, INVENTORY_COLUMN_BY_MODULE_INDEX, "sortOrder"),
    createOrgTableIfMissing(storage.itemTable, INVENTORY_ITEM_BY_MODULE_INDEX, "position"),
    createOrgPendingTableIfMissing(storage.pendingTable),
    createOrgAuditTableIfMissing(storage.auditTable),
    createOrgPendingTableIfMissing(storage.restockOrdersTable),
    createOrgVendorPricingTableIfMissing(storage.vendorPricingTable),
  ]);

  storageCache.set(organizationId, { storage, checkedAt: now });
  return storage;
};

export const deleteStorageForOrganization = async (organizationId: string): Promise<void> => {
  const storage = await ensureStorageForOrganization(organizationId);
  await Promise.all(
    [storage.columnTable, storage.itemTable, storage.pendingTable, storage.auditTable, storage.restockOrdersTable, storage.vendorPricingTable].map(async (tableName) => {
      try {
        await rawDdb.send(new DeleteTableCommand({ TableName: tableName }));
      } catch (err: any) {
        if (err?.name === "ResourceNotFoundException") return;
        throw err;
      }
    }),
  );
  storageCache.delete(organizationId);
};
