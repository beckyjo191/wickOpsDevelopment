import {
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  KeyType,
  ProjectionType,
  ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";

const rawDdb = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(rawDdb);

const USER_TABLE = process.env.USER_TABLE!;
const SHARED_INVENTORY_COLUMN_TABLE = process.env.INVENTORY_COLUMN_TABLE!;
const SHARED_INVENTORY_ITEM_TABLE = process.env.INVENTORY_ITEM_TABLE!;
const ENABLE_PER_ORG_TABLES =
  String(process.env.ENABLE_PER_ORG_INVENTORY_TABLES ?? "true").trim().toLowerCase() !== "false";
const INVENTORY_ORG_TABLE_PREFIX =
  String(process.env.INVENTORY_ORG_TABLE_PREFIX ?? "wickops-inventory").trim() ||
  "wickops-inventory";
const INVENTORY_COLUMN_BY_ORG_INDEX = "ByOrganizationSortOrder";
const INVENTORY_ITEM_BY_ORG_INDEX = "ByOrganizationPosition";
const INVENTORY_COLUMN_BY_MODULE_INDEX = "ByModuleSortOrder";
const INVENTORY_ITEM_BY_MODULE_INDEX = "ByModulePosition";

const EDIT_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"]);
const COLUMN_ADMIN_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);
const CORE_KEYS = new Set(["quantity", "minQuantity", "expirationDate"]);
const STORAGE_CACHE_TTL_MS = 5 * 60 * 1000;

type InventoryColumnType = "text" | "number" | "date" | "link" | "boolean";

type UserRecord = {
  id: string;
  organizationId?: string;
  role?: string;
};

type InventoryColumn = {
  id: string;
  organizationId: string;
  module: "inventory";
  key: string;
  label: string;
  type: InventoryColumnType;
  isCore: boolean;
  isRequired: boolean;
  isVisible: boolean;
  isEditable: boolean;
  sortOrder: number;
  createdAt: string;
};

type InventoryItem = {
  id: string;
  organizationId: string;
  module: "inventory";
  position: number;
  valuesJson: string;
  createdAt: string;
  updatedAtCustom: string;
};

type AccessContext = {
  userId: string;
  organizationId: string;
  role: string;
  canEditInventory: boolean;
  canManageColumns: boolean;
};

type InventoryStorage = {
  mode: "shared" | "org";
  columnTable: string;
  itemTable: string;
};

const sharedStorage: InventoryStorage = {
  mode: "shared",
  columnTable: SHARED_INVENTORY_COLUMN_TABLE,
  itemTable: SHARED_INVENTORY_ITEM_TABLE,
};
let currentStorage: InventoryStorage = sharedStorage;
const storageCache = new Map<string, { storage: InventoryStorage; checkedAt: number }>();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    ...corsHeaders,
  },
  body: JSON.stringify(body),
});

const normalizeRole = (value: unknown): string => String(value ?? "").trim().toUpperCase();
const normalizeOrgId = (value: unknown): string => String(value ?? "").trim();

const parseBody = (event: any): any => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return raw ? JSON.parse(raw) : {};
};

const getPath = (event: any): string =>
  String(event?.rawPath ?? event?.path ?? event?.requestContext?.http?.path ?? "");

const getMethod = (event: any): string =>
  String(event?.requestContext?.http?.method ?? event?.httpMethod ?? "").toUpperCase();

const getQueryString = (event: any): Record<string, string | undefined> =>
  (event?.queryStringParameters ?? {}) as Record<string, string | undefined>;

const toKey = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const normalizeLooseKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADER_ALIASES: Record<string, string> = {
  itemname: "itemName",
  itemid: "itemName",
  name: "itemName",
  quantity: "quantity",
  qty: "quantity",
  minimumquantity: "minQuantity",
  minquantity: "minQuantity",
  minqty: "minQuantity",
  minimumqty: "minQuantity",
  expirationdate: "expirationDate",
  expirydate: "expirationDate",
  expdate: "expirationDate",
};

const parseNextToken = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
};

