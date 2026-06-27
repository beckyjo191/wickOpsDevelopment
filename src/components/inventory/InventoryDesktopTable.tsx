import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import type { ActiveTab, InventoryColumn, InventoryRow, SortDirection } from "./inventoryTypes";
import { CellEditor } from "./CellEditor";

/** Compact "Mon D" label for a row's orderedAt ISO timestamp. Empty string
 *  when there's no pending order. Parsed from the date part to avoid a
 *  timezone shift moving the day. */
const formatOrderedDate = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const datePart = raw.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

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
  /** Map of column key → currently-selected filter value. Replaces the
   *  previous category-only `categoryFilter` prop. */
  groupableFilters: Record<string, string>;
  /** Map of column key → distinct values for the dropdown. */
  groupableColumnOptions: Record<string, string[]>;
  /** Update a single groupable column's filter value. Pass empty string (or
   *  the ALL_GROUPABLE sentinel) to clear. */
  onGroupableFilterChange: (columnKey: string, value: string) => void;
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
  /** Opens the unified Remove dialog scoped to this single row. The dialog
   *  asks the user "what happened?" and routes to retire-with-reason or
   *  hard-delete based on the answer — replacing the previous split between
   *  per-row Retire (Expired tab only) and per-row Delete (qty-zero only). */
  onRemoveRow?: (rowId: string) => void;
  /** Registered vendors + add-vendor callback for the vendor column's
   *  autocomplete picker. Same data Reorder/New Order use, so vendor names
   *  stay canonical across the app. */
  availableVendors?: string[];
  onAddVendor?: (name: string) => Promise<void>;
  /** 1h.7: per-(item, vendor) pricing rows, keyed by item id. The table
   *  uses this to derive each row's `displayUnit` for the Quantity / Min
   *  Quantity suffix (first vendor pricing row's primary axis when the
   *  item itself doesn't carry one). */
  vendorPricing?: Map<string, Map<string, { packAmountUnit?: string; packCount?: number }>>;
  /** Open the per-item detail modal (1g.4 — vendor pricing). When set, a
   *  small "info" button renders in each row's actions area; clicking it
   *  hands the rowId up to InventoryPage which manages modal state. */
  onOpenItemDetails?: (rowId: string) => void;
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
  groupableFilters,
  groupableColumnOptions,
  onGroupableFilterChange,
  getReadOnlyCellText,
  toDateInputValue,
  normalizeLinkValue,
  beginCellEditSession,
  endCellEditSession,
  isEditingLinkCell,
  isEditingDateCell,
  setEditingLinkCell,
  setEditingDateCell,
  activeTab: _activeTab,
  onRemoveRow,
  availableVendors,
  onAddVendor,
  vendorPricing,
  onOpenItemDetails,
}: InventoryDesktopTableProps) {
  // The per-row delete button was removed in 1g — bulk removal goes through
  // the row checkbox + Remove action on selected rows. The onRemoveRow prop
  // is still accepted (RemoveItemDialog hooks into it) but no per-row icon
  // is rendered. `_unusedRemove` keeps the prop in the interface as a lint
  // canary for future per-row affordances if we add one back.
  const _unusedRemove = onRemoveRow;
  void _unusedRemove;

  // Preserve horizontal scroll across re-renders. Clicking a cell triggers
  // `setSelectedRowId` (from both the row's onClick and the cell's
  // onMouseDown), which re-renders the table. In some browsers the focus
  // auto-scroll behavior + this re-render combine to yank scrollLeft back
  // to 0 — making it feel like every click jumps the table to its left
  // edge and forcing the user to re-scroll to finish editing. We track
  // scrollLeft in a ref via the wrapper's onScroll handler, then restore
  // it post-paint via useLayoutEffect.
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollLeftRef = useRef(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (el.scrollLeft !== scrollLeftRef.current) {
      el.scrollLeft = scrollLeftRef.current;
    }
  });

  return (
    <div
      ref={wrapRef}
      className="inventory-table-wrap"
      onScroll={(event) => {
        scrollLeftRef.current = event.currentTarget.scrollLeft;
      }}
    >
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
            {/* Item-detail (ⓘ) column sits right after the row-select checkbox
             *  so it lands before Item Name — the user clicks it to open the
             *  vendor pricing modal for that item. */}
            {onOpenItemDetails ? <th className="inventory-col-details" aria-label="Details" /> : null}
            {visibleColumns.map((column) =>
              // Generic groupable filter: any column with isGroupable === true
              // gets the dropdown header. Replaces the previous hardcoded
              // category-only branch.
              column.isGroupable ? (
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
                      <button
                        key="__all__"
                        className={`inventory-location-item${!groupableFilters[column.key] ? " active" : ""}`}
                        onClick={(event) => {
                          onGroupableFilterChange(column.key, "");
                          const details = event.currentTarget.closest("details");
                          details?.removeAttribute("open");
                        }}
                        type="button"
                      >
                        All {column.label}
                      </button>
                      {(groupableColumnOptions[column.key] ?? []).map((option) => (
                        <button
                          key={option}
                          className={`inventory-location-item${groupableFilters[column.key] === option ? " active" : ""}`}
                          onClick={(event) => {
                            onGroupableFilterChange(column.key, option);
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
          </tr>
        </thead>
        <tbody>
          {paginatedRows.map(({ row, index: rowIndex }) => {
            // 1h.7: derive the row's display unit once per render, fed
            // into the CellEditor for Quantity / Min Quantity suffixes.
            // Order of preference:
            //   1. item-level `displayUnit` (canonical source going fwd)
            //   2. legacy item-level `unit` (pre-1h.7 fallback)
            //   3. first vendor pricing row's primary axis: weight/volume
            //      unit if `packAmountUnit` is set, else "ct" if any
            //      pricing row has `packCount`. Lets a freshly-created
            //      item inherit display from its first vendor's pack.
            //   4. "ct" — last resort so the suffix never shows blank.
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
            return (
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
              {onOpenItemDetails ? (
                <td className="inventory-col-details" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="inventory-row-details-btn"
                    onClick={() => onOpenItemDetails(row.id)}
                    title="Vendor pricing & details"
                    aria-label="Open item details"
                  >
                    <Info size={14} aria-hidden="true" />
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
                    availableVendors={availableVendors}
                    onAddVendor={onAddVendor}
                    displayUnit={rowDisplayUnit}
                  />
                  {/* Pending-order marker. A low item that's already ordered
                   *  stays in Low Stock (still physically short) but leaves the
                   *  Reorder list — this pill explains the gap at a glance. */}
                  {column.key === "itemName" && row.values.orderedAt ? (
                    <span
                      className="badge badge--primary inventory-ordered-pill"
                      title={`Ordered ${formatOrderedDate(row.values.orderedAt)}`}
                    >
                      Ordered · {formatOrderedDate(row.values.orderedAt)}
                    </span>
                  ) : null}
                </td>
                );
              })}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
