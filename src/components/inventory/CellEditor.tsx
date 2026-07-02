import { useState, type ChangeEvent, type FocusEvent } from "react";
import { ExternalLink, X } from "lucide-react";
import { formatCurrency, isCurrencyColumnKey, parseCurrency } from "../../lib/currency";
import type { InventoryColumn, InventoryRow } from "./inventoryTypes";
import { VendorSelect } from "../ReorderTab";

export type CellEditorProps = {
  column: InventoryColumn;
  row: InventoryRow;
  value: unknown;
  canEdit: boolean;
  variant: "mobile" | "desktop";
  isEditingLink?: boolean;
  isEditingDate?: boolean;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  /** When provided, the Quantity cell on an already-saved row becomes a
   *  click-to-adjust trigger instead of a free input — every manual count
   *  correction routes through the reason-capturing Adjust dialog. New
   *  (unsaved) rows keep inline entry so initial stocking stays quick. */
  onRequestAdjustQuantity?: (rowId: string) => void;
  onLinkEditStart?: (rowId: string, columnKey: string) => void;
  onLinkEditEnd?: () => void;
  onDateEditStart?: (rowId: string, columnKey: string) => void;
  onDateEditEnd?: () => void;
  getReadOnlyCellText: (column: InventoryColumn, value: unknown) => string;
  toDateInputValue: (raw: unknown) => string;
  normalizeLinkValue: (value: string) => string;
  beginCellEditSession?: (rowId: string, columnKey: string) => void;
  endCellEditSession?: () => void;
  onSetSelectedRowId?: (rowId: string) => void;
  /** Registered vendors for the vendor cell autocomplete. When provided
   *  alongside `onAddVendor`, the vendor column renders the same picker the
   *  Reorder/New Order screens use — keeping vendor names canonical. */
  availableVendors?: string[];
  onAddVendor?: (name: string) => Promise<void>;
  /** 1h.6: pre-resolved display unit for this row, used as the suffix on
   *  Quantity / Min Quantity ("5 lb on hand"). The parent table computes
   *  this from the item's `displayUnit` (if set) → falls back to legacy
   *  `row.values.unit` → first vendor pricing row's unit → "ct". When
   *  omitted, CellEditor still falls back to `row.values.unit`/"ct". */
  displayUnit?: string;
};

/**
 * Unified cell renderer for both mobile card and desktop table views.
 * Handles all column types: text, number, date, link, boolean.
 */
