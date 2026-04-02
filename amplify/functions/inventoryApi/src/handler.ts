// ── inventoryApi Lambda entry point ──────────────────────────────────────────
import { json, corsHeaders, parseBody, getPath, getMethod, getQueryString } from "./http";
import { getAccessContext } from "./access";
import { dispatch } from "./router";
import { InventoryStorageProvisioningError, isResourceInUse } from "./storage";
import { PROVISIONING_RETRY_AFTER_MS } from "./config";

export const handler = async (event: any) => {
  try {
    const method = getMethod(event);
    const path = getPath(event);
    const query = getQueryString(event);

    if (method === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders, body: "" };
    }

    const access = await getAccessContext(event);
    const body = parseBody(event);

    const result = await dispatch(method, path, access, body, query);
    if (result) return result;

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
    return json(500, { error: "Internal server error" });
  }
};
