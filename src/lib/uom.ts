// ── Unit-of-measure (frontend mirror) ───────────────────────────────────────
// Mirrors amplify/functions/inventoryApi/src/uom.ts so the New Order panel
// can compute live $/canonical previews without round-tripping to the server.
// Keep the conversion factors in sync with the backend module — both are the
// authoritative copy for their side. The server still re-derives
// pricePerCanonical at order-create time, so a drift here only affects the
// preview, not persisted data.

export type Dimension = "count" | "weight" | "volume";

const CANONICAL: Record<Dimension, string> = {
  count: "ct",
  weight: "oz",
  volume: "fl oz",
};

const FACTORS: Record<Dimension, Record<string, number>> = {
  count: {
    ct: 1,
    each: 1,
    ea: 1,
    pc: 1,
    piece: 1,
    pieces: 1,
    dozen: 12,
    doz: 12,
    dz: 12,
  },
  weight: {
    oz: 1,
    ounce: 1,
    ounces: 1,
    lb: 16,
    lbs: 16,
    pound: 16,
    pounds: 16,
    g: 1 / 28.3495,
    gram: 1 / 28.3495,
    grams: 1 / 28.3495,
    kg: 1000 / 28.3495,
    kilo: 1000 / 28.3495,
    kilos: 1000 / 28.3495,
  },
  volume: {
    "fl oz": 1,
    floz: 1,
    cup: 8,
    cups: 8,
    pt: 16,
    pint: 16,
    pints: 16,
    qt: 32,
    quart: 32,
    quarts: 32,
    gal: 128,
    gallon: 128,
    gallons: 128,
    ml: 1 / 29.5735,
    milliliter: 1 / 29.5735,
    milliliters: 1 / 29.5735,
    l: 1000 / 29.5735,
    liter: 1000 / 29.5735,
    liters: 1000 / 29.5735,
  },
};

/** Flat list of UoMs surfaced in the inventory `unit` cell-editor dropdown.
 *  Order is rough-frequency: count first (most common), then weight, then
 *  volume — matches what the average user reaches for. The FACTORS table
 *  also accepts longer aliases (e.g. "pound" for "lb") so the same string
 *  can flow through a future curated-per-org list (1g) without re-keying. */
export const KNOWN_UNITS: string[] = [
  "ct", "dozen",
  "oz", "lb", "g", "kg",
  "fl oz", "cup", "pt", "qt", "gal", "ml", "l",
];

const normalizeUnit = (unit: string): string =>
  unit.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");

export const canonicalUnitFor = (dimension: Dimension): string => CANONICAL[dimension];

export const dimensionForUnit = (unit: string): Dimension | null => {
  const norm = normalizeUnit(unit);
  for (const dim of ["count", "weight", "volume"] as const) {
    if (norm in FACTORS[dim]) return dim;
  }
  return null;
};

export const toCanonicalAmount = (
  amount: number,
  unit: string,
): { amount: number; unit: string } | null => {
  const dim = dimensionForUnit(unit);
  if (!dim) return null;
  const factor = FACTORS[dim][normalizeUnit(unit)];
  return { amount: amount * factor, unit: CANONICAL[dim] };
};

export const pricePerCanonical = (
  purchasePrice: number,
  purchaseAmount: number,
  purchaseUnit: string,
): { pricePerCanonical: number; canonicalUnit: string } | null => {
  if (!Number.isFinite(purchasePrice) || purchasePrice < 0) return null;
  if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) return null;
  const canon = toCanonicalAmount(purchaseAmount, purchaseUnit);
  if (!canon) return null;
  return {
    pricePerCanonical: purchasePrice / canon.amount,
    canonicalUnit: canon.unit,
  };
};