export function CellEditor({
  column,
  row,
  value,
  canEdit,
  variant,
  isEditingLink,
  isEditingDate,
  onCellChange,
  onRequestAdjustQuantity,
  onLinkEditStart,
  onLinkEditEnd,
  onDateEditStart,
  onDateEditEnd,
  getReadOnlyCellText,
  toDateInputValue,
  normalizeLinkValue,
  beginCellEditSession,
  endCellEditSession,
  onSetSelectedRowId,
  availableVendors,
  onAddVendor,
  displayUnit,
}: CellEditorProps) {
  const inputClass = variant === "mobile" ? "inventory-card-input" : undefined;
  const isVendorCell = column.key === "vendor";

  // ---- Read-only rendering ----
  if (!canEdit) {
    if (column.type === "link") {
      const normalizedLink = normalizeLinkValue(String(value ?? ""));
      const itemName = String(row.values.itemName ?? "").trim();

      if (variant === "mobile") {
        return normalizedLink ? (
          <a className="inventory-card-field-link" href={normalizedLink} target="_blank" rel="noreferrer">
            {itemName || normalizedLink}
          </a>
        ) : (
          <span className="inventory-card-field-value">--</span>
        );
      }

      // Desktop read-only link
      if (!normalizedLink) return null;
      return (
        <a
          className="inventory-link-field inventory-readonly-cell"
          href={normalizedLink}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {itemName || normalizedLink}
        </a>
      );
    }

    // unitCost is derived from packCost / packSize when both are present.
    // Falls back to the stored unitCost value (from restock events) when pack
    // info is missing. Users enter the per-pack price on the Pack Cost cell;
    // the per-unit price updates automatically here.
    if (column.key === "unitCost") {
      const packCost = Number(row.values.packCost);
      const packSize = Number(row.values.packSize);
      const hasPack = Number.isFinite(packCost) && Number.isFinite(packSize) && packSize > 0;
      const derived = hasPack ? formatCurrency(packCost / packSize) : "";
      // Prefer derivation when pack info is present; else fall back to the
      // stored value (which getReadOnlyCellText formats as currency).
      const displayText = derived || getReadOnlyCellText(column, value);
      if (variant === "mobile") {
        return <span className="inventory-card-field-value">{displayText || "--"}</span>;
      }
      return <div className="inventory-readonly-cell">{displayText}</div>;
    }

    // Non-link read-only
    if (variant === "mobile") {
      return (
        <span className="inventory-card-field-value">
          {getReadOnlyCellText(column, value) || "--"}
        </span>
      );
    }
    return (
      <div className="inventory-readonly-cell">
        {getReadOnlyCellText(column, value)}
      </div>
    );
  }

  // ---- Editable rendering ----

  // -- Link column --
  if (column.type === "link") {
    const rawLink = String(value ?? "");
    const normalizedLink = normalizeLinkValue(rawLink);
    const hasLink = normalizedLink.length > 0;
    const editing = isEditingLink || !hasLink;

    if (variant === "mobile") {
      // Mirror the desktop UX: when there's a link and we're not in edit mode,
      // show the item name as a tappable "edit" target + an open-arrow anchor
      // that actually follows the URL. Keeps parity with the table view and
      // makes it obvious the link is clickable.
      if (editing) {
        return (
          <input
            type="url"
            className={inputClass}
            value={rawLink}
            placeholder="Paste link"
            autoFocus={!!isEditingLink}
            onFocus={() => {
              beginCellEditSession?.(row.id, column.key);
              onLinkEditStart?.(row.id, column.key);
            }}
            onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
            onBlur={(e) => {
              const normalized = normalizeLinkValue(e.target.value);
              if (normalized !== e.target.value) {
                onCellChange(row.id, column, normalized);
              }
              onLinkEditEnd?.();
              endCellEditSession?.();
            }}
          />
        );
      }

      const linkLabel = String(row.values.itemName ?? "").trim() || normalizedLink;
      return (
        <div className="inventory-link-field-editable inventory-card-link-editable">
          <span
            className="inventory-link-field-text"
            onClick={(event) => {
              event.stopPropagation();
              onSetSelectedRowId?.(row.id);
              onLinkEditStart?.(row.id, column.key);
            }}
            title="Tap to edit link"
          >
            {linkLabel}
          </span>
          <a
            className="inventory-link-field-open"
            href={normalizedLink}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            title="Open link"
            aria-label="Open link"
          >
            <ExternalLink size={14} />
          </a>
        </div>
      );
    }

    // Desktop link (unchanged — same rawLink/normalizedLink/editing vars).
    if (editing) {
      return (
        <input
          type="url"
          value={rawLink}
          placeholder="Paste link"
          autoFocus={!!isEditingLink}
          onFocus={() => {
            beginCellEditSession?.(row.id, column.key);
            onLinkEditStart?.(row.id, column.key);
          }}
          onChange={(event) => onCellChange(row.id, column, event.target.value)}
          onBlur={(event) => {
            const normalized = normalizeLinkValue(event.target.value);
            if (normalized !== event.target.value) {
              onCellChange(row.id, column, normalized);
            }
            onLinkEditEnd?.();
            endCellEditSession?.();
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!pasted) return;
            event.preventDefault();
            onCellChange(row.id, column, normalizeLinkValue(pasted));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.currentTarget as HTMLInputElement).blur();
            }
          }}
          disabled={!canEdit}
        />
      );
    }

    if (!hasLink) return null;

    const linkLabel = String(row.values.itemName ?? "").trim() || normalizedLink;

    return (
      <div className="inventory-link-field-editable">
        <span
          className="inventory-link-field-text"
          onClick={(event) => {
            event.stopPropagation();
            onSetSelectedRowId?.(row.id);
            onLinkEditStart?.(row.id, column.key);
          }}
          title="Click to edit link"
        >
          {linkLabel}
        </span>
        <a
          className="inventory-link-field-open"
          href={normalizedLink}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title="Open link"
        >
          &#x2197;
        </a>
      </div>
    );
  }

  // -- Vendor column (text-typed core column) --
  // Renders the same autocomplete picker used in New Order / Reorder so vendor
  // names stay canonical across the app. Falls back to the generic textarea
  // when the parent didn't provide vendor data (e.g. legacy callers).
  if (isVendorCell && availableVendors) {
    const currentVendor = String(value ?? "");
    return (
      <VendorSelect
        value={currentVendor}
        availableVendors={availableVendors}
        onChange={(next) => {
          beginCellEditSession?.(row.id, column.key);
          onCellChange(row.id, column, next);
          endCellEditSession?.();
        }}
        onAddVendor={onAddVendor}
        disabled={!canEdit}
        ariaLabel="Vendor"
      />
    );
  }

  // -- Text column --
  if (column.type === "text") {
    if (variant === "mobile") {
      return (
        <textarea
          className={inputClass}
          value={String(value ?? "")}
          rows={2}
          onFocus={() => {
            beginCellEditSession?.(row.id, column.key);
          }}
          onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
          onBlur={() => endCellEditSession?.()}
        />
      );
    }
    return (
      <textarea
        value={String(value ?? "")}
        onFocus={() => {
          beginCellEditSession?.(row.id, column.key);
        }}
        onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
        onBlur={() => endCellEditSession?.()}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            (event.currentTarget as HTMLTextAreaElement).blur();
          }
        }}
        disabled={!canEdit}
        rows={2}
      />
    );
  }

  // -- Number column --
  if (column.type === "number") {
    return (
      <NumberCell
        column={column}
        row={row}
        value={value}
        variant={variant}
        inputClass={inputClass}
        onCellChange={onCellChange}
        onRequestAdjustQuantity={onRequestAdjustQuantity}
        beginCellEditSession={beginCellEditSession}
        endCellEditSession={endCellEditSession}
        displayUnit={displayUnit}
      />
    );
  }

  // -- Date column --
  if (column.type === "date") {
    return (
      <DateCell
        column={column}
        row={row}
        value={value}
        variant={variant}
        inputClass={inputClass}
        isEditingDate={isEditingDate}
        canEdit={canEdit}
        toDateInputValue={toDateInputValue}
        onCellChange={onCellChange}
        onDateEditStart={onDateEditStart}
        onDateEditEnd={onDateEditEnd}
        beginCellEditSession={beginCellEditSession}
        endCellEditSession={endCellEditSession}
        onSetSelectedRowId={onSetSelectedRowId}
      />
    );
  }

  // -- Default (generic text/boolean/other) --
  if (variant === "mobile") {
    return (
      <input
        type="text"
        className={inputClass}
        value={String(value ?? "")}
        onFocus={() => {
          beginCellEditSession?.(row.id, column.key);
        }}
        onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
        onBlur={() => endCellEditSession?.()}
      />
    );
  }

  // Fallback for any unhandled column type
  return (
    <input
      type="text"
      value={String(value ?? "")}
      onFocus={(event) => {
        {
          const el = event.currentTarget;
          const cancel = (e: Event) => { e.preventDefault(); el.removeEventListener("mouseup", cancel); };
          el.addEventListener("mouseup", cancel, { once: true });
        }
        beginCellEditSession?.(row.id, column.key);
      }}
      onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
      onBlur={() => endCellEditSession?.()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.currentTarget as HTMLInputElement).blur();
        }
      }}
      disabled={!canEdit}
    />
  );
}

