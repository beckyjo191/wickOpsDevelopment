// ── Unit-of-measure canonicalization ────────────────────────────────────────
// Households buy groceries in mixed units (gal milk, lb beef, ct apples).
// To compare prices across receipts ("$/oz of milk by vendor"), every
// purchase line needs a price expressed in a single canonical unit per
// *dimension* (weight, volume, count). This module is the single source of
// truth for that conversion math; client and server both call into it so the
// derivation can't drift between live UI previews and persisted values.
//
// Dimensions don't mix — a "weight" item can only be bought in weight units;
// the pricing query on read-side filters by item.dimension to keep
// apples-to-apples comparisons honest.

export type Dimension = "count" | "weight" | "volume";

/** Canonical unit per dimension. All persisted prices are stored as
 *  $/canonical so reads don't need to know about unit conversion. */
const CANONICAL: Record<Dimension, string> = {
  count: "ct",
  weight: "oz",
  volume: "fl oz",
};

/** Conversion factors to the dimension's canonical unit. e.g. 1 lb = 16 oz,
 *  so weight["lb"] = 16. Keep all entries lower-cased; lookup normalizes
 *  case + strips trailing periods ("Fl Oz." → "fl oz"). */
const FACTORS: Record<Dimension, Record<string, number>> = {
  count: {
    ct: 1,
    "count": 1,
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
    kilogram: 1000 / 28.3495,
    kilograms: 1000 / 28.3495,
  },
  volume: {
    "fl oz": 1,
    floz: 1,
    "fluid ounce": 1,
    "fluid ounces": 1,
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
    litre: 1000 / 29.5735,
    litres: 1000 / 29.5735,
  },
};

/** Normalize a user-typed unit string for FACTORS lookup. */
const normalizeUnit = (unit: string): string =>
  unit.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");

/** Canonical unit for a dimension (e.g. "oz" for weight). */
export const canonicalUnitFor = (dimension: Dimension): string => CANONICAL[dimension];

/** Reverse lookup: which dimension does this unit belong to? Returns null
 *  for unknown units so callers can surface a validation error instead of
 *  silently mis-categorizing. Case + plural insensitive. */
export const dimensionForUnit = (unit: string): Dimension | null => {
  const norm = normalizeUnit(unit);
  for (const dim of ["count", "weight", "volume"] as const) {
    if (norm in FACTORS[dim]) return dim;
  }
  return null;
};

/** Convert (amount, unit) → canonical amount for the same dimension. Returns
 *  null when the unit isn't recognized. */
export const toCanonicalAmount = (amount: number, unit: string): { amount: number; unit: string } | null => {
  const dim = dimensionForUnit(unit);
  if (!dim) return null;
  const factor = FACTORS[dim][normalizeUnit(unit)];
  return { amount: amount * factor, unit: CANONICAL[dim] };
};

/** Compute $/canonical-unit for a purchase. e.g. $14.99 / 2.5 lb of beef →
 *  $0.375/oz. Returns null when the unit is unknown OR the amount is zero
 *  (caller decides how to surface). */
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

/** Validate that a (dimension, unit) pair is consistent. Used at order-create
 *  time to reject "buy 2.5 oz of dozen-eggs" — a count item shouldn't accept
 *  weight units. */
export const isUnitInDimension = (unit: string, dimension: Dimension): boolean => {
  const dim = dimensionForUnit(unit);
  return dim === dimension;
};
