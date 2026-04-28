// ── Route handlers: vendors ──────────────────────────────────────────────────
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { getRegisteredVendors, saveRegisteredVendors } from "../vendors";
import { listAllItems } from "../items";

export const handleAddVendor = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const name = String(body?.name ?? "").trim();
  if (!name) return json(400, { error: "Vendor name is required" });
  if (name.length > 100) return json(400, { error: "Vendor name too long" });
  const existing = await getRegisteredVendors(storage);
  const duplicate = existing.find((v) => v.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    return json(409, { error: `A vendor named "${duplicate}" already exists` });
  }
  existing.push(name);
  existing.sort((a, b) => a.localeCompare(b));
  await saveRegisteredVendors(storage, existing);
  return json(200, { vendors: existing });
};

export const handleRemoveVendor = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const name = String(body?.name ?? "").trim();
  if (!name) return json(400, { error: "Vendor name is required" });
  const existing = await getRegisteredVendors(storage);
  const updated = existing.filter((v) => v !== name);
  await saveRegisteredVendors(storage, updated);

  // Clear the vendor from all items that reference it
  const items = await listAllItems(storage, "");
  let clearedCount = 0;
  for (const item of items) {
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(item.valuesJson ?? "{}") ?? {}; } catch { continue; }
    const vendor = String(values.vendor ?? "").trim();
    if (vendor !== name) continue;
    values.vendor = "";
    clearedCount++;
    await ddb.send(
      new PutCommand({
        TableName: storage.itemTable,
        Item: { ...item, valuesJson: JSON.stringify(values), updatedAtCustom: new Date().toISOString() },
      }),
    );
  }

  return json(200, { vendors: updated, clearedCount });
};

export const handleRenameVendor = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const oldName = String(body?.oldName ?? "").trim();
  const newName = String(body?.newName ?? "").trim();
  if (!oldName || !newName) return json(400, { error: "Both oldName and newName are required" });
  if (newName.length > 100) return json(400, { error: "Vendor name too long" });
  if (oldName === newName) return json(200, { vendors: await getRegisteredVendors(storage), renamedCount: 0 });

  const existing = await getRegisteredVendors(storage);
  const duplicate = existing.find(
    (v) => v !== oldName && v.toLowerCase() === newName.toLowerCase(),
  );
  if (duplicate) {
    return json(409, { error: `A vendor named "${duplicate}" already exists` });
  }
  const updated = existing.map((v) => (v === oldName ? newName : v));
  updated.sort((a, b) => a.localeCompare(b));
  await saveRegisteredVendors(storage, updated);

  const items = await listAllItems(storage, "");
  let renamedCount = 0;
  for (const item of items) {
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(item.valuesJson ?? "{}") ?? {}; } catch { continue; }
    const vendor = String(values.vendor ?? "").trim();
    if (vendor !== oldName) continue;
    values.vendor = newName;
    renamedCount++;
    await ddb.send(
      new PutCommand({
        TableName: storage.itemTable,
        Item: { ...item, valuesJson: JSON.stringify(values), updatedAtCustom: new Date().toISOString() },
      }),
    );
  }

  return json(200, { vendors: updated, renamedCount });
};