const encodeNextToken = (value: Record<string, unknown> | undefined): string | null => {
  if (!value) return null;
  return Buffer.from(JSON.stringify(value)).toString("base64");
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const sanitizeOrgIdForTableName = (organizationId: string): string =>
  organizationId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "org";

const buildOrgScopedTableName = (organizationId: string, suffix: "columns" | "items"): string => {
  const safeOrg = sanitizeOrgIdForTableName(organizationId);
  const hash = createHash("sha256").update(organizationId).digest("hex").slice(0, 10);
  return `${INVENTORY_ORG_TABLE_PREFIX}-${safeOrg}-${hash}-${suffix}`;
};

const describeTable = async (tableName: string) => {
  try {
    return await rawDdb.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") return null;
    throw err;
  }
};

const waitForTableActive = async (tableName: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const described = await describeTable(tableName);
    if (described?.Table?.TableStatus === "ACTIVE") return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for table to become ACTIVE: ${tableName}`);
};

const createOrgTableIfMissing = async (
  tableName: string,
  gsiName: string,
  gsiSortKey: "sortOrder" | "position",
): Promise<{ created: boolean }> => {
  const existing = await describeTable(tableName);
  if (existing?.Table) {
    if (existing.Table.TableStatus !== "ACTIVE") {
      await waitForTableActive(tableName);
    }
    return { created: false };
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
  return { created: true };
};

const migrateOrgDataFromSharedTables = async (
  organizationId: string,
  storage: InventoryStorage,
): Promise<void> => {
  let columnStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: SHARED_INVENTORY_COLUMN_TABLE,
        IndexName: INVENTORY_COLUMN_BY_ORG_INDEX,
        KeyConditionExpression: "organizationId = :org",
        ExpressionAttributeValues: { ":org": organizationId },
        ExclusiveStartKey: columnStartKey,
      }),
    );
    for (const raw of (page.Items ?? []) as InventoryColumn[]) {
      if (raw.module !== "inventory") continue;
      await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: raw }));
    }
    columnStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (columnStartKey);

  let itemStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: SHARED_INVENTORY_ITEM_TABLE,
        IndexName: INVENTORY_ITEM_BY_ORG_INDEX,
        KeyConditionExpression: "organizationId = :org",
        ExpressionAttributeValues: { ":org": organizationId },
        ExclusiveStartKey: itemStartKey,
      }),
    );
    for (const raw of (page.Items ?? []) as InventoryItem[]) {
      if (raw.module !== "inventory") continue;
      await ddb.send(new PutCommand({ TableName: storage.itemTable, Item: raw }));
    }
    itemStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (itemStartKey);
};

const ensureStorageForOrganization = async (organizationId: string): Promise<InventoryStorage> => {
  if (!ENABLE_PER_ORG_TABLES) {
    return sharedStorage;
  }

  const cached = storageCache.get(organizationId);
  const now = Date.now();
  if (cached && now - cached.checkedAt < STORAGE_CACHE_TTL_MS) {
    return cached.storage;
  }

  const storage: InventoryStorage = {
    mode: "org",
    columnTable: buildOrgScopedTableName(organizationId, "columns"),
    itemTable: buildOrgScopedTableName(organizationId, "items"),
  };

  const [columnTableResult, itemTableResult] = await Promise.all([
    createOrgTableIfMissing(storage.columnTable, INVENTORY_COLUMN_BY_MODULE_INDEX, "sortOrder"),
    createOrgTableIfMissing(storage.itemTable, INVENTORY_ITEM_BY_MODULE_INDEX, "position"),
  ]);

  if (columnTableResult.created || itemTableResult.created) {
    await migrateOrgDataFromSharedTables(organizationId, storage);
  }

  storageCache.set(organizationId, { storage, checkedAt: now });
  return storage;
};

const deleteStorageForOrganization = async (organizationId: string): Promise<void> => {
  if (!ENABLE_PER_ORG_TABLES) return;
  const storage = await ensureStorageForOrganization(organizationId);
  await Promise.all(
    [storage.columnTable, storage.itemTable].map(async (tableName) => {
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

const listColumns = async (organizationId: string): Promise<InventoryColumn[]> => {
  const out: InventoryColumn[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page =
      currentStorage.mode === "org"
        ? await ddb.send(
            new QueryCommand({
              TableName: currentStorage.columnTable,
              IndexName: INVENTORY_COLUMN_BY_MODULE_INDEX,
              KeyConditionExpression: "#module = :module",
              ExpressionAttributeNames: { "#module": "module" },
              ExpressionAttributeValues: { ":module": "inventory" },
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          )
        : await ddb.send(
            new QueryCommand({
              TableName: currentStorage.columnTable,
              IndexName: INVENTORY_COLUMN_BY_ORG_INDEX,
              KeyConditionExpression: "organizationId = :org",
              ExpressionAttributeValues: { ":org": organizationId },
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          );
    out.push(
      ...((page.Items ?? []) as InventoryColumn[]).filter((item) => item.module === "inventory"),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
};

const ensureColumns = async (organizationId: string): Promise<InventoryColumn[]> => {
  const existing = await listColumns(organizationId);
  if (existing.length > 0) return existing;

  const defaults: Omit<InventoryColumn, "id">[] = [
    {
      organizationId,
      module: "inventory",
      key: "itemName",
      label: "Item Name",
      type: "text",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 10,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "quantity",
      label: "Quantity",
      type: "number",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 20,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "minQuantity",
      label: "Min Quantity",
      type: "number",
      isCore: true,
      isRequired: true,
      isVisible: true,
      isEditable: true,
      sortOrder: 30,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "expirationDate",
      label: "Expiration Date",
      type: "date",
      isCore: true,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 40,
      createdAt: new Date().toISOString(),
    },
  ];

  for (const column of defaults) {
    await ddb.send(
      new PutCommand({
        TableName: currentStorage.columnTable,
        Item: {
          id: randomUUID(),
          ...column,
        },
      }),
    );
  }

  return listColumns(organizationId);
};

const listItemsPage = async (
  organizationId: string,
  limit: number,
  startKey?: Record<string, unknown>,
): Promise<{ items: InventoryItem[]; nextToken: string | null }> => {
  const page =
    currentStorage.mode === "org"
      ? await ddb.send(
          new QueryCommand({
            TableName: currentStorage.itemTable,
            IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
            KeyConditionExpression: "#module = :module",
            ExpressionAttributeNames: { "#module": "module" },
            ExpressionAttributeValues: { ":module": "inventory" },
            ExclusiveStartKey: startKey,
            Limit: limit,
          }),
        )
      : await ddb.send(
          new QueryCommand({
            TableName: currentStorage.itemTable,
            IndexName: INVENTORY_ITEM_BY_ORG_INDEX,
            KeyConditionExpression: "organizationId = :org",
            ExpressionAttributeValues: { ":org": organizationId },
            ExclusiveStartKey: startKey,
            Limit: limit,
          }),
        );
  const items = ((page.Items ?? []) as InventoryItem[])
    .filter((item) => item.module === "inventory")
    .sort(
    (a, b) => Number(a.position) - Number(b.position),
  );
  return {
    items,
    nextToken: encodeNextToken(page.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
};

const listAllItems = async (organizationId: string): Promise<InventoryItem[]> => {
  const out: InventoryItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page =
      currentStorage.mode === "org"
        ? await ddb.send(
            new QueryCommand({
              TableName: currentStorage.itemTable,
              IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
              KeyConditionExpression: "#module = :module",
              ExpressionAttributeNames: { "#module": "module" },
              ExpressionAttributeValues: { ":module": "inventory" },
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          )
        : await ddb.send(
            new QueryCommand({
              TableName: currentStorage.itemTable,
              IndexName: INVENTORY_ITEM_BY_ORG_INDEX,
              KeyConditionExpression: "organizationId = :org",
              ExpressionAttributeValues: { ":org": organizationId },
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          );
    out.push(
      ...((page.Items ?? []) as InventoryItem[]).filter((item) => item.module === "inventory"),
    );
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return out.sort((a, b) => Number(a.position) - Number(b.position));
};

const detectDelimiter = (text: string): string => {
  const sample = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestScore = -1;

  for (const candidate of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < sample.length; i += 1) {
      const char = sample[i];
      const next = sample[i + 1];
      if (char === '"') {
        if (inQuotes && next === '"') {
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && char === candidate) count += 1;
    }

    if (count > bestScore) {
      best = candidate;
      bestScore = count;
    }
  }

  return best;
};

const parseCsv = (csvText: string): string[][] => {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  const delimiter = detectDelimiter(csvText);

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }

  if (rows[0]?.[0]) {
    rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  }

  return rows;
};

const parseDateToIsoDay = (value: string): string => {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
};

const parseNonNegativeNumberOrBlank = (
  value: string,
): { ok: true; value: number | "" } | { ok: false; error: string } => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "must be a number" };
  }
  if (parsed < 0) {
    return { ok: false, error: "cannot be negative" };
  }
  return { ok: true, value: parsed };
};

const validateNonNegativeField = (
  values: Record<string, unknown>,
  field: "quantity" | "minQuantity",
): { ok: true } | { ok: false; error: string } => {
  const raw = values[field];
  if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${field} must be a number` };
  }
  if (parsed < 0) {
    return { ok: false, error: `${field} cannot be negative` };
  }
  return { ok: true };
};

