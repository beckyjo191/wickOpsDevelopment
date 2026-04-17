// ── Currency formatting helpers ─────────────────────────────────────────────
// Shared between OrdersPage, QuickAddPage, and the inventory cell renderer so
// unit cost always displays consistently (e.g. ".89" → "$0.89"). Values are
// stored as numeric strings in valuesJson; formatting is applied only on
// render and on blur-normalization.

/** Format a number as USD ("$4,239.00"). Returns "" for NaN. */
export const formatCurrency = (amount: number): string => {
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount);
};

/**
 * Parse a user-entered currency-ish string. Strips "$", ",", whitespace so
 * "$4,239.00", "4239", ".89", "4,239.5" all resolve. Returns NaN for empty or
 * otherwise unparseable input — callers should guard with `Number.isFinite`.
 */
export const parseCurrency = (input: string): number => Number(input.replace(/[$,\s]/g, ""));

/**
 * valuesJson column keys that should render and edit as currency.
 * Driven by key (not column.type) because "number" already covers qty/min —
 * those shouldn't get the $ treatment. If more currency fields appear later
 * (shipping cost, fees, etc.), add them here.
 */
const CURRENCY_COLUMN_KEYS = new Set<string>(["unitCost"]);

export const isCurrencyColumnKey = (key: string): boolean => CURRENCY_COLUMN_KEYS.has(key);
