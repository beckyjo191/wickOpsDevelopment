type QtyStepperProps = {
  inputId?: string;
  value: string;
  /** Hard ceiling enforced by the + button; the input itself stays free-form
   *  so users can type a larger number when the cap is "soft" (e.g. ordering
   *  more than current stock). Pass Infinity to disable. */
  max?: number;
  /** Floor enforced by the − button. Defaults to 0. */
  min?: number;
  onChange: (v: string) => void;
  disabled?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
};

export function QtyStepper({
  inputId,
  value,
  max = Number.POSITIVE_INFINITY,
  min = 0,
  onChange,
  disabled,
  ariaInvalid,
  ariaDescribedBy,
  className,
}: QtyStepperProps) {
  const num = Number(value);
  const safeNum = Number.isFinite(num) ? num : 0;
  return (
    <div className={`usage-qty-stepper${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="usage-qty-btn"
        onClick={() => onChange(String(Math.max(min, safeNum - 1)))}
        disabled={disabled || safeNum <= min}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <input
        id={inputId}
        type="number"
        className="usage-qty-input"
        inputMode="numeric"
        min={min}
        max={Number.isFinite(max) ? max : undefined}
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
        onBlur={(e) => { if (e.currentTarget.value === "") onChange(String(min)); }}
        disabled={disabled}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
      />
      <button
        type="button"
        className="usage-qty-btn"
        onClick={() => onChange(String(safeNum + 1))}
        disabled={disabled || safeNum >= max}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}