const buildImportMatchKey = (values: Record<string, unknown>): string => {
  const itemName = String(values.itemName ?? "").trim().toLowerCase();
  if (!itemName) return "";
  const location = String(values.location ?? "").trim().toLowerCase();
  const expirationDate = parseDateToIsoDay(String(values.expirationDate ?? ""));
  return `${itemName}||${location}||${expirationDate}`;
};

const detectHeaderRowIndex = (
  rows: string[][],
  byKey: Map<string, InventoryColumn>,
  byLoose: Map<string, InventoryColumn>,
): number => {
  const maxScan = Math.min(rows.length, 25);
  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < maxScan; i += 1) {
    const row = rows[i] ?? [];
    const headers = row.map((cell) => String(cell ?? "").trim()).filter((cell) => cell.length > 0);
    if (headers.length === 0) continue;

    let mappedCount = 0;
    for (const header of headers) {
      const loose = normalizeLooseKey(header);
      const aliasKey = HEADER_ALIASES[loose];
      const mapped = (aliasKey ? byKey.get(aliasKey) : undefined) ?? byLoose.get(loose);
      if (mapped) mappedCount += 1;
    }

    const score = mappedCount * 10 + headers.length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
};

const getAccessContext = async (event: any): Promise<AccessContext> => {
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ??
    event.requestContext?.authorizer?.claims;

  const userId = String(claims?.sub ?? "").trim();
  if (!userId) throw new Error("Unauthorized");

  const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
  const user = userRes.Item as UserRecord | undefined;
  if (!user || !user.organizationId) {
    throw new Error("User or organization not found");
  }

  const role = normalizeRole(user.role);
  return {
    userId,
    organizationId: normalizeOrgId(user.organizationId),
    role,
    canEditInventory: EDIT_ROLES.has(role),
    canManageColumns: COLUMN_ADMIN_ROLES.has(role),
  };
};