// ── NumberCell ─────────────────────────────────────────────────────────────
// Editable number input. For currency columns (unitCost), the cell shows the
// formatted value ("$4,239.00") when not focused and the raw numeric string
// ("4239" / "4239.50") while focused so editing is clean — on blur, the value
// is normalized (stripping "$" / "," / whitespace) and committed.
function NumberCell({
  column,
  row,
  value,
  variant,
  inputClass,
  onCellChange,
  onRequestAdjustQuantity,
  beginCellEditSession,
  endCellEditSession,
  displayUnit,
}: {
  column: InventoryColumn;
  row: InventoryRow;
  value: unknown;
  variant: "desktop" | "mobile";
  inputClass: string | undefined;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  onRequestAdjustQuantity?: (rowId: string) => void;
  beginCellEditSession?: (rowId: string, columnKey: string) => void;
  endCellEditSession?: () => void;
  /** Resolved by the parent table from item displayUnit / first vendor
   *  pricing axis. Used as the soft suffix on Quantity / Min Quantity. */
  displayUnit?: string;
}) {
  const isCurrency = isCurrencyColumnKey(column.key);
  const inputMode: "numeric" | "decimal" = isCurrency ? "decimal" : "numeric";
  const pattern = isCurrency ? undefined : "[0-9]*";

  const [focused, setFocused] = useState(false);

  const rawString = String(value ?? "");
  const parsed = isCurrency ? parseCurrency(rawString) : Number(rawString);
  const displayValue =
    isCurrency && !focused && rawString.trim() !== "" && Number.isFinite(parsed)
      ? formatCurrency(parsed)
      : rawString;

  // On blur, normalize a currency cell so ".89" → "0.89", "$4,239" → "4239".
  // Store as a numeric string so save events / analytics Number() it cleanly.
  const normalizeOnBlur = (raw: string) => {
    if (!isCurrency) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const n = parseCurrency(trimmed);
    if (Number.isFinite(n) && String(n) !== trimmed) {
      onCellChange(row.id, column, String(n));
    }
  };

  const commonProps = {
    type: "text" as const,
    inputMode,
    ...(pattern ? { pattern } : {}),
    value: displayValue,
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      setFocused(true);
      e.currentTarget.select();
      beginCellEditSession?.(row.id, column.key);
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      onCellChange(row.id, column, e.currentTarget.value),
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      normalizeOnBlur(e.currentTarget.value);
      setFocused(false);
      endCellEditSession?.();
    },
  };

  // Unit-aware suffix (1f.6 → 1h.6): for the two number columns whose
  // value is measured in the item's tracking unit, render the unit as a
  // soft label beside the input. Stored value stays a plain number —
  // this is read-time labeling only. Other number columns (packSize,
  // custom numerics) stay bare since their value isn't unit-relative.
  // Source of truth: parent's resolved `displayUnit` prop (item-level
  // displayUnit → first vendor pricing unit → legacy row.values.unit).
  // Fallback chain still includes row.values.unit + "ct" so CellEditor
  // works in isolation (no parent prep needed).
  const isUnitAware = column.key === "quantity" || column.key === "minQuantity";
  const resolvedSuffix = (displayUnit ?? "").trim()
    || String(row.values.displayUnit ?? "").trim()
    || String(row.values.unit ?? "").trim()
    || "ct";
  const unitSuffix = isUnitAware ? resolvedSuffix : null;

  // Gate: on an already-saved row, the Quantity cell is not a free input —
  // editing the on-hand count is a reconciliation that must capture a reason.
  // Render a click-to-adjust trigger that opens the Adjust dialog. Brand-new
  // (unsaved) rows have no createdAt yet, so initial stocking stays inline.
  if (column.key === "quantity" && row.createdAt && onRequestAdjustQuantity) {
    const display = rawString.trim() === "" ? "0" : rawString;
    const trigger = (
      <button
        type="button"
        className="inventory-qty-adjust-trigger"
        onClick={() => onRequestAdjustQuantity(row.id)}
        title="Adjust count — records a reason in the activity log"
      >
        {display}
      </button>
    );
    if (unitSuffix) {
      return (
        <div className="inventory-number-with-unit">
          {trigger}
          <span className="inventory-unit-suffix">{unitSuffix}</span>
        </div>
      );
    }
    return trigger;
  }

  if (variant === "mobile") {
    if (unitSuffix) {
      return (
        <div className="inventory-number-with-unit">
          <input {...commonProps} className={inputClass} />
          <span className="inventory-unit-suffix">{unitSuffix}</span>
        </div>
      );
    }
    return <input {...commonProps} className={inputClass} />;
  }

  const desktopInput = (
    <input
      {...commonProps}
      onFocus={(event) => {
        // Desktop: suppress the mouseup that follows focus — otherwise it
        // clobbers the text-selection we just applied in commonProps.onFocus.
        const el = event.currentTarget;
        const cancel = (e: Event) => { e.preventDefault(); el.removeEventListener("mouseup", cancel); };
        el.addEventListener("mouseup", cancel, { once: true });
        commonProps.onFocus(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );

  if (unitSuffix) {
    return (
      <div className="inventory-number-with-unit">
        {desktopInput}
        <span className="inventory-unit-suffix">{unitSuffix}</span>
      </div>
    );
  }
  return desktopInput;
}

// ── DateCell ───────────────────────────────────────────────────────────────
// Editable date input. A native <input type="date"> fires `change` per segment
// as the user types, so persisting on every change spams the row (and activity
// log) with partial dates like "0002-01-01" while a year is half-typed. We keep
// a local draft while focused and commit ONCE on blur/Enter — and only when the
// year is plausible, so an incomplete year is never saved.
function DateCell({
  column,
  row,
  value,
  variant,
  inputClass,
  isEditingDate,
  canEdit,
  toDateInputValue,
  onCellChange,
  onDateEditStart,
  onDateEditEnd,
  beginCellEditSession,
  endCellEditSession,
  onSetSelectedRowId,
}: {
  column: InventoryColumn;
  row: InventoryRow;
  value: unknown;
  variant: "mobile" | "desktop";
  inputClass: string | undefined;
  isEditingDate?: boolean;
  canEdit: boolean;
  toDateInputValue: (raw: unknown) => string;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  onDateEditStart?: (rowId: string, columnKey: string) => void;
  onDateEditEnd?: () => void;
  beginCellEditSession?: (rowId: string, columnKey: string) => void;
  endCellEditSession?: () => void;
  onSetSelectedRowId?: (rowId: string) => void;
}) {
  const isoValue = toDateInputValue(value);
  // null → not editing (mirror the saved value); a string → the in-progress draft.
  const [draft, setDraft] = useState<string | null>(null);
  const current = draft ?? isoValue;

  // Commit the draft on blur. Reject an implausible year (a half-typed
  // "0002-…") so partial dates never reach the row or the activity log; a
  // cleared ("") value is allowed through so blanking still works.
  const commit = () => {
    const next = draft;
    setDraft(null);
    endCellEditSession?.();
    onDateEditEnd?.();
    if (next === null || next === isoValue) return;
    if (next !== "") {
      const year = Number(next.slice(0, 4));
      if (!Number.isFinite(year) || year < 1900 || year > 2200) return;
    }
    onCellChange(row.id, column, next);
  };

  if (variant === "mobile") {
    return (
      <div className="inventory-card-date-wrap">
        <input
          type="date"
          className={inputClass}
          value={current}
          onFocus={() => { beginCellEditSession?.(row.id, column.key); }}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
        />
        {current && (
          <button
            type="button"
            className="inventory-date-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setDraft(null); onCellChange(row.id, column, ""); }}
            aria-label="Clear date"
          >
            &times;
          </button>
        )}
      </div>
    );
  }

  // Desktop date
  const editing = !!isEditingDate;
  if (!isoValue && !editing) {
    return (
      <button
        type="button"
        className="inventory-date-add"
        onClick={(event) => {
          event.stopPropagation();
          onSetSelectedRowId?.(row.id);
          onDateEditStart?.(row.id, column.key);
        }}
        disabled={!canEdit}
      >
        Add date
      </button>
    );
  }

  return (
    <div className="inventory-date-edit-wrap">
      <input
        type="date"
        value={current}
        autoFocus={editing}
        onFocus={() => {
          beginCellEditSession?.(row.id, column.key);
          onDateEditStart?.(row.id, column.key);
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={!canEdit}
      />
      {current ? (
        <button
          type="button"
          className="inventory-date-clear"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            setDraft(null);
            onCellChange(row.id, column, "");
            onDateEditStart?.(row.id, column.key);
          }}
          disabled={!canEdit}
          aria-label="Clear date"
          title="Clear date"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

