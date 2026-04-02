import type { InventoryColumn } from "./inventoryTypes";
import type { CsvImportDialogState, PasteImportDialogState } from "./inventoryTypes";

export type ImportDialogsProps = {
  csvImportDialog: CsvImportDialogState | null;
  pasteImportDialog: PasteImportDialogState | null;
  showTemplateDialog: boolean;
  columns: InventoryColumn[];
  templateSelectedIds: Set<string> | null;
  importingCsv: boolean;
  onToggleImportHeader: (header: string) => void;
  onCancelCsvImport: () => void;
  onConfirmCsvImport: () => void;
  onPasteTextChange: (text: string) => void;
  onCancelPasteImport: () => void;
  onConfirmPasteImport: () => void;
  onToggleTemplateColumn: (colId: string) => void;
  onCancelTemplate: () => void;
  onConfirmTemplate: () => void;
  normalizeHeaderKey: (value: string) => string;
};

/**
 * Three import overlay dialogs:
 * 1. CSV Import Dialog (column selection)
 * 2. Paste Import Dialog (textarea)
 * 3. Template Download Dialog (column selection for template)
 *
 * Extracted from InventoryPage lines ~3001-3123.
 */
export function ImportDialogs({
  csvImportDialog,
  pasteImportDialog,
  showTemplateDialog,
  columns,
  templateSelectedIds,
  importingCsv,
  onToggleImportHeader,
  onCancelCsvImport,
  onConfirmCsvImport,
  onPasteTextChange,
  onCancelPasteImport,
  onConfirmPasteImport,
  onToggleTemplateColumn,
  onCancelTemplate,
  onConfirmTemplate,
  normalizeHeaderKey,
}: ImportDialogsProps) {
  return (
    <>
      {csvImportDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Choose import columns">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Check which columns you want to import.</h3>
            <p className="inventory-import-subtitle">
              Columns will be auto created if they do not exist.
            </p>
            <div className="inventory-import-list">
              {csvImportDialog.headers.map((header, index) => {
                const checked = csvImportDialog.selectedHeaders.some(
                  (item) => normalizeHeaderKey(item) === normalizeHeaderKey(header),
                );
                return (
                  <label key={`${header}-${index}`} className="inventory-import-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleImportHeader(header)}
                      disabled={importingCsv}
                    />
                    <span>{header}</span>
                  </label>
                );
              })}
            </div>
            <div className="inventory-import-actions">
              <button className="button button-secondary" onClick={onCancelCsvImport} disabled={importingCsv}>
                Cancel
              </button>
              <button className="button button-primary" onClick={onConfirmCsvImport} disabled={importingCsv}>
                {importingCsv ? "Importing..." : "Import Selected Columns"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pasteImportDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Paste import data">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Paste CSV or tab-delimited data.</h3>
            <p className="inventory-import-subtitle">
              Include a header row in the first line.
            </p>
            <textarea
              className="inventory-import-textarea"
              value={pasteImportDialog.rawText}
              onChange={(event) => onPasteTextChange(event.target.value)}
              placeholder={"itemName,quantity,minQuantity\nWrench,12,4"}
              rows={10}
            />
            <div className="inventory-import-actions">
              <button className="button button-secondary" onClick={onCancelPasteImport} disabled={importingCsv}>
                Cancel
              </button>
              <button className="button button-primary" onClick={onConfirmPasteImport} disabled={importingCsv}>
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showTemplateDialog ? (
        <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Download template">
          <div className="inventory-import-dialog">
            <h3 className="inventory-import-title">Customize Template Columns</h3>
            <p className="inventory-import-subtitle">
              Choose which columns to include in the download.
            </p>
            <div className="inventory-import-list">
              {columns.map((col) => {
                const selected = templateSelectedIds?.has(col.id) ?? true;
                return (
                  <label key={col.id} className="inventory-import-item">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggleTemplateColumn(col.id)}
                    />
                    <span>
                      {col.label}
                      <span style={{ opacity: 0.5, marginLeft: "0.5rem", fontSize: "0.75em" }}>
                        {col.type}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="inventory-import-actions">
              <button
                className="button button-secondary"
                onClick={onCancelTemplate}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={!templateSelectedIds || templateSelectedIds.size === 0}
                onClick={onConfirmTemplate}
              >
                Download
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
