import type { ChangeEvent, MouseEvent as ReactMouseEvent } from "react";

export type InventoryToolbarProps = {
  canEdit: boolean;
  canEditTable: boolean;
  selectedCount: number;
  saving: boolean;
  showSaved: boolean;
  isMobile: boolean;
  hasSelectedRows: boolean;
  hasDirtyRows: boolean;
  hasDeletedRows: boolean;
  showLocationPills: boolean;
  onAddRow: (position: "above" | "below", event?: ReactMouseEvent<HTMLElement>) => void;
  onMoveSelectedRows: (location: string) => void;
  onRequestDelete: () => void;
  onSave: () => void;
  onChooseCsvImport: () => void;
  onOpenPasteImport: () => void;
  onDownloadTemplate: () => void;
  importInputRef: any;
  locationOptions: string[];
  effectiveLocationFilter: string;
  importingCsv: boolean;
  onCsvSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  rowCount: number;
  searchTerm: string;
  onSearchChange: (term: string) => void;
};

/**
 * Header actions toolbar: Add Row, Move to, Delete, Import menu, Save button.
 * Extracted from InventoryPage lines ~1735-1860.
 */
export function InventoryToolbar({
  canEdit,
  canEditTable,
  selectedCount,
  saving,
  showSaved,
  isMobile,
  hasSelectedRows,
  hasDirtyRows,
  hasDeletedRows,
  showLocationPills,
  onAddRow,
  onMoveSelectedRows,
  onRequestDelete,
  onSave,
  onChooseCsvImport,
  onOpenPasteImport,
  onDownloadTemplate,
  importInputRef,
  locationOptions,
  effectiveLocationFilter,
  importingCsv,
  onCsvSelected,
  rowCount,
  searchTerm,
  onSearchChange,
}: InventoryToolbarProps) {
  if (!canEdit) return null;

  return (
    <div className="inventory-header-actions">
      <input
        ref={importInputRef}
        type="file"
        accept=".csv,.CSV,.tsv,.TSV,.xlsx,.XLSX,.xls,.XLS,text/csv,text/tab-separated-values,application/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream"
        onChange={(event) => {
          void onCsvSelected(event);
        }}
        style={{ display: "none" }}
      />
      {canEditTable ? (
        <>
          {isMobile ? (
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={(event) => onAddRow("below", event)}
            >
              Add Item
            </button>
          ) : (
            <details className="inventory-import-menu">
              <summary className="inventory-import-trigger">Add Row</summary>
              <div className="inventory-import-panel">
                <button
                  type="button"
                  className="inventory-import-option"
                  onClick={(event) => onAddRow("above", event)}
                >
                  Add Above Selected
                </button>
                <button
                  type="button"
                  className="inventory-import-option"
                  onClick={(event) => onAddRow("below", event)}
                >
                  Add Below Selected
                </button>
              </div>
            </details>
          )}
          {!isMobile && rowCount > 1 && hasSelectedRows ? (
            <>
              {showLocationPills && locationOptions.length > 1 ? (
                <details className="inventory-move-menu">
                  <summary className="inventory-import-trigger">
                    Move to… <span className="inventory-move-count">{selectedCount}</span>
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
              <button className="inventory-import-trigger inventory-delete-trigger" onClick={onRequestDelete}>
                Delete ({selectedCount})
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {!isMobile && (
        <details className="inventory-import-menu">
          <summary className="inventory-import-trigger">
            {importingCsv ? "Importing..." : "Import"}
          </summary>
          <div className="inventory-import-panel">
            <button
              type="button"
              className="inventory-import-option"
              onClick={onChooseCsvImport}
              disabled={importingCsv || saving}
            >
              Upload CSV/XLSX
            </button>
            <button
              type="button"
              className="inventory-import-option"
              onClick={onOpenPasteImport}
              disabled={importingCsv || saving}
            >
              Paste Data
            </button>
            <button
              type="button"
              className="inventory-import-option"
              onClick={onDownloadTemplate}
              disabled={importingCsv || saving}
            >
              Download Template
            </button>
          </div>
        </details>
      )}
      <div className="inventory-search-wrap inventory-toolbar-search">
        <input
          className="inventory-search-input"
          placeholder="Search inventory..."
          value={searchTerm}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {searchTerm ? (
          <button
            type="button"
            className="inventory-search-clear"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            title="Clear search"
          >
            ×
          </button>
        ) : null}
      </div>
      <button
        className="button button-primary"
        onClick={onSave}
        disabled={saving || (!hasDirtyRows && !hasDeletedRows && !showSaved)}
      >
        Save
      </button>
    </div>
  );
}
