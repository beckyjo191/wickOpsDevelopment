// Combobox for unit-of-measurement fields. Native `<input list>` +
// `<datalist>` — gives autocomplete from a curated list while still
// accepting freeform input. Different facility types (fire dept, restaurant,
// grocery, lab) use different units; the curated list is a suggestion, not
// a constraint.

import { useId } from "react";

export type UnitComboboxProps = {
  value: string;
  onChange: (next: string) => void;
  /** Curated suggestions shown in the autocomplete dropdown. The input
   *  accepts any value the user types, in or out of this list. */
  options: string[];
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  id?: string;
};

export function UnitCombobox({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  placeholder,
  className,
  id: providedId,
}: UnitComboboxProps) {
  // Each instance needs a unique datalist id (multiple comboboxes can be on
  // the same page — e.g. one per line on the New Order form).
  const auto = useId();
  const listId = `unit-combo-${providedId ?? auto}`;
  // De-duplicate while preserving order; include the current value if it's
  // not in the curated list so the autocomplete dropdown still surfaces it
  // as a "remembered" choice.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const u of options) {
    const trimmed = u.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  const trimmedValue = value.trim();
  if (trimmedValue && !seen.has(trimmedValue)) merged.push(trimmedValue);

  return (
    <>
      <input
        className={className ?? "field"}
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        // Browsers vary on whether they show the datalist on focus vs. on
        // typing. autoComplete="off" sidesteps overlapping browser-history
        // suggestions so the user only sees our curated list.
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {merged.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </>
  );
}
