// Custom select styled like the Dashboard location picker (the dark
// `inventory-dropdown` panel) — so Orders/Reorder pickers match it instead of
// rendering the OS-native <select>. Supports indented child options + a small
// trailing hint (e.g. "· all" on a station). Uses <details> for open/close,
// the same pattern the dashboard + inventory pickers use.

import { ChevronDown } from "lucide-react";

export type CustomDropdownOption = {
  value: string;
  label: string;
  /** 1 → indented child row. */
  depth?: 0 | 1;
  /** Small muted suffix after the label (e.g. "· all"). */
  hint?: string;
  /** Non-selectable group header (e.g. a station above its cabinets). */
  disabled?: boolean;
};

export function CustomDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className,
  placeholder,
}: {
  value: string;
  options: CustomDropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  /** Shown on the trigger when no option is selected. */
  placeholder?: string;
}) {
  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? placeholder ?? options[0]?.label ?? "";
  return (
    <details className={`inventory-dropdown${className ? ` ${className}` : ""}`}>
      <summary className="inventory-dropdown-trigger" aria-label={ariaLabel} aria-disabled={disabled || undefined}>
        {triggerLabel}
        <ChevronDown className="inventory-dropdown-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="inventory-dropdown-panel">
        {options.map((o) =>
          o.disabled ? (
            <div key={o.value} className="inventory-dropdown-header">
              {o.label}
              {o.hint ? <span className="inventory-dropdown-hint"> {o.hint}</span> : null}
            </div>
          ) : (
            <button
              key={o.value}
              type="button"
              className={`inventory-dropdown-option${o.value === value ? " active" : ""}${o.depth === 1 ? " inventory-dropdown-option--child" : ""}`}
              onClick={(e) => {
                onChange(o.value);
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              {o.label}
              {o.hint ? <span className="inventory-dropdown-hint"> {o.hint}</span> : null}
            </button>
          ),
        )}
      </div>
    </details>
  );
}
