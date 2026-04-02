// ── Shared: csv.ts ──────────────────────────────────────────────────────────
// CSV parsing, type inference, and import-related helpers.

import { normalizeLooseKey } from "./normalize";
import { HEADER_ALIASES } from "./config";
import type { InventoryColumn, InventoryColumnType } from "./types";

export const detectDelimiter = (text: string): string => {
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

export const parseCsv = (csvText: string): string[][] => {
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

export const parseDateToIsoDay = (value: string): string => {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
};

export const isLikelyUrlValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^(https?:\/\/|www\.)\S+$/i.test(trimmed);
};

export const normalizeLinkForImport = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const isPhoneHeader = (header: string): boolean =>
  /(phone|mobile|cell|tel|fax)/i.test(header);

export const isLinkHeader = (header: string): boolean =>
  /^(link|url|website|webpage|site|web\s*link|hyperlink)$/i.test(header.trim());

export const isLikelyPhoneValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/\D/g, "");
  const hasPhonePunctuation = /[()+\-\s]/.test(trimmed);
  if (digits.length === 10 && hasPhonePunctuation) return true;
  if (digits.length === 11 && digits.startsWith("1") && hasPhonePunctuation) return true;
  return false;
};

export const formatPhoneNumber = (value: string): string => {
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

export const parseBooleanOrBlank = (
  value: string,
): { ok: true; value: boolean | "" } | { ok: false; error: string } => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: "" };
  if (["true", "t", "yes", "y", "1"].includes(trimmed)) return { ok: true, value: true };
  if (["false", "f", "no", "n", "0"].includes(trimmed)) return { ok: true, value: false };
  return { ok: false, error: "must be a boolean value (true/false, yes/no, 1/0)" };
};

export const parseNumberOrBlank = (
  value: string,
): { ok: true; value: number | "" } | { ok: false; error: string } => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  const parsed = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "must be a number" };
  }
  return { ok: true, value: parsed };
};

export const isDateValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return true;
  const parsed = new Date(trimmed);
  return !Number.isNaN(parsed.getTime());
};

export const inferColumnType = (
  header: string,
  sourceIndex: number,
  dataRows: string[][],
): InventoryColumnType => {
  const values = dataRows
    .map((row) => String(row[sourceIndex] ?? "").trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return "text";

  if (isLinkHeader(header) || values.every((value) => isLikelyUrlValue(value))) return "link";
  if (values.every((value) => parseBooleanOrBlank(value).ok)) return "boolean";
  if (values.every((value) => isDateValue(value))) return "date";
  if (isPhoneHeader(header) || values.every((value) => isLikelyPhoneValue(value))) return "text";
  if (values.every((value) => parseNumberOrBlank(value).ok)) return "number";
  return "text";
};

export const parseNonNegativeNumberOrBlank = (
  value: string,
): { ok: true; value: number | "" } | { ok: false; error: string } => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  const parsed = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: "must be a number" };
  }
  if (parsed < 0) {
    return { ok: false, error: "cannot be negative" };
  }
  return { ok: true, value: parsed };
};

export const buildImportMatchKey = (values: Record<string, unknown>): string => {
  const itemName = String(values.itemName ?? "").trim().toLowerCase();
  if (!itemName) return "";
  const location = String(values.location ?? "").trim().toLowerCase();
  const expirationDate = parseDateToIsoDay(String(values.expirationDate ?? ""));
  return `${itemName}||${location}||${expirationDate}`;
};

export const normalizeFingerprintValue = (column: InventoryColumn, value: unknown): string => {
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

export const buildImportRowFingerprint = (
  mapping: Array<{ sourceIndex: number; header: string; column: InventoryColumn }>,
  values: Record<string, unknown>,
): string => {
  if (mapping.length === 0) return "";
  return mapping
    .map((entry) => `${entry.column.key}:${normalizeFingerprintValue(entry.column, values[entry.column.key])}`)
    .join("||");
};

export const areValueRecordsEqual = (
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

export const detectHeaderRowIndex = (
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

export const getDaysUntilExpiration = (raw: string | null | undefined): number | null => {
  const str = String(raw ?? "").trim();
  if (!str) return null;
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((targetStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
};