const handleBootstrap = async (access: AccessContext) => {
  const columns = await ensureColumns(access.organizationId);
  const items = await listAllItems(access.organizationId);
  return json(200, {
    access,
    columns,
    items,
    nextToken: null,
  });
};

const handleListItems = async (access: AccessContext, query: Record<string, string | undefined>) => {
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 250);
  const start = parseNextToken(query.nextToken);
  const page = await listItemsPage(access.organizationId, limit, start);
  return json(200, page);
};

const handleSaveItems = async (access: AccessContext, body: any) => {
  if (!access.canEditInventory) {
    return json(403, { error: "Insufficient permissions" });
  }

  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const deletedRowIds = Array.isArray(body?.deletedRowIds)
    ? body.deletedRowIds
        .map((value: unknown) => String(value ?? "").trim())
        .filter((value: string) => value.length > 0)
    : [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const rowId = String(row?.id ?? "").trim() || randomUUID();
    const values = (row?.values ?? {}) as Record<string, unknown>;
    const quantityValidation = validateNonNegativeField(values, "quantity");
    if (!quantityValidation.ok) {
      const reason = "error" in quantityValidation ? quantityValidation.error : "invalid quantity";
      return json(400, { error: `Row ${idx + 1}: ${reason}` });
    }
    const minQuantityValidation = validateNonNegativeField(values, "minQuantity");
    if (!minQuantityValidation.ok) {
      const reason = "error" in minQuantityValidation ? minQuantityValidation.error : "invalid minQuantity";
      return json(400, { error: `Row ${idx + 1}: ${reason}` });
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: currentStorage.itemTable,
          Key: { id: rowId },
          // Prevent cross-org overwrite if a caller sends an arbitrary existing id.
          ConditionExpression:
            "attribute_not_exists(id) OR (organizationId = :org AND #module = :module)",
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, updatedAtCustom = :updatedAtCustom, createdAt = if_not_exists(createdAt, :createdAt)",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":position": Number(row?.position ?? idx),
            ":values": JSON.stringify(values),
            ":updatedAtCustom": new Date().toISOString(),
            ":createdAt": String(row?.createdAt ?? new Date().toISOString()),
          },
        }),
      );
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        return json(403, { error: `Row ${idx + 1} does not belong to organization` });
      }
      throw err;
    }
  }

  for (const deletedId of deletedRowIds) {
    await ddb.send(
      new DeleteCommand({
        TableName: currentStorage.itemTable,
        Key: { id: deletedId },
        ConditionExpression: "organizationId = :org AND #module = :module",
        ExpressionAttributeNames: {
          "#module": "module",
        },
        ExpressionAttributeValues: {
          ":org": access.organizationId,
          ":module": "inventory",
        },
      }),
    );
  }

  return json(200, { ok: true });
};

