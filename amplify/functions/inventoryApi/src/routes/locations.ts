// ── Route handlers: locations ────────────────────────────────────────────────
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { RouteContext } from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { getRegisteredLocations, saveRegisteredLocations } from "../locations";
import { listAllItems } from "../items";

export const handleAddLocation = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const name = String(body?.name ?? "").trim();
  if (!name) return json(400, { error: "Location name is required" });
  if (name.length > 100) return json(400, { error: "Location name too long" });
  const existing = await getRegisteredLocations(storage);
  // Case-insensitive duplicate check
  const duplicate = existing.find((l) => l.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    return json(409, { error: `A location named "${duplicate}" already exists` });
  }
  existing.push(name);
  existing.sort((a, b) => a.localeCompare(b));
  await saveRegisteredLocations(storage, existing);
  return json(200, { locations: existing });
};

export const handleRemoveLocation = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const name = String(body?.name ?? "").trim();
  if (!name) return json(400, { error: "Location name is required" });
  const existing = await getRegisteredLocations(storage);
  const updated = existing.filter((l) => l !== name);
  await saveRegisteredLocations(storage, updated);

  // Clear the location from all items that reference it
  const items = await listAllItems(storage, "");
  let clearedCount = 0;
  for (const item of items) {
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(item.valuesJson ?? "{}") ?? {}; } catch { continue; }
    const loc = String(values.location ?? "").trim();
    if (loc !== name) continue;
    values.location = "";
    clearedCount++;
    await ddb.send(
      new PutCommand({
        TableName: storage.itemTable,
        Item: { ...item, valuesJson: JSON.stringify(values), updatedAtCustom: new Date().toISOString() },
      }),
    );
  }

  return json(200, { locations: updated, clearedCount });
};

export const handleRenameLocation = async (ctx: RouteContext) => {
  const { storage, access, body } = ctx;
  if (!access.canEditInventory) return json(403, { error: "Insufficient permissions" });
  const oldName = String(body?.oldName ?? "").trim();
  const newName = String(body?.newName ?? "").trim();
  if (!oldName || !newName) return json(400, { error: "Both oldName and newName are required" });
  if (newName.length > 100) return json(400, { error: "Location name too long" });
  if (oldName === newName) return json(200, { locations: await getRegisteredLocations(storage), renamedCount: 0 });

  // Update registry
  const existing = await getRegisteredLocations(storage);
  // Case-insensitive duplicate check (ignore the location being renamed)
  const duplicate = existing.find(
    (l) => l !== oldName && l.toLowerCase() === newName.toLowerCase(),
  );
  if (duplicate) {
    return json(409, { error: `A location named "${duplicate}" already exists` });
  }
  const updated = existing.map((l) => (l === oldName ? newName : l));
  updated.sort((a, b) => a.localeCompare(b));
  await saveRegisteredLocations(storage, updated);

  // Update all items that have the old location value
  const items = await listAllItems(storage, "");
  let renamedCount = 0;
  for (const item of items) {
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(item.valuesJson ?? "{}") ?? {}; } catch { continue; }
    const loc = String(values.location ?? "").trim();
    if (loc !== oldName) continue;
    values.location = newName;
    renamedCount++;
    await ddb.send(
      new PutCommand({
        TableName: storage.itemTable,
        Item: { ...item, valuesJson: JSON.stringify(values), updatedAtCustom: new Date().toISOString() },
      }),
    );
  }

  return json(200, { locations: updated, renamedCount });
};
