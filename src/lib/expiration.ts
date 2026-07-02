// Shared expiration helpers — single source of truth for "how many days until
// this lot expires" and "is it expired". A lot is expired when its date is
// TODAY or in the past (by end of day it's unusable). Expired and retired lots
// are not counted as usable on-hand stock.

export const getDaysUntilExpiration = (
  value: string | number | boolean | null | undefined,
): number | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Parse bare YYYY-MM-DD as local date components — `new Date("2026-04-28")`
  // would otherwise be UTC midnight, which reads back as the prior day in any
  // timezone west of UTC and skews the day-difference by one.
  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = isoDateOnly
    ? new Date(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]))
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.floor((targetStart - todayStart) / (1000 * 60 * 60 * 24));
};

/** A lot is expired when its expiration date is today or in the past. Blank /
 *  undated lots are never expired. */
export const isExpired = (value: string | number | boolean | null | undefined): boolean => {
  const d = getDaysUntilExpiration(value);
  return d !== null && d <= 0;
};
