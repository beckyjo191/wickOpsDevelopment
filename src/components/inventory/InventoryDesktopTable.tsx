import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { ActiveTab, InventoryColumn, InventoryRow, SortDirection } from "./inventoryTypes";
import { CellEditor } from "./CellEditor";
import { isDeletableRow } from "./inventoryUtils";

export type InventoryDesktopTableProps = {
  paginatedRows: { row: InventoryRow; index: number }[];
  visibleColumns: InventoryColumn[];
  allColumns: InventoryColumn[];
  selectedRowIds: Set<string>;
  selectedRowId: string | null;
  canEdit: boolean;
  canEditTable: boolean;
  selectAllCheckboxRef: any;
  allFilteredSelected: boolean;
  filteredRowIdsLength: number;
  onToggleRowSelection: (rowId: string) => void;
  onToggleSelectAllFiltered: () => void;
  onSetSelectedRowId: (rowId: string) => void;
  onSortColumn: (column: InventoryColumn) => void;
  onCellChange: (rowId: string, column: InventoryColumn, value: string) => void;
  sortState: { key: string; direction: SortDirection } | null;
  columnWidths: Record<string, number>;
  getAppliedColumnWidth: (column: InventoryColumn) => number;
  getColumnMinWidth: (column: InventoryColumn) => number;
  onResizeMouseDown: (event: ReactMouseEvent<HTMLSpanElement>, column: InventoryColumn) => void;
  locationOptions: string[];
  categoryOptions: string[];
  categoryFilter: string;
  effectiveCategoryFilter: string;
  onCategoryChange: (category: string) => void;
  effectiveLocationFilter: string;
  onLocationChange: (location: string) => void;
  getReadOnlyCellText: (column: InventoryColumn, value: unknown) => string;
  toDateInputValue: (raw: unknown) => string;
  normalizeLinkValue: (value: string) => string;
  beginCellEditSession: (rowId: string, columnKey: string) => void;
  endCellEditSession: () => void;
  isEditingLinkCell: (rowId: string, columnKey: string) => boolean;
  isEditingDateCell: (rowId: string, columnKey: string) => boolean;
  setEditingLinkCell: (cell: { rowId: string; columnKey: string } | null) => void;
  setEditingDateCell: (cell: { rowId: string; columnKey: string } | null) => void;
  activeTab?: ActiveTab;
  onRetireRow?: (rowId: string) => void;
  /** Selects the row then triggers the bulk-delete confirm flow. Mirrors the
   *  mobile per-row delete path. */
  onDeleteRow?: (rowId: string) => void;
};

/**
 * Desktop table view for inventory items.
 * Extracted from InventoryPage lines ~2625-2960.
 */
