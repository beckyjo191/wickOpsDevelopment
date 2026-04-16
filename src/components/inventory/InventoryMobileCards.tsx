import type { ActiveTab, InventoryColumn, InventoryRow } from "./inventoryTypes";
import { CellEditor } from "./CellEditor";

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
  locationOptions: string[];
  effectiveLocationFilter: string;
  rows: InventoryRow[];
  filteredRowsLength: number;
  onToggleRowSelection: (rowId: string) => void;
  onToggleSelectAllFiltered: () => void;
  onExpandCard: (rowId: string | null) => void;
  onSetSelectMode: (mode: boolean) => void;
  onSetSelectedRowId: (rowId: string | null) => void;
  onMoveSelectedRows: (location: string) => void;
  onRequestDelete: () => void;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  onSetAddingLocation: (adding: boolean) => void;
  onSetNewLocationName: (name: string) => void;
  onSetAddLocationError: (error: string | null) => void;
  getReadOnlyCellText: (column: InventoryColumn, value: unknown) => string;
  toDateInputValue: (raw: unknown) => string;
  normalizeLinkValue: (value: string) => string;
  beginCellEditSession: (rowId: string, columnKey: string) => void;
  endCellEditSession: () => void;
  getDaysUntilExpiration: (value: string | number | boolean | null | undefined) => number | null;
  activeTab?: ActiveTab;
  onRetireRow?: (rowId: string) => void;
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
  locationOptions,
  effectiveLocationFilter,
  rows,
  filteredRowsLength,
  onToggleRowSelection,
  onExpandCard,
  onSetSelectMode,
  onSetSelectedRowId,
  onMoveSelectedRows,
  onRequestDelete,
  onCellChange,
  onSetAddingLocation,
  onSetNewLocationName,
  onSetAddLocationError,
  getReadOnlyCellText,
  toDateInputValue,
  normalizeLinkValue,
  beginCellEditSession,
  endCellEditSession,
  getDaysUntilExpiration,
  activeTab,
  onRetireRow,
}: InventoryMobileCardsProps) {
  const showRetire = activeTab === "expired" && !!onRetireRow;
  return (
    <div className="inventory-cards-wrap">
      {selectMode && canEditTable && selectedRowIds.size > 0 && rows.length > 1 && (
        <div className="inventory-cards-toolbar">
          {showLocationPills && locationOptions.length > 1 ? (
            <details className="inventory-move-menu">
              <summary className="button button-secondary button-sm">
                Move to…
              </summary>
              <div className="inventory-move-panel">
                {locationOptions
                  .filter((loc) => loc !== effectiveLocationFilter)
                  .map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      className="inventory-move-option"
                      onClick={(e) => {
                        onMoveSelectedRows(loc);
                        const details = e.currentTarget.closest("details");
                        details?.removeAttribute("open");
                      }}
                    >
                      {loc}
                    </button>
                  ))}
              </div>
            </details>
          ) : null}
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={onRequestDelete}
          >
            Delete ({selectedRowIds.size})
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
            if (daysUntil < 0) expClass = "inventory-card-exp--expired";
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
                  ▼
                </span>
              </div>

              {isExpanded && (
                <div className="inventory-card-detail">
                  {visibleColumns.map((column) => (
                    <div key={column.id} className="inventory-card-field" onClick={(e) => e.stopPropagation()}>
                      <label className="inventory-card-field-label">{column.label}</label>
                      <CellEditor
                        column={column}
                        row={row}
                        value={row.values[column.key]}
                        canEdit={canEditTable}
                        variant="mobile"
                        onCellChange={onCellChange}
                        getReadOnlyCellText={getReadOnlyCellText}
                        toDateInputValue={toDateInputValue}
                        normalizeLinkValue={normalizeLinkValue}
                        beginCellEditSession={beginCellEditSession}
                        endCellEditSession={endCellEditSession}
                      />
                    </div>
                  ))}
                  <div className="inventory-card-actions" onClick={(e) => e.stopPropagation()}>
                    {showRetire && (
                      <button
                        type="button"
                        className="inventory-retire-btn"
                        onClick={() => onRetireRow!(row.id)}
                      >
                        Retire Item
                      </button>
                    )}
                    {canEditTable && (
                      <button
                        type="button"
                        className="inventory-card-delete-btn"
                        onClick={() => {
                          onToggleRowSelection(row.id);
                          onRequestDelete();
                        }}
                      >
                        Delete
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
