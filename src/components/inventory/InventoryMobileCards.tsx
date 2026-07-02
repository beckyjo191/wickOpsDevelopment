import { ChevronDown } from "lucide-react";
import type { ActiveTab, InventoryColumn, InventoryLocation, InventoryRow } from "./inventoryTypes";
import { CellEditor } from "./CellEditor";

/** Compact "Mon D" label for a row's orderedAt ISO timestamp (date part only,
 *  to avoid a timezone shift). Empty string when there's no pending order. */
const formatOrderedDate = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.slice(0, 10));
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export type InventoryMobileCardsProps = {
  paginatedRows: { row: InventoryRow; index: number }[];
  visibleColumns: InventoryColumn[];
  allColumns: InventoryColumn[];
  selectedRowIds: Set<string>;
  selectedRowId: string | null;
  expandedCardId: string | null;
  selectMode: boolean;
  canEdit: boolean;
  canEditTable: boolean;
  showLocationPills: boolean;
  /** Available locations (sorted). Replaces the previous string[] of names. */
  locations: InventoryLocation[];
  /** Currently-scoped location id, or "" for All Locations. */
  effectiveLocationId: string;
  rows: InventoryRow[];
  filteredRowsLength: number;
  onToggleRowSelection: (rowId: string) => void;
  onToggleSelectAllFiltered: () => void;
  onExpandCard: (rowId: string | null) => void;
  onSetSelectMode: (mode: boolean) => void;
  onSetSelectedRowId: (rowId: string | null) => void;
  onMoveSelectedRows: (locationId: string) => void;
  /** Opens the unified Remove dialog for the current selection. Replaces the
   *  prior bulk-Delete affordance — same call site, but the dialog asks
   *  what happened so the action can be retire-with-reason or hard-delete. */
  onRequestRemove: () => void;
  /** Opens the unified Remove dialog for a single row. Used by the per-card
   *  Remove button in the expanded action row. Replaces the prior split
   *  between per-card Retire (Expired tab only) and per-card Delete (qty 0
   *  only) — Remove works on any row, dialog handles routing. */
  onRequestRemoveRow: (rowId: string) => void;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  onRequestAdjustQuantity?: (rowId: string) => void;
  getReadOnlyCellText: (column: InventoryColumn, value: unknown) => string;
  toDateInputValue: (raw: unknown) => string;
  normalizeLinkValue: (value: string) => string;
  beginCellEditSession: (rowId: string, columnKey: string) => void;
  endCellEditSession: () => void;
  getDaysUntilExpiration: (value: string | number | boolean | null | undefined) => number | null;
  /** Same link-edit state the desktop table uses — plumbs through so mobile
   *  cards can show "label + open-arrow" instead of a raw URL input. */
  isEditingLinkCell: (rowId: string, columnKey: string) => boolean;
  setEditingLinkCell: (cell: { rowId: string; columnKey: string } | null) => void;
  activeTab?: ActiveTab;
  /** Registered vendors + add-vendor callback for the vendor column's
   *  autocomplete picker. Same data Reorder/New Order use, so vendor names
   *  stay canonical across the app. */
  availableVendors?: string[];
  onAddVendor?: (name: string) => Promise<void>;
  /** 1h.7: per-(item, vendor) pricing rows. Mobile cards derive each
   *  row's `displayUnit` from this for the Quantity / Min Quantity
   *  suffix, mirroring the desktop table. */
  vendorPricing?: Map<string, Map<string, { packAmountUnit?: string; packCount?: number }>>;
};

/**
 * Mobile card view for inventory items.
 * Extracted from InventoryPage lines ~2347-2623.
 */