const handleCreateColumn = async (access: AccessContext, body: any) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const label = String(body?.label ?? "").trim();
  const type = String(body?.type ?? "text").trim() as InventoryColumnType;
  if (!label) return json(400, { error: "Column label is required" });
  if (!["text", "number", "date", "link", "boolean"].includes(type)) {
    return json(400, { error: "Invalid column type" });
  }

  const columns = await ensureColumns(access.organizationId);
  const baseKey = toKey(label) || "custom_column";
  let key = baseKey;
  let suffix = 2;
  while (columns.some((column) => column.key === key)) {
    key = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  const lastColumn = columns.length > 0 ? columns[columns.length - 1] : undefined;
  const sortOrder = (lastColumn?.sortOrder ?? 0) + 10;
  const created: InventoryColumn = {
    id: randomUUID(),
    organizationId: access.organizationId,
    module: "inventory",
    key,
    label,
    type,
    isCore: false,
    isRequired: false,
    isVisible: true,
    isEditable: true,
    sortOrder,
    createdAt: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({ TableName: currentStorage.columnTable, Item: created }));
  return json(200, { column: created });
};

const handleDeleteColumn = async (access: AccessContext, path: string) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const columnRes = await ddb.send(
    new GetCommand({ TableName: currentStorage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isCore || CORE_KEYS.has(column.key)) {
    return json(400, { error: "Core columns cannot be deleted" });
  }

  await ddb.send(new DeleteCommand({ TableName: currentStorage.columnTable, Key: { id: columnId } }));
  return json(200, { ok: true });
};

const handleUpdateColumnVisibility = async (access: AccessContext, path: string, body: any) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)\/visibility$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const isVisible = body?.isVisible;
  if (typeof isVisible !== "boolean") {
    return json(400, { error: "isVisible boolean is required" });
  }

  const columnRes = await ddb.send(
    new GetCommand({ TableName: currentStorage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: currentStorage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET isVisible = :isVisible",
      ExpressionAttributeValues: {
        ":isVisible": isVisible,
      },
    }),
  );

  return json(200, { ok: true, columnId, isVisible });
};

const handleUpdateColumnLabel = async (access: AccessContext, path: string, body: any) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)\/label$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const label = String(body?.label ?? "").trim();
  if (!label) {
    return json(400, { error: "Column label is required" });
  }

  const columnRes = await ddb.send(
    new GetCommand({ TableName: currentStorage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isRequired) {
    return json(400, { error: "Required columns cannot be renamed" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: currentStorage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET #label = :label",
      ExpressionAttributeNames: {
        "#label": "label",
      },
      ExpressionAttributeValues: {
        ":label": label,
      },
    }),
  );

  return json(200, { ok: true, columnId, label });
};

const handleDeleteOrganizationStorage = async (
  access: AccessContext,
  query: Record<string, string | undefined>,
) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can delete organization storage" });
  }
  if (!ENABLE_PER_ORG_TABLES) {
    return json(400, { error: "Per-organization table mode is disabled" });
  }
  if (String(query.confirm ?? "").toUpperCase() !== "DELETE") {
    return json(400, { error: "Missing confirmation. Use ?confirm=DELETE" });
  }

  await deleteStorageForOrganization(access.organizationId);
  currentStorage = sharedStorage;
  return json(200, { ok: true });
};

