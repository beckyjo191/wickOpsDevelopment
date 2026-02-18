import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_TABLE = process.env.USER_TABLE!;
const INVENTORY_COLUMN_TABLE = process.env.INVENTORY_COLUMN_TABLE!;
const INVENTORY_ITEM_TABLE = process.env.INVENTORY_ITEM_TABLE!;

const EDIT_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"]);
const COLUMN_ADMIN_ROLES = new Set(["ADMIN", "OWNER", "ACCOUNT_OWNER"]);
const CORE_KEYS = new Set(["quantity", "minQuantity", "expirationDate"]);

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

const listColumns = async (organizationId: string): Promise<InventoryColumn[]> => {
  const out: InventoryColumn[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: INVENTORY_COLUMN_TABLE,
        FilterExpression: "organizationId = :org AND #module = :module",
        ExpressionAttributeNames: { "#module": "module" },
        ExpressionAttributeValues: { ":org": organizationId, ":module": "inventory" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    out.push(...((page.Items ?? []) as InventoryColumn[]));
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
      key: "link",
      label: "Link",
      type: "link",
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 20,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "category",
      label: "Category",
      type: "text",
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 30,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "location",
      label: "Location",
      type: "text",
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 40,
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
      sortOrder: 50,
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
      sortOrder: 60,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "unit",
      label: "Unit",
      type: "text",
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 70,
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
      sortOrder: 80,
      createdAt: new Date().toISOString(),
    },
    {
      organizationId,
      module: "inventory",
      key: "notes",
      label: "Notes",
      type: "text",
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      sortOrder: 90,
      createdAt: new Date().toISOString(),
    },
  ];

  for (const column of defaults) {
    await ddb.send(
      new PutCommand({
        TableName: INVENTORY_COLUMN_TABLE,
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
  const page = await ddb.send(
    new ScanCommand({
      TableName: INVENTORY_ITEM_TABLE,
      FilterExpression: "organizationId = :org AND #module = :module",
      ExpressionAttributeNames: { "#module": "module" },
      ExpressionAttributeValues: { ":org": organizationId, ":module": "inventory" },
      ExclusiveStartKey: startKey,
      Limit: limit,
    }),
  );
  const items = ((page.Items ?? []) as InventoryItem[]).sort(
    (a, b) => Number(a.position) - Number(b.position),
  );
  return {
    items,
    nextToken: encodeNextToken(page.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
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
  const { items, nextToken } = await listItemsPage(access.organizationId, 100);
  return json(200, {
    access,
    columns,
    items,
    nextToken,
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
  const existing = await listItemsPage(access.organizationId, 1000);
  const existingIds = new Set(existing.items.map((row) => row.id));
  const incomingIds = new Set<string>();

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    const rowId = String(row?.id ?? "").trim() || randomUUID();
    incomingIds.add(rowId);
    const itemPayload: InventoryItem = {
      id: rowId,
      organizationId: access.organizationId,
      module: "inventory",
      position: Number(row?.position ?? idx),
      valuesJson: JSON.stringify(row?.values ?? {}),
      createdAt: String(row?.createdAt ?? new Date().toISOString()),
      updatedAtCustom: new Date().toISOString(),
    };

    if (existingIds.has(rowId)) {
      await ddb.send(
        new UpdateCommand({
          TableName: INVENTORY_ITEM_TABLE,
          Key: { id: rowId },
          UpdateExpression:
            "SET organizationId = :org, #module = :module, #position = :position, valuesJson = :values, updatedAtCustom = :updatedAtCustom",
          ExpressionAttributeNames: {
            "#module": "module",
            "#position": "position",
          },
          ExpressionAttributeValues: {
            ":org": itemPayload.organizationId,
            ":module": itemPayload.module,
            ":position": itemPayload.position,
            ":values": itemPayload.valuesJson,
            ":updatedAtCustom": itemPayload.updatedAtCustom,
          },
        }),
      );
    } else {
      await ddb.send(
        new PutCommand({
          TableName: INVENTORY_ITEM_TABLE,
          Item: itemPayload,
        }),
      );
    }
  }

  for (const previous of existing.items) {
    if (!incomingIds.has(previous.id)) {
      await ddb.send(new DeleteCommand({ TableName: INVENTORY_ITEM_TABLE, Key: { id: previous.id } }));
    }
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

  const sortOrder = (columns.at(-1)?.sortOrder ?? 0) + 10;
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

  await ddb.send(new PutCommand({ TableName: INVENTORY_COLUMN_TABLE, Item: created }));
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
    new GetCommand({ TableName: INVENTORY_COLUMN_TABLE, Key: { id: columnId } }),
  );
  const column = columnRes.Item as InventoryColumn | undefined;
  if (!column) return json(404, { error: "Column not found" });
  if (normalizeOrgId(column.organizationId) !== access.organizationId) {
    return json(403, { error: "Column does not belong to organization" });
  }
  if (column.isCore || CORE_KEYS.has(column.key)) {
    return json(400, { error: "Core columns cannot be deleted" });
  }

  await ddb.send(new DeleteCommand({ TableName: INVENTORY_COLUMN_TABLE, Key: { id: columnId } }));
  return json(200, { ok: true });
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

    if (method === "GET" && path.endsWith("/inventory/bootstrap")) {
      return handleBootstrap(access);
    }

    if (method === "GET" && path.endsWith("/inventory/items")) {
      return handleListItems(access, query);
    }

    if (method === "POST" && path.endsWith("/inventory/items/save")) {
      return handleSaveItems(access, parseBody(event));
    }

    if (method === "POST" && path.endsWith("/inventory/columns")) {
      return handleCreateColumn(access, parseBody(event));
    }

    if (method === "DELETE" && /\/inventory\/columns\/[^/]+$/.test(path)) {
      return handleDeleteColumn(access, path);
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
