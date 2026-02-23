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
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";

const rawDdb = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(rawDdb);

const USER_TABLE = process.env.USER_TABLE!;
const ORG_TABLE = process.env.ORG_TABLE!;
const DEFAULT_INVENTORY_COLUMN_TABLE = process.env.INVENTORY_COLUMN_TABLE!;
const DEFAULT_INVENTORY_ITEM_TABLE = process.env.INVENTORY_ITEM_TABLE!;
const ENABLE_PER_ORG_TABLES =
  String(process.env.ENABLE_PER_ORG_INVENTORY_TABLES ?? "true").trim().toLowerCase() !== "false";
const INVENTORY_ORG_TABLE_PREFIX =
  String(process.env.INVENTORY_ORG_TABLE_PREFIX ?? "wickops-inventory").trim() ||
  "wickops-inventory";
const INVENTORY_STORAGE_NAMESPACE = createHash("sha256")
  .update(`${USER_TABLE}|${INVENTORY_ORG_TABLE_PREFIX}`)
  .digest("hex")
  .slice(0, 8);
const INVENTORY_COLUMN_BY_MODULE_INDEX = "ByModuleSortOrder";
const INVENTORY_ITEM_BY_MODULE_INDEX = "ByModulePosition";

const EDIT_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"]);
const COLUMN_ADMIN_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);
const CORE_KEYS = new Set(["quantity", "minQuantity", "expirationDate"]);
const STORAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const PROVISIONING_RETRY_AFTER_MS = 2000;
const ALL_MODULE_KEYS = ["inventory", "usage"] as const;
type ModuleKey = (typeof ALL_MODULE_KEYS)[number];

// Plan → module mapping. Unrecognized plan = no modules (no fallback to all).
const PLAN_MODULE_MAP: Record<string, ModuleKey[]> = {
  Personal:     ["inventory", "usage"],
  Department:   ["inventory", "usage"],
  Organization: ["inventory", "usage"],
};
const getAvailableModulesForPlan = (plan: string): ModuleKey[] =>
  PLAN_MODULE_MAP[plan] ?? [];

// Normalize a raw DDB value into a valid subset of allValid.
// null/absent → allValid (backward-compat: existing orgs without enabledModules get full access).
const normalizeModuleSubset = (value: unknown, allValid: ModuleKey[]): ModuleKey[] => {
  if (!Array.isArray(value)) return [...allValid];
  const s = new Set(allValid);
  const out = [
    ...new Set(
      value
        .map((i) => String(i ?? "").trim().toLowerCase())
        .filter((i): i is ModuleKey => s.has(i as ModuleKey)),
    ),
  ];
  return out.length > 0 ? out : [...allValid];
};

// Intersect user's stored allowedModules against the org-enabled superset.
// null/absent user value → grant full superset.
const getUserAllowedModules = (value: unknown, superset: ModuleKey[]): ModuleKey[] => {
  if (!Array.isArray(value)) return [...superset];
  const s = new Set(superset);
  const out = [
    ...new Set(
      value
        .map((i) => String(i ?? "").trim().toLowerCase())
        .filter((i): i is ModuleKey => s.has(i as ModuleKey)),
    ),
  ];
  return out.length > 0 ? out : [...superset];
};
const DEPLOYMENT_ENV = String(process.env.AMPLIFY_ENV ?? process.env.ENV ?? "")
  .trim()
  .toLowerCase();
const CORS_ALLOW_ORIGIN =
  DEPLOYMENT_ENV === "prod" || DEPLOYMENT_ENV === "production"
    ? "https://systems.wickops.com"
    : "http://localhost:5173";
const CORS_ALLOW_HEADERS = "Authorization,Content-Type";

type InventoryColumnType = "text" | "number" | "date" | "link" | "boolean";

type UserRecord = {
  id: string;
  email?: string;
  displayName?: string;
  organizationId?: string;
  role?: string;
  accessSuspended?: boolean;
  allowedModules?: unknown;
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
  email: string;
  organizationId: string;
  role: string;
  /** Modules the org owner has activated (intersection of plan-available + owner-enabled) */
  orgEnabledModules: ModuleKey[];
  /** User's personal module subset — already intersected against orgEnabledModules */
  allowedModules: ModuleKey[];
  canEditInventory: boolean;
  canManageColumns: boolean;
};

type InventoryStorage = {
  columnTable: string;
  itemTable: string;
};