export function InventoryMobileCards({
  paginatedRows,
  visibleColumns,
  selectedRowIds,
  expandedCardId,
  selectMode,
  canEditTable,
  showLocationPills,
  locations,
  effectiveLocationId,
  rows,
  filteredRowsLength,
  onToggleRowSelection,
  onExpandCard,
  onSetSelectMode,
  onSetSelectedRowId,
  onMoveSelectedRows,
  onRequestRemove,
  onRequestRemoveRow,
  onCellChange,
  onRequestAdjustQuantity,
  getReadOnlyCellText,
  toDateInputValue,
  normalizeLinkValue,
  beginCellEditSession,
  endCellEditSession,
  getDaysUntilExpiration,
  isEditingLinkCell,
  setEditingLinkCell,
  activeTab: _activeTab,
  availableVendors,
  onAddVendor,
  vendorPricing,
}: InventoryMobileCardsProps) {
  return (
    <div className="inventory-cards-wrap">
      {selectMode && canEditTable && selectedRowIds.size > 0 && rows.length > 1 && (
        <div className="inventory-cards-toolbar">
          {showLocationPills && locations.length > 1 ? (
            <details className="inventory-move-menu">
              <summary className="button button-secondary button-sm">
                Move to…
              </summary>
              <div className="inventory-move-panel">
                {locations
                  .filter((loc) => loc.id !== effectiveLocationId)
                  .map((loc) => (
                    <button
                      key={loc.id}
                      type="button"
                      className="inventory-move-option"
                      onClick={(e) => {
                        onMoveSelectedRows(loc.id);
                        const details = e.currentTarget.closest("details");
                        details?.removeAttribute("open");
                      }}
                    >
                      {loc.name}
                    </button>
                  ))}
              </div>
            </details>
          ) : null}
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={onRequestRemove}
            title="Remove the selected rows"
          >
            Remove ({selectedRowIds.size})
          </button>
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => onSetSelectMode(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {filteredRowsLength === 0 ? (
        <p className="inventory-cards-empty">No items match your filters.</p>
      ) : (
        paginatedRows.map(({ row }) => {
          const isExpanded = expandedCardId === row.id;
          const isSelected = selectedRowIds.has(row.id);

          // 1h.7: derive this card's display unit (Quantity / Min Quantity
          // suffix). Mirrors the desktop table's resolution chain — see
          // InventoryDesktopTable for the comment block.
          const itemDisplayUnit = String(row.values.displayUnit ?? "").trim();
          const itemLegacyUnit = String(row.values.unit ?? "").trim();
          const vendorRows = vendorPricing
            ? Array.from(vendorPricing.get(row.id)?.values() ?? [])
            : [];
          const firstVendorAmountUnit = vendorRows
            .map((p) => (p.packAmountUnit ?? "").trim())
            .find((u) => u.length > 0) ?? "";
          const anyVendorHasCount = vendorRows.some((p) => p.packCount !== undefined);
          const firstVendorUnit = firstVendorAmountUnit || (anyVendorHasCount ? "ct" : "");
          const rowDisplayUnit = itemDisplayUnit || itemLegacyUnit || firstVendorUnit || "ct";

          /* Dynamic card summary: use first visible column as title,
             show up to 4 additional columns as meta badges */
          const nameCol = visibleColumns.find((c) => c.key === "itemName");
          const cardTitle = nameCol
            ? String(row.values[nameCol.key] ?? "").trim() || "Untitled"
            : visibleColumns.length > 0
              ? String(row.values[visibleColumns[0].key] ?? "").trim() || "Untitled"
              : "Untitled";

          /* Collapsed card only shows quantity and expiration date */
          const previewCols = visibleColumns
            .filter((c) => c.key === "quantity" || c.key === "expirationDate");

          /* Expiration status for card border styling */
          const expValue = row.values.expirationDate;
          const daysUntil = getDaysUntilExpiration(expValue);
          let expClass = "";
          if (daysUntil !== null) {
            if (daysUntil <= 0) expClass = "inventory-card-exp--expired";
            else if (daysUntil <= 30) expClass = "inventory-card-exp--soon";
            else if (daysUntil <= 60) expClass = "inventory-card-exp--warning";
          }

          /* Low stock check */
          const qtyNum = Number(row.values.quantity);
          const minQtyNum = Number(row.values.minQuantity);
          const isLowStock =
            Number.isFinite(qtyNum) &&
            Number.isFinite(minQtyNum) &&
            minQtyNum > 0 &&
            qtyNum < minQtyNum;

          return (
            <div
              key={row.id}
              className={`inventory-card${isExpanded ? " inventory-card--expanded" : ""}${isSelected ? " inventory-card--selected" : ""}`}
              onClick={() => {
                if (selectMode) {
                  onToggleRowSelection(row.id);
                } else if (isExpanded) {
                  onExpandCard(null);
                  onSetSelectedRowId(null);
                } else {
                  onExpandCard(row.id);
                  onSetSelectedRowId(row.id);
                }
              }}
            >
              <div className="inventory-card-summary">
                {selectMode && (
                  <input
                    type="checkbox"
                    className="inventory-select-checkbox"
                    checked={isSelected}
                    onChange={() => onToggleRowSelection(row.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                <div className="inventory-card-info">
                  <span className="inventory-card-name">{cardTitle}</span>
                  {row.values.orderedAt ? (
                    <span className="badge badge--primary inventory-ordered-pill">
                      Ordered · {formatOrderedDate(row.values.orderedAt)}
                    </span>
                  ) : null}
                  <div className="inventory-card-meta">
                    {previewCols.map((col) => {
                      const val = row.values[col.key];
                      const displayText = getReadOnlyCellText(col, val);
                      if (!displayText.trim()) return null;

                      /* Special styling for quantity (low stock) */
                      if (col.key === "quantity") {
                        const minQtyVal = row.values.minQuantity;
                        const minLabel = minQtyVal !== null && minQtyVal !== undefined && String(minQtyVal).trim() !== "" && Number(minQtyVal) > 0
                          ? ` / ${minQtyVal}`
                          : "";
                        return (
                          <span key={col.id} className={`inventory-card-badge${isLowStock ? " inventory-card-badge--low" : ""}`}>
                            {col.label}: {displayText}{minLabel}
                          </span>
                        );
                      }

                      /* Expiration date as badge with exp color styling */
                      if (col.key === "expirationDate") {
                        if (daysUntil === null) return null;
                        return (
                          <span key={col.id} className={`inventory-card-badge ${expClass}`}>
                            Exp: {displayText}
                          </span>
                        );
                      }

                      /* Link column - skip from preview */
                      if (col.type === "link") {
                        return null;
                      }

                      /* Generic column badge */
                      return (
                        <span key={col.id} className="inventory-card-tag">
                          {col.label}: {displayText}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <span className={`inventory-card-chevron${isExpanded ? " inventory-card-chevron--up" : ""}`} aria-hidden="true">
                  <ChevronDown size={14} />
                </span>
              </div>

              {isExpanded && (
                <div className="inventory-card-detail">
                  {visibleColumns.map((column) => {
                    // Per-row editability: unitCost is derived (read-only)
                    // when the row has pack info, but editable when it
                    // doesn't — lets users set prices for single-unit items.
                    const rowHasPackInfo =
                      Number.isFinite(Number(row.values.packCost))
                      && Number.isFinite(Number(row.values.packSize))
                      && Number(row.values.packSize) > 0;
                    const cellEditable = column.key === "unitCost"
                      ? !rowHasPackInfo
                      : column.isEditable !== false;
                    return (
                    <div key={column.id} className="inventory-card-field" onClick={(e) => e.stopPropagation()}>
                      <label className="inventory-card-field-label">{column.label}</label>
                      <CellEditor
                        column={column}
                        row={row}
                        value={row.values[column.key]}
                        canEdit={canEditTable && cellEditable}
                        variant="mobile"
                        isEditingLink={isEditingLinkCell(row.id, column.key)}
                        onCellChange={onCellChange}
                        onRequestAdjustQuantity={onRequestAdjustQuantity}
                        onLinkEditStart={(rowId, columnKey) => setEditingLinkCell({ rowId, columnKey })}
                        onLinkEditEnd={() => setEditingLinkCell(null)}
                        getReadOnlyCellText={getReadOnlyCellText}
                        toDateInputValue={toDateInputValue}
                        normalizeLinkValue={normalizeLinkValue}
                        beginCellEditSession={beginCellEditSession}
                        endCellEditSession={endCellEditSession}
                        onSetSelectedRowId={onSetSelectedRowId}
                        availableVendors={availableVendors}
                        onAddVendor={onAddVendor}
                        displayUnit={rowDisplayUnit}
                      />
                    </div>
                    );
                  })}
                  <div className="inventory-card-actions" onClick={(e) => e.stopPropagation()}>
                    {canEditTable && (
                      <button
                        type="button"
                        className="inventory-card-delete-btn"
                        onClick={() => onRequestRemoveRow(row.id)}
                        title="Remove this item"
                      >
                        Remove
                      </button>
                    )}
                    <button
                      type="button"
                      className="inventory-card-collapse-btn"
                      onClick={() => {
                        onExpandCard(null);
                        onSetSelectedRowId(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
