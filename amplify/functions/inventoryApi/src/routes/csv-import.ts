// ── CSV import handler ──────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  InventoryColumn,
  InventoryItem,
  RouteContext,
} from "../types";
import { ddb } from "../clients";
import { json } from "../http";
import { CORE_KEYS, HEADER_ALIASES } from "../config";
import { normalizeLooseKey, toKey } from "../normalize";
import { buildAuditEvent, writeAuditEvents } from "../audit";
import { ensureColumns } from "../columns";
import { listAllItems } from "../items";
import {
  parseCsv,
  parseDateToIsoDay,
  parseBooleanOrBlank,
  parseNumberOrBlank,
  parseNonNegativeNumberOrBlank,
  inferColumnType,
  normalizeLinkForImport,
  isPhoneHeader,
  isLikelyPhoneValue,
  formatPhoneNumber,
  buildImportMatchKey,
  buildImportRowFingerprint,
  areValueRecordsEqual,
  detectHeaderRowIndex,
} from "../csv";

export const handleImportCsv = async (ctx: RouteContext) => {
  const { access, storage, body } = ctx;
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

  await writeAuditEvents(storage.auditTable, [
    buildAuditEvent(access, "CSV_IMPORT", null, null, {
      rowsCreated: createdCount,
      rowsUpdated: updatedCount,
      rowsSkipped: skippedCount,
      duplicateSkipped: duplicateSkippedCount,
      columnsCreated: createdColumns.map((c) => c.key),
    }),
  ]);

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