const storageCache = new Map<string, { storage: InventoryStorage; checkedAt: number }>();

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
  "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  Vary: "Origin",
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
const normalizeEmail = (value: unknown): string => String(value ?? "").trim().toLowerCase();

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

const normalizeModuleKey = (value: unknown): ModuleKey | null => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (ALL_MODULE_KEYS as readonly string[]).includes(normalized)
    ? (normalized as ModuleKey)
    : null;
};

const hasModuleAccess = (
  access: AccessContext,
  required: ModuleKey | ModuleKey[],
): boolean => {
  const requiredModules = Array.isArray(required) ? required : [required];
  return requiredModules.some((moduleKey) => access.allowedModules.includes(moduleKey));
};

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
  return `${INVENTORY_ORG_TABLE_PREFIX}-${INVENTORY_STORAGE_NAMESPACE}-${safeOrg}-${hash}-${suffix}`;
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

class InventoryStorageProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryStorageProvisioningError";
  }
}

const isResourceInUse = (err: any): boolean =>
  err?.name === "ResourceInUseException" ||
  String(err?.__type ?? "").includes("ResourceInUseException");

const createOrgTableIfMissing = async (
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
    return { created: false };
  }

  try {
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
  } catch (err: any) {
    if (!isResourceInUse(err)) {
      throw err;
    }
  }

  try {
    await waitForTableActive(tableName);
    return { created: true };
  } catch {
    throw new InventoryStorageProvisioningError("Inventory storage is still provisioning");
  }
};

