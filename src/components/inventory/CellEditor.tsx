import type { InventoryColumn, InventoryRow } from "./inventoryTypes";

export type CellEditorProps = {
  column: InventoryColumn;
  row: InventoryRow;
  value: unknown;
  canEdit: boolean;
  variant: "mobile" | "desktop";
  isEditingLink?: boolean;
  isEditingDate?: boolean;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
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
}: CellEditorProps) {
  const inputClass = variant === "mobile" ? "inventory-card-input" : undefined;

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
    if (variant === "mobile") {
      return (
        <input
          type="url"
          className={inputClass}
          value={String(value ?? "")}
          placeholder="Paste link"
          onFocus={() => {
            beginCellEditSession?.(row.id, column.key);
          }}
          onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
          onBlur={(e) => {
            const normalized = normalizeLinkValue(e.target.value);
            if (normalized !== e.target.value) {
              onCellChange(row.id, column, normalized);
            }
            endCellEditSession?.();
          }}
        />
      );
    }

    // Desktop link
    const rawLink = String(value ?? "");
    const normalizedLink = normalizeLinkValue(rawLink);
    const hasLink = normalizedLink.length > 0;
    const editing = isEditingLink || !hasLink;

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
    if (variant === "mobile") {
      return (
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className={inputClass}
          value={String(value ?? "")}
          onFocus={(e) => {
            e.currentTarget.select();
            beginCellEditSession?.(row.id, column.key);
          }}
          onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
          onBlur={() => endCellEditSession?.()}
        />
      );
    }
    // Desktop: number uses text input with numeric mode
    return (
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={String(value ?? "")}
        onFocus={(event) => {
          event.currentTarget.select();
          const el = event.currentTarget;
          const cancel = (e: Event) => { e.preventDefault(); el.removeEventListener("mouseup", cancel); };
          el.addEventListener("mouseup", cancel, { once: true });
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

  // -- Date column --
  if (column.type === "date") {
    const isoValue = toDateInputValue(value);

    if (variant === "mobile") {
      return (
        <div className="inventory-card-date-wrap">
          <input
            type="date"
            className={inputClass}
            value={isoValue}
            onFocus={() => {
              beginCellEditSession?.(row.id, column.key);
            }}
            onChange={(e) => onCellChange(row.id, column, e.currentTarget.value)}
            onBlur={() => endCellEditSession?.()}
          />
          {isoValue && (
            <button
              type="button"
              className="inventory-date-clear"
              onClick={() => onCellChange(row.id, column, "")}
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
          value={isoValue}
          autoFocus={editing}
          onFocus={() => {
            beginCellEditSession?.(row.id, column.key);
            onDateEditStart?.(row.id, column.key);
          }}
          onChange={(event) => onCellChange(row.id, column, event.currentTarget.value)}
          onBlur={() => {
            endCellEditSession?.();
            onDateEditEnd?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.currentTarget as HTMLInputElement).blur();
            }
          }}
          disabled={!canEdit}
        />
        {isoValue ? (
          <button
            type="button"
            className="inventory-date-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onCellChange(row.id, column, "");
              onDateEditStart?.(row.id, column.key);
            }}
            disabled={!canEdit}
            aria-label="Clear date"
            title="Clear date"
          >
            ×
          </button>
        ) : null}
      </div>
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
