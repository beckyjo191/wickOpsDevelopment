// ── Foundation: types.ts ────────────────────────────────────────────────────
// Pure type definitions extracted from handler.ts. No runtime code.

export type InventoryColumnType = "text" | "number" | "date" | "link" | "boolean";

export type UserRecord = {
  id: string;
  email?: string;
  displayName?: string;
  organizationId?: string;
  role?: string;
  accessSuspended?: boolean;
  allowedModules?: unknown;
  columnVisibility?: string;
};

export type InventoryColumn = {
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

export type InventoryItem = {
  id: string;
  organizationId: string;
  module: "inventory";
  position: number;
  valuesJson: string;
  createdAt: string;
  updatedAtCustom: string;
};

export type AccessContext = {
  userId: string;
  email: string;
  displayName: string;
  organizationId: string;
  role: string;
  /** Modules the org owner has activated (intersection of plan-available + owner-enabled) */
  orgEnabledModules: ModuleKey[];
  /** User's personal module subset — already intersected against orgEnabledModules */
  allowedModules: ModuleKey[];
  canEditInventory: boolean;
  canManageColumns: boolean;
  columnVisibilityOverrides: Record<string, boolean>;
};

export type InventoryStorage = {
  columnTable: string;
  itemTable: string;
  pendingTable: string;
  auditTable: string;
  restockOrdersTable: string;
};

export type ModuleKey = "inventory";

export type AuditAction =
  | "ITEM_CREATE"
  | "ITEM_EDIT"
  | "ITEM_DELETE"
  /** Quantity decrement with a loss reason (expired/damaged/lost/recalled). */
  | "ITEM_RETIRE"
  | "USAGE_SUBMIT"
  | "USAGE_APPROVE"
  | "USAGE_REJECT"
  | "COLUMN_CREATE"
  | "COLUMN_DELETE"
  | "COLUMN_UPDATE"
  | "CSV_IMPORT"
  | "TEMPLATE_APPLY"
  | "RESTOCK_ORDER_CREATE"
  | "RESTOCK_RECEIVED"
  | "RESTOCK_ORDER_CLOSED"
  /** Fast Restock: quantity added directly to an inventory row (not via an order). */
  | "RESTOCK_ADDED";

/** Reason codes attached to ITEM_RETIRE events. Drives loss analytics. */
export type RetireReason = "expired" | "damaged" | "lost" | "recalled";

export const RETIRE_REASONS: RetireReason[] = ["expired", "damaged", "lost", "recalled"];

export type PendingEntry = {
  itemId: string;
  itemName: string;
  quantityUsed: number;
  notes?: string;
  location?: string;
};

export type PendingSubmission = {
  id: string;
  submittedAt: string;
  submittedByUserId: string;
  submittedByEmail: string;
  submittedByName: string;
  status: "pending" | "approved" | "rejected";
  entriesJson: string;
  reviewedAt?: string;
  reviewedByUserId?: string;
  reviewedByEmail?: string;
  rejectionReason?: string;
};

export type TemplateColumn = {
  label: string;
  type: InventoryColumnType;
};

export type IndustryTemplate = {
  id: string;
  name: string;
  description: string;
  columns: TemplateColumn[];
};

export type RestockOrderStatus = "open" | "partial" | "closed";

export type RestockOrderItem = {
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost?: number;
  // For freeform items: vendor URL captured at order time so that when the
  // item is later added to inventory on receive, the link is persisted on the
  // new inventory row.
  reorderLink?: string;
  // For freeform items: location the item was ordered for. Persisted to the
  // new inventory row on receive (addToInventory) or on cancel materialization
  // so location-filtered views can find it.
  location?: string;
  // For freeform items: user-provided reorder threshold captured at order
  // time. When the item is later added to inventory on receive (or materialized
  // on cancel), this becomes the row's minQuantity so future reorder logic
  // triggers correctly. Falls back to qtyOrdered when absent.
  minQuantity?: number;
  // For freeform items: pack size (units per box). Persisted to the new
  // inventory row on receive so box-mode receiving / unit-cost derivation
  // work next time.
  packSize?: number;
  // For freeform items: pack cost (price per box). Persisted to the new
  // inventory row on receive.
  packCost?: number;
};

export type RestockReceiveLine = {
  itemId: string;
  qtyThisReceive: number;
  expirationDate?: string;
  unitCost?: number;
  addToInventory?: boolean;
};

export type RestockReceiveEvent = {
  receivedAt: string;
  receivedByUserId: string;
  receivedByName: string;
  lines: RestockReceiveLine[];
  closedOrder: boolean;
};

export type RestockOrder = {
  id: string;
  orgId: string;
  status: RestockOrderStatus;
  vendor?: string;
  notes?: string;
  createdAt: string;
  createdByUserId: string;
  createdByName: string;
  itemsJson: string;
  receivesJson: string;
  closedAt?: string;
  closedByUserId?: string;
  closedByName?: string;
};

export type LambdaResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type RouteContext = {
  access: AccessContext;
  storage: InventoryStorage;
  body: any;
  path: string;
  query: Record<string, string | undefined>;
};