const ensureStorageForOrganization = async (organizationId: string): Promise<InventoryStorage> => {
  if (!ENABLE_PER_ORG_TABLES) {
    return {
      columnTable: DEFAULT_INVENTORY_COLUMN_TABLE,
      itemTable: DEFAULT_INVENTORY_ITEM_TABLE,
    };
  }

  const cached = storageCache.get(organizationId);
  const now = Date.now();
  if (cached && now - cached.checkedAt < STORAGE_CACHE_TTL_MS) {
    return cached.storage;
  }

  const storage: InventoryStorage = {
    columnTable: buildOrgScopedTableName(organizationId, "columns"),
    itemTable: buildOrgScopedTableName(organizationId, "items"),
  };

  await Promise.all([
    createOrgTableIfMissing(storage.columnTable, INVENTORY_COLUMN_BY_MODULE_INDEX, "sortOrder"),
    createOrgTableIfMissing(storage.itemTable, INVENTORY_ITEM_BY_MODULE_INDEX, "position"),
  ]);

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

const listColumns = async (storage: InventoryStorage): Promise<InventoryColumn[]> => {
  const out: InventoryColumn[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.columnTable,
        IndexName: INVENTORY_COLUMN_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
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
  const storage = await ensureStorageForOrganization(organizationId);
  const existing = await listColumns(storage);
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

  const coreColumnIdForKey = (key: string): string => `inventory-core-${key}`;

  for (const column of defaults) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: storage.columnTable,
          Item: {
            id: coreColumnIdForKey(column.key),
            ...column,
          },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    } catch (err: any) {
      if (err?.name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
  }

  return listColumns(storage);
};

const listItemsPage = async (
  storage: InventoryStorage,
  _organizationId: string,
  limit: number,
  startKey?: Record<string, unknown>,
): Promise<{ items: InventoryItem[]; nextToken: string | null }> => {
  const page = await ddb.send(
    new QueryCommand({
      TableName: storage.itemTable,
      IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
      KeyConditionExpression: "#module = :module",
      ExpressionAttributeNames: { "#module": "module" },
      ExpressionAttributeValues: { ":module": "inventory" },
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

const listAllItems = async (storage: InventoryStorage, _organizationId: string): Promise<InventoryItem[]> => {
  const out: InventoryItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: storage.itemTable,
        IndexName: INVENTORY_ITEM_BY_MODULE_INDEX,
        KeyConditionExpression: "#module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":module": "inventory" },
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

const isLikelyUrlValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^(https?:\/\/|www\.)\S+$/i.test(trimmed);
};

const normalizeLinkForImport = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const isPhoneHeader = (header: string): boolean =>
  /(phone|mobile|cell|tel|fax)/i.test(header);

const isLikelyPhoneValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/\D/g, "");
  const hasPhonePunctuation = /[()+\-\s]/.test(trimmed);
  if (digits.length === 10 && hasPhonePunctuation) return true;
  if (digits.length === 11 && digits.startsWith("1") && hasPhonePunctuation) return true;
  return false;
};

const formatPhoneNumber = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const extMatch = trimmed.match(/\b(?:ext\.?|x)\s*(\d{1,6})$/i);
  const ext = extMatch?.[1];
  const main = extMatch && extMatch.index !== undefined
    ? trimmed.slice(0, extMatch.index).trim()
    : trimmed;
  const digits = main.replace(/\D/g, "");

  let formatted = trimmed;
  if (digits.length === 10) {
    formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    formatted = `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return ext ? `${formatted} x${ext}` : formatted;
};

const parseBooleanOrBlank = (
  value: string,
): { ok: true; value: boolean | "" } | { ok: false; error: string } => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: "" };
  if (["true", "t", "yes", "y", "1"].includes(trimmed)) return { ok: true, value: true };
  if (["false", "f", "no", "n", "0"].includes(trimmed)) return { ok: true, value: false };
  return { ok: false, error: "must be a boolean value (true/false, yes/no, 1/0)" };
};

const parseNumberOrBlank = (
  value: string,
): { ok: true; value: number | "" } | { ok: false; error: string } => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "must be a number" };
  }
  return { ok: true, value: parsed };
};

const isDateValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return true;
  const parsed = new Date(trimmed);
  return !Number.isNaN(parsed.getTime());
};

const inferColumnType = (
  header: string,
  sourceIndex: number,
  dataRows: string[][],
): InventoryColumnType => {
  const values = dataRows
    .map((row) => String(row[sourceIndex] ?? "").trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return "text";

  if (values.every((value) => isLikelyUrlValue(value))) return "link";
  if (values.every((value) => parseBooleanOrBlank(value).ok)) return "boolean";
  if (values.every((value) => isDateValue(value))) return "date";
  if (isPhoneHeader(header) || values.every((value) => isLikelyPhoneValue(value))) return "text";
  if (values.every((value) => parseNumberOrBlank(value).ok)) return "number";
  return "text";
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

const normalizeFingerprintValue = (column: InventoryColumn, value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  if (column.key === "expirationDate" || column.type === "date") {
    return parseDateToIsoDay(raw);
  }

  if (column.key === "quantity" || column.key === "minQuantity" || column.type === "number") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? String(parsed) : raw;
  }

  if (column.type === "boolean") {
    if (typeof value === "boolean") return value ? "true" : "false";
    const parsed = parseBooleanOrBlank(raw);
    if (parsed.ok && parsed.value !== "") {
      return parsed.value ? "true" : "false";
    }
    return raw.toLowerCase();
  }

  if (column.type === "link") {
    return normalizeLinkForImport(raw).toLowerCase();
  }

  return raw.toLowerCase();
};

const buildImportRowFingerprint = (
  mapping: Array<{ sourceIndex: number; header: string; column: InventoryColumn }>,
  values: Record<string, unknown>,
): string => {
  if (mapping.length === 0) return "";
  return mapping
    .map((entry) => `${entry.column.key}:${normalizeFingerprintValue(entry.column, values[entry.column.key])}`)
    .join("||");
};

const areValueRecordsEqual = (
  left: Record<string, string | number | boolean | null>,
  right: Record<string, string | number | boolean | null>,
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? null) !== (right[key] ?? null)) {
      return false;
    }
  }
  return true;
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
  const claimEmail = claims?.email ? normalizeEmail(claims.email) : "";

  const userRes = await ddb.send(new GetCommand({ TableName: USER_TABLE, Key: { id: userId } }));
  const user = userRes.Item as UserRecord | undefined;
  if (!user || !user.organizationId) {
    throw new Error("User or organization not found");
  }
  if (claimEmail) {
    const persistedEmail = normalizeEmail(user.email);
    if (persistedEmail && persistedEmail !== claimEmail) {
      await ddb.send(
        new UpdateCommand({
          TableName: USER_TABLE,
          Key: { id: userId },
          ConditionExpression: "organizationId = :org",
          UpdateExpression: "SET email = :email",
          ExpressionAttributeValues: {
            ":org": normalizeOrgId(user.organizationId),
            ":email": claimEmail,
          },
        }),
      );
      user.email = claimEmail;
    }
  }
  if (user.accessSuspended) {
    throw new Error("Access suspended");
  }

  const role = normalizeRole(user.role);
  const organizationId = normalizeOrgId(user.organizationId);

  // Load org to compute the two-layer module access:
  //   plan → available pool → org owner's enabled subset → user's personal subset
  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: organizationId } }),
  );
  const org = orgRes.Item;
  const orgAvailable = getAvailableModulesForPlan(String(org?.plan ?? ""));
  const orgEnabledModules = normalizeModuleSubset(org?.enabledModules, orgAvailable);
  const allowedModules = getUserAllowedModules(user.allowedModules, orgEnabledModules);

  return {
    userId,
    email: claimEmail,
    organizationId,
    role,
    orgEnabledModules,
    allowedModules,
    canEditInventory: EDIT_ROLES.has(role),
    canManageColumns: COLUMN_ADMIN_ROLES.has(role),
  };
};

const OWNER_ROLES = new Set(["OWNER", "ACCOUNT_OWNER"]);

/** GET /inventory/org-modules — returns org's plan, available modules, and owner-enabled modules */
const handleGetOrgModules = async (access: AccessContext) => {
  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: access.organizationId } }),
  );
  const org = orgRes.Item;
  if (!org) return json(404, { error: "Organization not found" });

  const plan = String(org.plan ?? "");
  const orgAvailableModules = getAvailableModulesForPlan(plan);
  const orgEnabledModules = normalizeModuleSubset(org.enabledModules, orgAvailableModules);

  return json(200, { plan, orgAvailableModules, orgEnabledModules });
};

/** POST /inventory/org-modules — owner activates/deactivates modules from the plan pool */
const handleUpdateOrgModules = async (access: AccessContext, body: any) => {
  if (!OWNER_ROLES.has(access.role)) {
    return json(403, { error: "Only organization owners can manage module activation." });
  }

  const orgRes = await ddb.send(
    new GetCommand({ TableName: ORG_TABLE, Key: { id: access.organizationId } }),
  );
  const org = orgRes.Item;
  if (!org) return json(404, { error: "Organization not found" });

  const plan = String(org.plan ?? "");
  const orgAvailableModules = getAvailableModulesForPlan(plan);

  // Validate that requested modules are a subset of the plan's available pool
  const requested = normalizeModuleSubset(body?.enabledModules, orgAvailableModules);
  const safeEnabled = requested.filter((key) => orgAvailableModules.includes(key));
  if (safeEnabled.length === 0) {
    return json(400, { error: "At least one module must remain enabled." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: ORG_TABLE,
      Key: { id: access.organizationId },
      UpdateExpression: "SET enabledModules = :modules",
      ExpressionAttributeValues: { ":modules": safeEnabled },
    }),
  );

  return json(200, { ok: true, orgEnabledModules: safeEnabled });
};

const handleListModuleAccessUsers = async (access: AccessContext) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage module access" });
  }

  const users: Array<{
    userId: string;
    email: string;
    displayName: string;
    role: string;
    allowedModules: ModuleKey[];
  }> = [];

  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: USER_TABLE,
        FilterExpression: "organizationId = :org",
        ExpressionAttributeValues: {
          ":org": access.organizationId,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const user = item as UserRecord;
      users.push({
        userId: String(user.id ?? ""),
        email: normalizeEmail(user.email),
        displayName: String(user.displayName ?? ""),
        role: normalizeRole(user.role),
        allowedModules: getUserAllowedModules(user.allowedModules, access.orgEnabledModules),
      });
    }
    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  users.sort((a, b) => {
    const aName = a.displayName.trim() || a.email || a.userId;
    const bName = b.displayName.trim() || b.email || b.userId;
    return aName.localeCompare(bName);
  });

  return json(200, {
    modules: access.orgEnabledModules,
    users,
  });
};

const handleUpdateUserModuleAccess = async (
  access: AccessContext,
  path: string,
  body: any,
) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage module access" });
  }

  const match = path.match(/\/inventory\/module-access\/users\/([^/]+)$/);
  const targetUserId = String(match?.[1] ?? "").trim();
  if (!targetUserId) {
    return json(400, { error: "User id is required" });
  }

  const rawModules = Array.isArray(body?.allowedModules)
    ? Array.from(
        new Set(
          body.allowedModules
            .map((item: unknown) => normalizeModuleKey(item))
            .filter((item: ModuleKey | null): item is ModuleKey => !!item),
        ),
      )
    : null;
  if (!rawModules) {
    return json(400, { error: "allowedModules must be an array." });
  }
  // Clamp to org-enabled modules — admins cannot grant modules the org hasn't activated
  const requestedAllowedModules = rawModules.filter((key: ModuleKey) =>
    access.orgEnabledModules.includes(key),
  );
  if (requestedAllowedModules.length === 0) {
    return json(400, { error: "At least one org-enabled module must be included." });
  }
  if (targetUserId === access.userId) {
    return json(400, { error: "You cannot change your own module access." });
  }

  const targetRes = await ddb.send(
    new GetCommand({
      TableName: USER_TABLE,
      Key: { id: targetUserId },
    }),
  );
  const targetUser = targetRes.Item as UserRecord | undefined;
  if (!targetUser || normalizeOrgId(targetUser.organizationId) !== normalizeOrgId(access.organizationId)) {
    return json(404, { error: "User not found" });
  }
  if (access.email && normalizeEmail(targetUser.email) === access.email) {
    return json(400, { error: "You cannot change your own module access." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: targetUserId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET allowedModules = :allowedModules",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":allowedModules": requestedAllowedModules,
      },
    }),
  );

  return json(200, {
    ok: true,
    userId: targetUserId,
    allowedModules: requestedAllowedModules,
  });
};

const handleUpdateCurrentUserDisplayName = async (access: AccessContext, body: any) => {
  const displayName = String(body?.displayName ?? "").trim();
  if (!displayName) {
    return json(400, { error: "displayName is required." });
  }
  if (displayName.length > 120) {
    return json(400, { error: "displayName is too long." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: access.userId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET displayName = :displayName",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":displayName": displayName,
      },
    }),
  );

  return json(200, {
    ok: true,
    displayName,
  });
};

const handleSyncCurrentUserEmail = async (access: AccessContext) => {
  if (!access.email) {
    return json(400, { error: "Email claim is required." });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: USER_TABLE,
      Key: { id: access.userId },
      ConditionExpression: "organizationId = :org",
      UpdateExpression: "SET email = :email",
      ExpressionAttributeValues: {
        ":org": access.organizationId,
        ":email": access.email,
      },
    }),
  );

  return json(200, {
    ok: true,
    email: access.email,
  });
};

const handleBootstrap = async (storage: InventoryStorage, access: AccessContext) => {
  const columns = await ensureColumns(access.organizationId);
  const items = await listAllItems(storage, access.organizationId);
  return json(200, {
    access,
    columns,
    items,
    nextToken: null,
  });
};

const handleListItems = async (
  storage: InventoryStorage,
  access: AccessContext,
  query: Record<string, string | undefined>,
) => {
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 250);
  const start = parseNextToken(query.nextToken);
  const page = await listItemsPage(storage, access.organizationId, limit, start);
  return json(200, page);
};

const handleSaveItems = async (storage: InventoryStorage, access: AccessContext, body: any) => {
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
          TableName: storage.itemTable,
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
        TableName: storage.itemTable,
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

const handleSubmitUsage = async (storage: InventoryStorage, access: AccessContext, body: any) => {
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    return json(400, { error: "At least one usage entry is required." });
  }

  const usageByItemId = new Map<string, { quantityUsed: number; location?: string }>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const itemId = String(entry?.itemId ?? "").trim();
    if (!itemId) {
      return json(400, { error: `Entry ${i + 1}: itemId is required.` });
    }
    const quantityUsed = Number(entry?.quantityUsed);
    if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
      return json(400, { error: "Used quantity must be greater than 0." });
    }
    const location = String(entry?.location ?? "").trim();
    const existing = usageByItemId.get(itemId);
    if (!existing) {
      usageByItemId.set(itemId, {
        quantityUsed,
        location: location || undefined,
      });
      continue;
    }

    if (existing.location && location && existing.location !== location) {
      return json(400, { error: `Entry ${i + 1}: conflicting locations for the same item.` });
    }

    existing.quantityUsed += quantityUsed;
    if (!existing.location && location) existing.location = location;
    usageByItemId.set(itemId, existing);
  }

  const items = await listAllItems(storage, access.organizationId);
  const byId = new Map(items.map((item) => [String(item.id), item]));
  let updatedCount = 0;

  let itemCounter = 0;
  for (const [itemId, entry] of usageByItemId) {
    itemCounter += 1;
    const item = byId.get(itemId);
    if (!item) {
      return json(404, { error: `Entry ${itemCounter}: item not found.` });
    }

    let values: Record<string, string | number | boolean | null> = {};
    try {
      values = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, string | number | boolean | null>;
    } catch {
      values = {};
    }
    const itemLocation = String(values.location ?? "").trim();
    if (entry.location && itemLocation && entry.location !== itemLocation) {
      return json(400, { error: `Entry ${itemCounter}: location does not match inventory.` });
    }

    const currentQuantityRaw = values.quantity;
    const currentQuantity = Number(currentQuantityRaw ?? 0);
    if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
      return json(400, { error: `Entry ${itemCounter}: current quantity is invalid.` });
    }
    if (entry.quantityUsed > currentQuantity) {
      return json(400, {
        error: `Entry ${itemCounter}: usage (${entry.quantityUsed}) exceeds available quantity (${currentQuantity}).`,
      });
    }

    const nextQuantity = currentQuantity - entry.quantityUsed;
    const nextValues = {
      ...values,
      quantity: nextQuantity,
    };

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: storage.itemTable,
          Key: { id: item.id },
          ConditionExpression: "organizationId = :org AND #module = :module",
          UpdateExpression: "SET valuesJson = :values, updatedAtCustom = :updatedAtCustom",
          ExpressionAttributeNames: {
            "#module": "module",
          },
          ExpressionAttributeValues: {
            ":org": access.organizationId,
            ":module": "inventory",
            ":values": JSON.stringify(nextValues),
            ":updatedAtCustom": new Date().toISOString(),
          },
        }),
      );
      updatedCount += 1;
    } catch (err: any) {
      if (err?.name === "ConditionalCheckFailedException") {
        return json(403, { error: `Entry ${itemCounter}: item does not belong to organization.` });
      }
      throw err;
    }
  }

  return json(200, { ok: true, updatedCount });
};

const handleCreateColumn = async (storage: InventoryStorage, access: AccessContext, body: any) => {
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

  await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: created }));
  return json(200, { column: created });
};

const handleDeleteColumn = async (storage: InventoryStorage, access: AccessContext, path: string) => {
  if (!access.canManageColumns) {
    return json(403, { error: "Only admins can manage inventory columns" });
  }

  const match = path.match(/\/inventory\/columns\/([^/]+)$/);
  const columnId = match?.[1];
  if (!columnId) return json(400, { error: "Column id is required" });

  const columnRes = await ddb.send(
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isCore || CORE_KEYS.has(column.key)) {
    return json(400, { error: "Core columns cannot be deleted" });
  }

  await ddb.send(new DeleteCommand({ TableName: storage.columnTable, Key: { id: columnId } }));
  return json(200, { ok: true });
};

const handleUpdateColumnVisibility = async (
  storage: InventoryStorage,
  access: AccessContext,
  path: string,
  body: any,
) => {
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
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: storage.columnTable,
      Key: { id: columnId },
      UpdateExpression: "SET isVisible = :isVisible",
      ExpressionAttributeValues: {
        ":isVisible": isVisible,
      },
    }),
  );

  return json(200, { ok: true, columnId, isVisible });
};

const handleUpdateColumnLabel = async (
  storage: InventoryStorage,
  access: AccessContext,
  path: string,
  body: any,
) => {
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
    new GetCommand({ TableName: storage.columnTable, Key: { id: columnId } }),
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
      TableName: storage.columnTable,
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
  return json(200, { ok: true });
};

const handleImportCsv = async (storage: InventoryStorage, access: AccessContext, body: any) => {
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

  const requestedHeaders = Array.isArray(body?.selectedHeaders)
    ? body.selectedHeaders
      .map((value: unknown) => String(value ?? "").trim())
      .filter((value: string) => value.length > 0)
    : [];
  const selectedHeaderLooseSet =
    requestedHeaders.length > 0
      ? new Set(requestedHeaders.map((header: string) => normalizeLooseKey(header)))
      : null;
  if (selectedHeaderLooseSet) {
    const availableLooseSet = new Set(headers.map((header) => normalizeLooseKey(header)));
    const missingRequested = requestedHeaders.filter(
      (header: string) => !availableLooseSet.has(normalizeLooseKey(header)),
    );
    if (missingRequested.length > 0) {
      return json(400, {
        error: `Selected columns not found in CSV: ${missingRequested.join(", ")}`,
      });
    }
  }
  const allowUpdates = body?.allowUpdates === true;

  const mapping: Array<{ sourceIndex: number; header: string; column: InventoryColumn }> = [];
  const createdColumns: InventoryColumn[] = [];

  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const header = headers[headerIndex];
    if (!header) continue;
    const loose = normalizeLooseKey(header);
    if (selectedHeaderLooseSet && !selectedHeaderLooseSet.has(loose)) {
      continue;
    }
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
        type: inferColumnType(header, headerIndex, dataRows),
        isCore: false,
        isRequired: false,
        isVisible: true,
        isEditable: true,
        sortOrder,
        createdAt: new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: storage.columnTable, Item: created }));

      columns = [...columns, created].sort((a, b) => a.sortOrder - b.sortOrder);
      byKey.set(created.key, created);
      byLoose.set(normalizeLooseKey(created.key), created);
      byLoose.set(normalizeLooseKey(created.label), created);
      createdColumns.push(created);
      mapped = created;
    }

    mapping.push({ sourceIndex: headerIndex, header, column: mapped });
  }

  if (mapping.length === 0) {
    return json(400, { error: "No selected columns could be mapped for import." });
  }

  const hasItemNameMapping = mapping.some((entry) => entry.column.key === "itemName");

  const existingItems = await listAllItems(storage, access.organizationId);
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
  let duplicateSkippedCount = 0;
  const existingFingerprintSet = new Set<string>();
  for (const item of existingItems) {
    let parsedValues: Record<string, unknown> = {};
    try {
      parsedValues = JSON.parse(String(item.valuesJson ?? "{}")) as Record<string, unknown>;
    } catch {
      parsedValues = {};
    }
    const fingerprint = buildImportRowFingerprint(mapping, parsedValues);
    if (fingerprint) {
      existingFingerprintSet.add(fingerprint);
    }
  }

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const row = dataRows[rowIndex];
    const csvRowNumber = headerRowIndex + 2 + rowIndex;
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
            error: `Row ${csvRowNumber}: Invalid ${target.label} value '${cell}' for item '${String(values.itemName ?? "").trim() || "unknown"}': ${reason}`,
          });
        }
        values[target.key] = parsed.value;
      } else if (target.type === "date") {
        values[target.key] = parseDateToIsoDay(cell);
      } else if (target.type === "number") {
        const parsed = parseNumberOrBlank(cell);
        if (!parsed.ok) {
          const reason = "error" in parsed ? parsed.error : "must be a number";
          return json(400, {
            error: `Row ${csvRowNumber}: Invalid ${target.label} value '${cell}': ${reason}`,
          });
        }
        values[target.key] = parsed.value;
      } else if (target.type === "boolean") {
        const parsed = parseBooleanOrBlank(cell);
        if (!parsed.ok) {
          const reason = "error" in parsed ? parsed.error : "must be boolean";
          return json(400, {
            error: `Row ${csvRowNumber}: Invalid ${target.label} value '${cell}': ${reason}`,
          });
        }
        values[target.key] = parsed.value;
      } else if (target.type === "link") {
        values[target.key] = normalizeLinkForImport(cell);
      } else {
        values[target.key] =
          (isPhoneHeader(entry.header) || isLikelyPhoneValue(cell))
            ? formatPhoneNumber(cell)
            : cell;
      }
    }

    const matchKey = hasItemNameMapping ? buildImportMatchKey(values) : "";
    if (hasItemNameMapping && !matchKey) {
      skippedCount += 1;
      continue;
    }
    const existingMatch = matchKey ? existingByMatchKey.get(matchKey) : undefined;
    const rowFingerprint = buildImportRowFingerprint(mapping, values);
    if (!existingMatch && rowFingerprint && existingFingerprintSet.has(rowFingerprint)) {
      skippedCount += 1;
      duplicateSkippedCount += 1;
      continue;
    }
    if (existingMatch && !allowUpdates) {
      skippedCount += 1;
      duplicateSkippedCount += 1;
      if (rowFingerprint) {
        existingFingerprintSet.add(rowFingerprint);
      }
      continue;
    }
    const isUpdate = !!existingMatch;
    const itemId = existingMatch?.id ?? randomUUID();
    const createdAt = existingMatch?.createdAt ?? new Date().toISOString();
    let existingValues: Record<string, string | number | boolean | null> | null = null;
    let mergedValues = values;
    if (existingMatch?.valuesJson) {
      try {
        existingValues = JSON.parse(existingMatch.valuesJson) as Record<string, string | number | boolean | null>;
        mergedValues = {
          ...existingValues,
          ...values,
        };
      } catch {
        existingValues = null;
        mergedValues = values;
      }
    }
    const position = existingMatch
      ? Number(existingMatch.position ?? 0)
      : (maxPosition += 1);
    if (
      isUpdate &&
      existingValues &&
      areValueRecordsEqual(existingValues, mergedValues)
    ) {
      skippedCount += 1;
      duplicateSkippedCount += 1;
      if (rowFingerprint) {
        existingFingerprintSet.add(rowFingerprint);
      }
      continue;
    }

    const itemPayload: InventoryItem = {
      id: itemId,
      organizationId: access.organizationId,
      module: "inventory",
      position,
      valuesJson: JSON.stringify(mergedValues),
      createdAt,
      updatedAtCustom: new Date().toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: storage.itemTable, Item: itemPayload }));
    if (isUpdate) {
      updatedCount += 1;
    } else {
      createdCount += 1;
      if (matchKey) {
        existingByMatchKey.set(matchKey, itemPayload);
      }
      if (rowFingerprint) {
        existingFingerprintSet.add(rowFingerprint);
      }
    }
  }

  if (createdCount === 0 && updatedCount === 0 && duplicateSkippedCount > 0) {
    return json(409, {
      error:
        duplicateSkippedCount === 1
          ? "Import canceled: that row is already in inventory."
          : `Import canceled: all ${duplicateSkippedCount} rows are already in inventory.`,
      duplicateSkippedCount,
      importedRows: dataRows.length,
    });
  }

  return json(200, {
    ok: true,
    createdCount,
    updatedCount,
    skippedCount,
    duplicateSkippedCount,
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

    if (method === "GET" && path.endsWith("/inventory/org-modules")) {
      return handleGetOrgModules(access);
    }

    if (method === "POST" && path.endsWith("/inventory/org-modules")) {
      return handleUpdateOrgModules(access, parseBody(event));
    }

    if (method === "GET" && path.endsWith("/inventory/module-access/users")) {
      return handleListModuleAccessUsers(access);
    }

    if (method === "POST" && /\/inventory\/module-access\/users\/[^/]+$/.test(path)) {
      return handleUpdateUserModuleAccess(access, path, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/profile/display-name")) {
      return handleUpdateCurrentUserDisplayName(access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/profile/email/sync")) {
      return handleSyncCurrentUserEmail(access);
    }

    const storage = await ensureStorageForOrganization(access.organizationId);

    if (method === "GET" && path.endsWith("/inventory/bootstrap")) {
      if (!hasModuleAccess(access, ["inventory", "usage"])) {
        return json(403, { error: "Module access denied" });
      }
      return handleBootstrap(storage, access);
    }

    if (method === "GET" && path.endsWith("/inventory/items")) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleListItems(storage, access, query);
    }

    if (method === "POST" && path.endsWith("/inventory/items/save")) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleSaveItems(storage, access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/usage/submit")) {
      if (!hasModuleAccess(access, "usage")) {
        return json(403, { error: "Module access denied" });
      }
      return handleSubmitUsage(storage, access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/import-csv")) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleImportCsv(storage, access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/columns")) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleCreateColumn(storage, access, parseBody(event));
    }

    if (method === "POST" && /\/inventory\/columns\/[^/]+\/visibility$/.test(path)) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleUpdateColumnVisibility(storage, access, path, parseBody(event));
    }

    if (method === "POST" && /\/inventory\/columns\/[^/]+\/label$/.test(path)) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleUpdateColumnLabel(storage, access, path, parseBody(event));
    }

    if (method === "DELETE" && /\/inventory\/columns\/[^/]+$/.test(path)) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleDeleteColumn(storage, access, path);
    }

    if (method === "DELETE" && path.endsWith("/inventory/organization-storage")) {
      if (!hasModuleAccess(access, "inventory")) {
        return json(403, { error: "Module access denied" });
      }
      return handleDeleteOrganizationStorage(access, query);
    }

    return json(404, { error: "Not found" });
  } catch (err: any) {
    const message = err?.message ?? "Internal server error";
    if (message === "Unauthorized") {
      return json(401, { error: "Unauthorized" });
    }
    if (message === "Identity mismatch" || message === "Access suspended") {
      return json(403, { error: message });
    }
    if (err instanceof InventoryStorageProvisioningError || isResourceInUse(err)) {
      return json(202, {
        error: "Inventory storage is still provisioning",
        code: "INVENTORY_STORAGE_PROVISIONING",
        retryAfterMs: PROVISIONING_RETRY_AFTER_MS,
      });
    }
    console.error("inventoryApi error", err);
    return json(500, { error: message });
  }
};