export function InventoryDesktopTable({
  paginatedRows,
  visibleColumns,
  selectedRowIds,
  selectedRowId,
  canEditTable,
  selectAllCheckboxRef,
  allFilteredSelected,
  filteredRowIdsLength,
  onToggleRowSelection,
  onToggleSelectAllFiltered,
  onSetSelectedRowId,
  onSortColumn,
  onCellChange,
  sortState,
  getAppliedColumnWidth,
  getColumnMinWidth,
  onResizeMouseDown,
  categoryOptions,
  effectiveCategoryFilter,
  onCategoryChange,
  getReadOnlyCellText,
  toDateInputValue,
  normalizeLinkValue,
  beginCellEditSession,
  endCellEditSession,
  isEditingLinkCell,
  isEditingDateCell,
  setEditingLinkCell,
  setEditingDateCell,
  activeTab,
  onRetireRow,
  onDeleteRow,
}: InventoryDesktopTableProps) {
  const showRetire = activeTab === "expired" && !!onRetireRow;
  const showDelete = canEditTable && !!onDeleteRow;
  return (
    <div className="inventory-table-wrap">
      <table className="inventory-table">
        <thead>
          <tr>
            {canEditTable ? (
              <th className="inventory-select-cell">
                <input
                  ref={selectAllCheckboxRef}
                  type="checkbox"
                  className="inventory-select-checkbox"
                  checked={allFilteredSelected}
                  onChange={onToggleSelectAllFiltered}
                  disabled={!canEditTable || filteredRowIdsLength === 0}
                  aria-label="Select all visible rows"
                />
              </th>
            ) : null}
            {showRetire ? <th className="inventory-col-retire" /> : null}
            {visibleColumns.map((column) =>
              column.key === "category" ? (
                <th
                  key={column.id}
                  className={`inventory-col-${column.key}`}
                  style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                >
                  <details className="inventory-location-menu">
                    <summary className="inventory-location-trigger">
                      {column.label}
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <div className="inventory-location-panel">
                      {categoryOptions.map((option) => (
                        <button
                          key={option}
                          className={`inventory-location-item${effectiveCategoryFilter === option ? " active" : ""}`}
                          onClick={(event) => {
                            onCategoryChange(option);
                            const details = event.currentTarget.closest("details");
                            details?.removeAttribute("open");
                          }}
                          type="button"
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </details>
                  <span
                    className="inventory-col-resizer"
                    onMouseDown={(event) => onResizeMouseDown(event, column)}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.label} column`}
                  />
                </th>
              ) : (
                <th
                  key={column.id}
                  className={`inventory-col-${column.key}`}
                  style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                >
                  <button
                    type="button"
                    className={`inventory-sort-trigger${sortState?.key === column.key ? " inventory-sort-active" : ""}`}
                    onClick={() => onSortColumn(column)}
                  >
                    <span className="inventory-sort-label">{column.label}</span>
                    <span
                      className={`inventory-sort-arrow${sortState?.key === column.key ? "" : " inventory-sort-arrow--placeholder"}`}
                      aria-hidden="true"
                    >
                      {sortState?.key === column.key && sortState.direction === "desc"
                        ? <ChevronDown size={14} />
                        : <ChevronUp size={14} />}
                    </span>
                  </button>
                  <span
                    className="inventory-col-resizer"
                    onMouseDown={(event) => onResizeMouseDown(event, column)}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.label} column`}
                  />
                </th>
              ),
            )}
            {showDelete ? <th className="inventory-col-delete" aria-label="Delete" /> : null}
          </tr>
        </thead>
        <tbody>
          {paginatedRows.map(({ row, index: rowIndex }) => (
            <tr
              key={row.id}
              data-row-id={row.id}
              className={row.id === selectedRowId ? "inventory-row-selected" : undefined}
              onClick={() => onSetSelectedRowId(row.id)}
            >
              {canEditTable ? (
                <td className="inventory-select-cell">
                  <input
                    type="checkbox"
                    className="inventory-select-checkbox"
                    checked={selectedRowIds.has(row.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleRowSelection(row.id)}
                    disabled={!canEditTable}
                    aria-label={`Select row ${rowIndex + 1}`}
                  />
                </td>
              ) : null}
              {showRetire ? (
                <td className="inventory-col-retire" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="inventory-retire-btn"
                    onClick={() => onRetireRow!(row.id)}
                    title="Retire this expired item"
                  >
                    Retire
                  </button>
                </td>
              ) : null}
              {visibleColumns.map((column) => {
                // Per-row editability override: unitCost is normally read-only
                // (derived from packCost / packSize) — but when a specific row
                // has no pack info, let the user type the per-unit price
                // directly. Rows that do have pack info keep Unit Cost as a
                // derived display.
                const rowHasPackInfo =
                  Number.isFinite(Number(row.values.packCost))
                  && Number.isFinite(Number(row.values.packSize))
                  && Number(row.values.packSize) > 0;
                const cellEditable = column.key === "unitCost"
                  ? !rowHasPackInfo
                  : column.isEditable !== false;
                return (
                <td
                  key={`${row.id}-${column.id}`}
                  className={`inventory-col-${column.key}`}
                  style={{ minWidth: getColumnMinWidth(column), width: getAppliedColumnWidth(column) }}
                  onMouseDown={() => onSetSelectedRowId(row.id)}
                >
                  <CellEditor
                    column={column}
                    row={row}
                    value={row.values[column.key]}
                    canEdit={canEditTable && cellEditable}
                    variant="desktop"
                    isEditingLink={isEditingLinkCell(row.id, column.key)}
                    isEditingDate={isEditingDateCell(row.id, column.key)}
                    onCellChange={onCellChange}
                    onLinkEditStart={(rowId, columnKey) => setEditingLinkCell({ rowId, columnKey })}
                    onLinkEditEnd={() => setEditingLinkCell(null)}
                    onDateEditStart={(rowId, columnKey) => setEditingDateCell({ rowId, columnKey })}
                    onDateEditEnd={() => {
                      setEditingDateCell(null);
                    }}
                    getReadOnlyCellText={getReadOnlyCellText}
                    toDateInputValue={toDateInputValue}
                    normalizeLinkValue={normalizeLinkValue}
                    beginCellEditSession={beginCellEditSession}
                    endCellEditSession={endCellEditSession}
                    onSetSelectedRowId={onSetSelectedRowId}
                  />
                </td>
                );
              })}
              {showDelete ? (
                <td className="inventory-col-delete" onClick={(e) => e.stopPropagation()}>
                  {isDeletableRow(row) ? (
                    <button
                      type="button"
                      className="inventory-row-delete-btn"
                      onClick={() => onDeleteRow!(row.id)}
                      title="Delete this item"
                      aria-label="Delete row"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
