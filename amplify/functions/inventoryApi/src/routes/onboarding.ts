// ── Onboarding template handlers ────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { InventoryColumn, RouteContext } from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { OWNER_ROLES, ORG_TABLE } from "../config";
import { normalizeLooseKey, toKey } from "../normalize";
import { buildAuditEvent, writeAuditEvents } from "../audit";
import { listColumns, listLocations } from "../columns";
import { createLocation } from "../locations";
import { INDUSTRY_TEMPLATES } from "../templates";
import { DEFAULT_LOCATION_NAME } from "../migration";

export const handleListOnboardingTemplates = async (_ctx: RouteContext) => {
  return json(200, { templates: INDUSTRY_TEMPLATES });
};

export const handleApplyOnboardingTemplate = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
  if (!OWNER_ROLES.has(access.role)) {
    return json(403, { error: "Only organization owners can apply onboarding templates." });
  }

  const templateId = String(body?.templateId ?? "").trim();

  // Mark the org as onboarded regardless of template choice.
  await ddb.send(
    new UpdateCommand({
      TableName: ORG_TABLE,
      Key: { id: access.organizationId },
      UpdateExpression: "SET onboardingCompleted = :done",
      ExpressionAttributeValues: { ":done": true },
    }),
  );

  if (!templateId || templateId === "skip") {
    return json(200, { ok: true, addedColumns: [] });
  }

  const template = INDUSTRY_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    return json(200, { ok: true, addedColumns: [] });
  }

  // Only add template columns when the org has just the default core column
  // set (no user customizations yet). Post-restructure the core set is 10
  // columns; computed dynamically by counting isCore rows so future core
  // changes don't drift this check.
  const existing = await listColumns(storage);
  const coreCount = existing.filter((c) => c.isCore).length;
  if (existing.length > coreCount) {
    return json(200, { ok: true, addedColumns: [], skipped: true });
  }

  // Ensure at least one location exists so attached columns have something
  // to point at. The Default location is the canonical home for new orgs.
  let locations = await listLocations(storage);
  if (locations.length === 0) {
    const created = await createLocation(
      storage,
      access.organizationId,
      DEFAULT_LOCATION_NAME,
      10,
    );
    locations = [created];
  }
  const allLocationIds = locations.map((l) => l.id);

  const existingLooseLabels = new Set(
    existing.map((c) => normalizeLooseKey(c.label)),
  );

  let sortOrder = (existing[existing.length - 1]?.sortOrder ?? 100) + 10;
  const addedColumns: Array<{ label: string; key: string }> = [];

  for (const col of template.columns) {
    // Skip if a column with this label already exists (e.g. "Notes")
    if (existingLooseLabels.has(normalizeLooseKey(col.label))) continue;
    // Templates may still ship a "Location" column for backward compat with
    // legacy template definitions. Drop it — location is structural now.
    if (normalizeLooseKey(col.label) === "location" || normalizeLooseKey(col.label) === "storagelocation") continue;

    const baseKey = toKey(col.label) || "column";
    const existingKeys = new Set(existing.map((c) => c.key));
    let key = baseKey;
    let suffix = 2;
    while (existingKeys.has(key)) {
      key = `${baseKey}_${suffix}`;
      suffix += 1;
    }

    // New template columns are attached to every existing location by default,
    // matching the pre-restructure "org-wide" behavior. Users can detach them
    // per-location later via the column manager.
    const newColumn: InventoryColumn = {
      id: randomUUID(),
      organizationId: access.organizationId,
      module: "inventory",
      kind: "column",
      key,
      label: col.label,
      type: col.type,
      isCore: false,
      isRequired: false,
      isVisible: true,
      isEditable: true,
      isGroupable: false,
      attachedLocationIds: allLocationIds,
      sortOrder,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: storage.columnTable,
        Item: newColumn,
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );

    existing.push(newColumn);
    existingLooseLabels.add(normalizeLooseKey(col.label));
    addedColumns.push({ label: newColumn.label, key: newColumn.key });
    sortOrder += 10;
  }

  // 1h.2d: seed allowed units from the template if the template specifies
  // a list. Templates without `allowedUnits` (e.g. "general") fall through
  // to the master KNOWN_UNITS default so the org sees the full picker.
  // Only seed when the org hasn't already curated — checked via
  // attribute_not_exists so existing meta rows aren't clobbered.
  if (Array.isArray(template.allowedUnits) && template.allowedUnits.length > 0) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: storage.columnTable,
          Item: {
            id: "inventory-meta-allowed-units",
            module: "inventory",
            kind: "meta",
            units: template.allowedUnits,
            updatedAt: new Date().toISOString(),
            updatedByUserId: "system",
            seededFromTemplate: templateId,
          },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
    } catch (err: any) {
      // Already curated → don't overwrite the user's choices.
      if (err?.name !== "ConditionalCheckFailedException") {
        console.warn("Allowed-units template seed failed", err);
      }
    }
  }

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "TEMPLATE_APPLY", null, null, {
      templateId,
      columnsAdded: addedColumns.map((c) => c.key),
      ...(template.allowedUnits ? { allowedUnitsSeeded: template.allowedUnits } : {}),
    }),
  ]);

  return json(200, { ok: true, addedColumns });
};