const handleImportCsv = async (access: AccessContext, body: any) => {
  if (!access.canEditInventory) {
    return json(403, { error: "Insufficient permissions" });
  }

  const csvText = String(body?.csvText ?? "");
  if (!csvText.trim()) {
    return json(400, { error: "csvText is required" });
  }

  const parsed = parseCsv(csvText);
  if (parsed.length < 2) {
    return json(400, { error: "CSV must include a header row and at least one data row" });
  }

  let columns = await ensureColumns(access.organizationId);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const byLoose = new Map<string, InventoryColumn>();
  for (const column of columns) {
    byLoose.set(normalizeLooseKey(column.key), column);
    byLoose.set(normalizeLooseKey(column.label), column);
  }

  const requestedHeaderRowIndex = Number(body?.headerRowIndex);
  const headerRowIndex = Number.isInteger(requestedHeaderRowIndex) && requestedHeaderRowIndex >= 1
    ? requestedHeaderRowIndex - 1
    : detectHeaderRowIndex(parsed, byKey, byLoose);

  const headers = (parsed[headerRowIndex] ?? []).map((cell) => String(cell ?? "").trim());
  const dataRows = parsed
    .slice(headerRowIndex + 1)
    .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
  if (headers.length === 0 || dataRows.length === 0) {
    return json(400, { error: "CSV does not contain importable data" });
  }

  const mapping: Array<{ sourceIndex: number; header: string; column: InventoryColumn }> = [];
  const createdColumns: InventoryColumn[] = [];

  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const header = headers[headerIndex];
    if (!header) continue;
    const loose = normalizeLooseKey(header);
    const aliasKey = HEADER_ALIASES[loose];
    let mapped = (aliasKey ? byKey.get(aliasKey) : undefined) ?? byLoose.get(loose);

    if (!mapped) {
      if (!access.canManageColumns) {
        return json(403, {
          error: `Unknown column '${header}'. Only admins can auto-create new columns during import.`,
        });
      }

      const baseKey = toKey(header) || "column";
      let key = baseKey;
      let suffix = 2;
      while (byKey.has(key)) {
        key = `${baseKey}_${suffix}`;
        suffix += 1;
      }

      const lastColumn = columns.length > 0 ? columns[columns.length - 1] : undefined;
      const sortOrder = (lastColumn?.sortOrder ?? 0) + 10;
      const created: InventoryColumn = {
        id: randomUUID(),
        organizationId: access.organizationId,
        module: "inventory",
        key,
        label: header,
        type: "text",
        isCore: false,
        isRequired: false,
        isVisible: true,
        isEditable: true,
        sortOrder,
        createdAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: currentStorage.columnTable, Item: created }));

      columns = [...columns, created].sort((a, b) => a.sortOrder - b.sortOrder);
      byKey.set(created.key, created);
      byLoose.set(normalizeLooseKey(created.key), created);
      byLoose.set(normalizeLooseKey(created.label), created);
      createdColumns.push(created);
      mapped = created;
    }

    mapping.push({ sourceIndex: headerIndex, header, column: mapped });
  }

  const hasItemNameMapping = mapping.some((entry) => entry.column.key === "itemName");

  const existingItems = await listAllItems(access.organizationId);
  const existingByMatchKey = new Map<string, InventoryItem>();
  let maxPosition = -1;
  for (const item of existingItems) {
    maxPosition = Math.max(maxPosition, Number(item.position ?? 0));
    let parsedValues: Record<string, unknown> = {};
    try {
      parsedValues = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, unknown>;
    } catch {
      parsedValues = {};
    }
    const matchKey = buildImportMatchKey(parsedValues);
    if (matchKey) existingByMatchKey.set(matchKey, item);
  }

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of dataRows) {
    const isBlankMappedRow = mapping.every(
      (entry) => String(row[entry.sourceIndex] ?? "").trim() === "",
    );
    if (isBlankMappedRow) {
      skippedCount += 1;
      continue;
    }

    const values: Record<string, string | number | boolean | null> = {};
    for (const entry of mapping) {
      const cell = String(row[entry.sourceIndex] ?? "").trim();
      const target = entry.column;

      if (target.key === "expirationDate") {
        values[target.key] = parseDateToIsoDay(cell);
      } else if (target.key === "quantity" || target.key === "minQuantity") {
        const parsed = parseNonNegativeNumberOrBlank(cell);
        if (!parsed.ok) {
          const reason = "error" in parsed ? parsed.error : "must be a number";
          return json(400, {
            error: `Invalid ${target.label} value '${cell}' for item '${String(values.itemName ?? "").trim() || "unknown"}': ${reason}`,
          });
        }
        values[target.key] = parsed.value;
      } else {
        values[target.key] = cell;
      }
    }

    const matchKey = hasItemNameMapping ? buildImportMatchKey(values) : "";
    if (hasItemNameMapping && !matchKey) {
      skippedCount += 1;
      continue;
    }
    const existingMatch = matchKey ? existingByMatchKey.get(matchKey) : undefined;
    const isUpdate = !!existingMatch;
    const itemId = existingMatch?.id ?? randomUUID();
    const createdAt = existingMatch?.createdAt ?? new Date().toISOString();
    let mergedValues = values;
    if (existingMatch?.valuesJson) {
      try {
        const existingValues = JSON.parse(existingMatch.valuesJson) as Record<string, string | number | boolean | null>;
        mergedValues = {
          ...existingValues,
          ...values,
        };
      } catch {
        mergedValues = values;
      }
    }
    const position = existingMatch
      ? Number(existingMatch.position ?? 0)
      : (maxPosition += 1);

    const itemPayload: InventoryItem = {
      id: itemId,
      organizationId: access.organizationId,
      module: "inventory",
      position,
      valuesJson: JSON.stringify(mergedValues),
      createdAt,
      updatedAtCustom: new Date().toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: currentStorage.itemTable, Item: itemPayload }));
    if (isUpdate) {
      updatedCount += 1;
    } else {
      createdCount += 1;
      if (matchKey) {
        existingByMatchKey.set(matchKey, itemPayload);
      }
    }
  }

  return json(200, {
    ok: true,
    createdCount,
    updatedCount,
    skippedCount,
    importedRows: dataRows.length,
    headerRowIndex: headerRowIndex + 1,
    createdColumns: createdColumns.map((column) => ({
      id: column.id,
      key: column.key,
      label: column.label,
    })),
  });
};

export const handler = async (event: any) => {
  try {
    const method = getMethod(event);
    const path = getPath(event);
    const query = getQueryString(event);

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: corsHeaders,
        body: "",
      };
    }

    const access = await getAccessContext(event);
    currentStorage = await ensureStorageForOrganization(access.organizationId);

    if (method === "GET" && path.endsWith("/inventory/bootstrap")) {
      return handleBootstrap(access);
    }

    if (method === "GET" && path.endsWith("/inventory/items")) {
      return handleListItems(access, query);
    }

    if (method === "POST" && path.endsWith("/inventory/items/save")) {
      return handleSaveItems(access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/import-csv")) {
      return handleImportCsv(access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/columns")) {
      return handleCreateColumn(access, parseBody(event));
    }

    if (method === "POST" && /\/inventory\/columns\/[^/]+\/visibility$/.test(path)) {
      return handleUpdateColumnVisibility(access, path, parseBody(event));
    }

    if (method === "POST" && /\/inventory\/columns\/[^/]+\/label$/.test(path)) {
      return handleUpdateColumnLabel(access, path, parseBody(event));
    }

    if (method === "DELETE" && /\/inventory\/columns\/[^/]+$/.test(path)) {
      return handleDeleteColumn(access, path);
    }

    if (method === "DELETE" && path.endsWith("/inventory/organization-storage")) {
      return handleDeleteOrganizationStorage(access, query);
    }

    return json(404, { error: "Not found" });
  } catch (err: any) {
    const message = err?.message ?? "Internal server error";
    if (message === "Unauthorized") {
      return json(401, { error: "Unauthorized" });
    }
    console.error("inventoryApi error", err);
    return json(500, { error: message });
  }
};
