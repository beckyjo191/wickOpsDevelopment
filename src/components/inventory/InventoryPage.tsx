// ── InventoryPage orchestrator ───────────────────────────────────────────────
// Wires custom hooks to sub-components. All state lives in hooks.
import { useEffect, useRef, useState } from "react";
import type { InventoryPageProps } from "./inventoryTypes";
import { normalizeHeaderKey } from "./inventoryUtils";
import {
  addInventoryLocation,
  generateAndDownloadInventoryTemplate,
} from "../../lib/inventoryApi";

// Hooks
import { useMobileDetect } from "./hooks/useMobileDetect";
import { useColumnResize } from "./hooks/useColumnResize";
import { useInventoryFilters } from "./hooks/useInventoryFilters";
import { useInventoryData } from "./hooks/useInventoryData";

// Components
import { AddLocationForm } from "./AddLocationForm";
import { InventoryToolbar } from "./InventoryToolbar";
import { InventoryFilterBar } from "./InventoryFilterBar";
import { QuickAddPage } from "../QuickAddPage";
import { InventoryUsagePage } from "../InventoryUsagePage";
import { InventoryMobileCards } from "./InventoryMobileCards";
import { InventoryDesktopTable } from "./InventoryDesktopTable";
import { ImportDialogs } from "./ImportDialogs";
import { DeleteBlockedDialog } from "./DeleteBlockedDialog";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { PaginationControls } from "./PaginationControls";
import { ROWS_PER_PAGE } from "./inventoryTypes";

export function InventoryPage({
  canEditInventory,
  canLogUsage,
  initialFilter,
  initialSearch,
  initialEditCell,
  initialAction,
  selectedLocation,
  onLocationChange,
  onSaveFnChange,
}: InventoryPageProps) {
  const { isMobile } = useMobileDetect();

  // ── Save bar fade-out state ───────────────────────────────────────────────
  const [saveBarVisible, setSaveBarVisible] = useState(false);
  const [saveBarFading, setSaveBarFading] = useState(false);
  const saveBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mobile card expansion is local — unlike `selectedRowId`, closing it must
  // not trigger the auto-select-first-row effect in useInventoryData.
  const [mobileExpandedCardId, setMobileExpandedCardId] = useState<string | null>(null);

  // ── Ref bridge for circular hook deps ─────────────────────────────────────
  // Filters needs rows/columns from data; data needs filteredRows from filters.
  // We use a ref so both hooks can be called unconditionally every render.
  const filtersRef = useRef<ReturnType<typeof useInventoryFilters> | null>(null);

  // ── Data hook (owns rows, columns, save, undo, import, mutations) ─────────
  const data = useInventoryData({
    canEditInventory,
    initialEditCell,
    selectedLocation,
    onLocationChange,
    onSaveFnChange,
    // From filters (ref bridge — stale by at most 1 render, which is fine)
    effectiveLocationFilter: filtersRef.current?.effectiveLocationFilter ?? "",
    allColumns: filtersRef.current?.allColumns ?? [],
    locationColumn: filtersRef.current?.locationColumn,
    filteredRows: filtersRef.current?.filteredRows ?? [],
    filteredRowIds: filtersRef.current?.filteredRowIds ?? [],
    visibleColumns: filtersRef.current?.visibleColumns ?? [],
    UNASSIGNED_LOCATION: filtersRef.current?.UNASSIGNED_LOCATION ?? "Unassigned",
    setSelectedRowIds: filtersRef.current?.setSelectedRowIds ?? (() => {}),
    activeTab: filtersRef.current?.activeTab ?? "all",
    selectedRowIds: filtersRef.current?.selectedRowIds ?? new Set(),
    toDateInputValue: filtersRef.current?.toDateInputValue ?? (() => ""),
    setCurrentPage: filtersRef.current?.setCurrentPage ?? (() => {}),
  });

  // ── Save bar fade-out effect ──────────────────────────────────────────────
  useEffect(() => {
    if (data.saving) {
      if (saveBarTimerRef.current) { clearTimeout(saveBarTimerRef.current); saveBarTimerRef.current = null; }
      setSaveBarFading(false);
      setSaveBarVisible(true);
    } else if (saveBarVisible) {
      setSaveBarFading(true);
      saveBarTimerRef.current = setTimeout(() => {
        setSaveBarVisible(false);
        setSaveBarFading(false);
        saveBarTimerRef.current = null;
      }, 400);
    }
  }, [data.saving]);

  // ── Filters hook (owns tabs, search, sort, pagination, filteredRows) ──────
  const filters = useInventoryFilters({
    rows: data.rows,
    columns: data.columns,
    registeredLocations: data.registeredLocations,
    selectedLocation,
    initialFilter,
    initialSearch,
    userColumnOverrides: data.userColumnOverrides,
    loading: data.loading,
    editingRowIdRef: data.editingRowIdRef,
    recentlyEditedRowIdRef: data.recentlyEditedRowIdRef,
    newRowAnchorIdRef: data.newRowAnchorIdRef,
    newRowPositionRef: data.newRowPositionRef,
    sortEpoch: data.sortEpoch,
  });
  filtersRef.current = filters;

  // ── Auto-paginate + scroll to newly selected row (e.g. after Add Row) ─────
  const prevSelectedRowIdRef = useRef(data.selectedRowId);
  useEffect(() => {
    if (data.selectedRowId === prevSelectedRowIdRef.current) return;
    prevSelectedRowIdRef.current = data.selectedRowId;
    if (!data.selectedRowId) return;
    const rowId = data.selectedRowId;
    const idx = filters.filteredRows.findIndex(({ row }) => row.id === rowId);
    if (idx < 0) return;
    const targetPage = Math.floor(idx / ROWS_PER_PAGE) + 1;
    filters.setCurrentPage(targetPage);
    // Scroll into view after React renders the correct page
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.querySelector(`[data-row-id="${rowId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    });
  }, [data.selectedRowId, filters.filteredRows]);

  // ── Column resize hook ────────────────────────────────────────────────────
  const resize = useColumnResize(data.organizationId);

  // ── Template-download dialog state (local — simple modal state) ──────────
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templateSelectedIds, setTemplateSelectedIds] = useState<Set<string> | null>(null);

  // ── Location add handler ──────────────────────────────────────────────────
  const handleAddLocation = () => {
    const name = data.newLocationName.trim();
    if (!name) return;
    const dup = filters.locationOptions.find(
      (l) => l.toLowerCase() === name.toLowerCase(),
    );
    if (dup && dup !== filters.UNASSIGNED_LOCATION) {
      data.setAddLocationError(`"${dup}" already exists`);
      return;
    }
    void addInventoryLocation(name)
      .then((locs) => {
        data.setRegisteredLocations(locs);
        data.pendingNewLocationRef.current = name;
        onLocationChange(name);
        data.setNewLocationName("");
        data.setAddingLocation(false);
        data.setAddLocationError(null);
      })
      .catch((err: any) => {
        const msg = err?.message ?? String(err);
        data.setAddLocationError(
          msg.includes("already exists") ? msg : "Failed to add location",
        );
      });
  };

  // ── Template download handler ─────────────────────────────────────────────
  const handleDownloadTemplate = () => {
    setShowTemplateDialog(true);
    setTemplateSelectedIds(new Set(data.columns.map((c) => c.id)));
  };

  const handleConfirmTemplate = () => {
    if (!templateSelectedIds) return;
    const selected = data.columns.filter((c) => templateSelectedIds.has(c.id));
    void generateAndDownloadInventoryTemplate(selected);
    setShowTemplateDialog(false);
    setTemplateSelectedIds(null);
  };

  const handleToggleTemplateColumn = (colId: string) => {
    setTemplateSelectedIds((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      return next;
    });
  };

  // ── Trigger initial action (e.g. navigated from Settings → Import) ──────
  // Paste and template actions can fire programmatically (they open React dialogs).
  // CSV import requires a real user gesture to open the file picker, so we show
  // a visible prompt instead.
  const [showCsvImportPrompt, setShowCsvImportPrompt] = useState(false);
  const initialActionFired = useRef(false);
  useEffect(() => {
    if (initialActionFired.current || data.loading || !initialAction) return;
    initialActionFired.current = true;
    if (initialAction === "import-csv") setShowCsvImportPrompt(true);
    else if (initialAction === "paste-import") data.onOpenPasteImport();
    else if (initialAction === "download-template") handleDownloadTemplate();
  }, [data.loading, initialAction]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (data.loading) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory app-loading-card">
          <span className="app-spinner" aria-hidden="true" />
          <span>{data.loadingMessage}</span>
        </div>
      </section>
    );
  }

  if (data.loadError) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory">{data.loadError}</div>
      </section>
    );
  }

  // Inline modes (QuickAdd / LogUsage) hide the table-scoped controls
  // like search that don't apply to the form view.
  const isInlineMode = filters.activeTab === "quickAdd" || filters.activeTab === "logUsage";

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <section className="app-content">
      <div className="app-card app-card--inventory">
        {saveBarVisible && <div className={`inventory-save-bar${saveBarFading ? " inventory-save-bar--fade" : ""}`} />}
        <input
          id="csv-import-input"
          ref={data.importInputRef}
          type="file"
          accept=".csv,.CSV,.tsv,.TSV,.xlsx,.XLSX,.xls,.XLS,text/csv,text/tab-separated-values,application/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream"
          onChange={(event) => {
            setShowCsvImportPrompt(false);
            void data.onCsvSelected(event);
          }}
          style={{ display: "none" }}
        />
        {showCsvImportPrompt && (
          <div className="inventory-import-prompt">
            <label htmlFor="csv-import-input" className="button button-primary">
              Choose CSV / XLSX File
            </label>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={() => setShowCsvImportPrompt(false)}
            >
              Cancel
            </button>
          </div>
        )}
        {/* ── Mobile layout ─────────────────────────────────────────── */}
        {isMobile ? (
          <>
            <div className="inventory-controls-row inventory-controls-row--mobile">
              {filters.showLocationPills && (
                <details className="inventory-dropdown">
                  <summary className="inventory-dropdown-trigger">
                    {selectedLocation || "All Locations"}
                    <svg className="inventory-dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </summary>
                  <div className="inventory-dropdown-panel">
                    {filters.locationOptions.map((loc) => (
                      <button
                        key={loc}
                        type="button"
                        className={`inventory-dropdown-option${selectedLocation === loc ? " active" : ""}`}
                        onClick={(e) => {
                          onLocationChange(loc);
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        {loc}
                      </button>
                    ))}
                    {canEditInventory && (
                      <>
                        <div className="inventory-dropdown-divider" />
                        <button
                          type="button"
                          className="inventory-dropdown-option inventory-dropdown-action"
                          onClick={(e) => {
                            data.setAddingLocation(true);
                            data.setAddLocationError(null);
                            filters.setSelectedRowIds(new Set());
                            e.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                        >
                          + Add Location
                        </button>
                      </>
                    )}
                  </div>
                </details>
              )}
              {canLogUsage ? (
                <button
                  type="button"
                  className={`inventory-toolbar-action${filters.activeTab === "logUsage" ? " active" : ""}`}
                  onClick={() => filters.setActiveTabRaw("logUsage")}
                >
                  Log Usage
                </button>
              ) : null}
              {canEditInventory ? (
                <button
                  type="button"
                  className={`inventory-toolbar-action inventory-toolbar-action--primary${filters.activeTab === "quickAdd" ? " active" : ""}`}
                  onClick={() => filters.setActiveTabRaw("quickAdd")}
                >
                  Fast Restock
                </button>
              ) : null}
            </div>
            {!isInlineMode && (
              <div className="inventory-controls-row inventory-controls-row--mobile inventory-controls-row--mobile-search">
                <InventoryToolbar
                  canEdit={canEditInventory}
                  isMobile={false}
                  searchTerm={filters.searchTerm}
                  onSearchChange={filters.setSearchTerm}
                />
              </div>
            )}
            <div className="inventory-controls-row inventory-controls-row--mobile inventory-controls-row--mobile-actions">
              <InventoryFilterBar
                activeTab={filters.activeTab}
                onTabChange={filters.setActiveTabRaw}
                tabCounts={filters.tabCounts}
                hasExpirationColumn={filters.hasExpirationColumn}
                hasMinQuantityColumn={filters.hasMinQuantityColumn}
                isMobile={isMobile}
              />
            </div>
            {data.addingLocation && (
              <AddLocationForm
                newLocationName={data.newLocationName}
                onNameChange={(v) => {
                  data.setNewLocationName(v);
                  data.setAddLocationError(null);
                }}
                onAdd={handleAddLocation}
                onCancel={() => {
                  data.setNewLocationName("");
                  data.setAddingLocation(false);
                  data.setAddLocationError(null);
                }}
                error={data.addLocationError}
                registeredLocations={data.registeredLocations}
              />
            )}
          </>
        ) : (
          <>
            {/* ── Desktop layout: two-row controls ─────────────────────── */}
            {/* Row 1: location (scope) + mode switches on left, search on right */}
            <div className="inventory-controls-row inventory-controls-row--top">
              {filters.showLocationPills && (
                <details className="inventory-dropdown">
                  <summary className="inventory-dropdown-trigger">
                    {selectedLocation || "All Locations"}
                    <svg className="inventory-dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </summary>
                  <div className="inventory-dropdown-panel">
                    {filters.locationOptions.map((loc) => (
                      <button
                        key={loc}
                        type="button"
                        className={`inventory-dropdown-option${selectedLocation === loc ? " active" : ""}`}
                        onClick={(e) => {
                          onLocationChange(loc);
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        {loc}
                      </button>
                    ))}
                    {canEditInventory && (
                      <>
                        <div className="inventory-dropdown-divider" />
                        <button
                          type="button"
                          className="inventory-dropdown-option inventory-dropdown-action"
                          onClick={(e) => {
                            data.setAddingLocation(true);
                            data.setAddLocationError(null);
                            filters.setSelectedRowIds(new Set());
                            e.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                        >
                          + Add Location
                        </button>
                      </>
                    )}
                  </div>
                </details>
              )}

              {canLogUsage ? (
                <button
                  type="button"
                  className={`inventory-toolbar-action${filters.activeTab === "logUsage" ? " active" : ""}`}
                  onClick={() => filters.setActiveTabRaw("logUsage")}
                >
                  Log Usage
                </button>
              ) : null}
              {canEditInventory ? (
                <button
                  type="button"
                  className={`inventory-toolbar-action inventory-toolbar-action--primary${filters.activeTab === "quickAdd" ? " active" : ""}`}
                  onClick={() => filters.setActiveTabRaw("quickAdd")}
                >
                  Fast Restock
                </button>
              ) : null}

              {!isInlineMode && (
                <InventoryToolbar
                  canEdit={canEditInventory}
                  isMobile={false}
                  searchTerm={filters.searchTerm}
                  onSearchChange={filters.setSearchTerm}
                />
              )}
            </div>

            {/* Row 2: filter chips on left, action buttons on right */}
            <div className="inventory-controls-row inventory-controls-row--bottom">
              <InventoryFilterBar
                activeTab={filters.activeTab}
                onTabChange={filters.setActiveTabRaw}
                tabCounts={filters.tabCounts}
                hasExpirationColumn={filters.hasExpirationColumn}
                hasMinQuantityColumn={filters.hasMinQuantityColumn}
                isMobile={false}
              />

              <div className="inventory-actions-group">
                {data.canEditTable && !isMobile && data.rows.length > 1 && filters.selectedRowIds.size > 0 ? (
                  <>
                    {filters.showLocationPills && filters.locationOptions.length > 1 ? (
                      <details className="inventory-move-menu">
                        <summary className="inventory-toolbar-action">
                          Move to…
                        </summary>
                        <div className="inventory-move-panel">
                          {filters.locationOptions
                            .filter((loc) => loc !== filters.effectiveLocationFilter)
                            .map((loc) => (
                              <button
                                key={loc}
                                type="button"
                                className="inventory-move-option"
                                onClick={(e) => {
                                  data.onMoveSelectedRows(loc);
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
                      className="inventory-toolbar-action inventory-toolbar-action--danger"
                      onClick={data.onRequestDeleteSelectedRows}
                    >
                      Delete ({filters.selectedRowIds.size})
                    </button>
                  </>
                ) : null}
                {canEditInventory && data.canEditTable && (
                  <div className="inventory-add-row-bar">
                    <button
                      type="button"
                      className="inventory-add-row-btn"
                      onClick={() => data.onAddRow("top")}
                    >
                      + Add Row
                    </button>
                    {filters.selectedRowIds.size > 0 && (
                      <details className="inventory-add-row-menu">
                        <summary className="inventory-add-row-chevron" aria-label="Add row options">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </summary>
                        <div className="inventory-add-row-panel">
                          <button
                            type="button"
                            className="inventory-add-row-option"
                            onClick={(e) => {
                              data.onAddRow("above", e);
                              e.currentTarget.closest("details")?.removeAttribute("open");
                            }}
                          >
                            Add Above Selected
                          </button>
                          <button
                            type="button"
                            className="inventory-add-row-option"
                            onClick={(e) => {
                              data.onAddRow("below", e);
                              e.currentTarget.closest("details")?.removeAttribute("open");
                            }}
                          >
                            Add Below Selected
                          </button>
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Add location form (expands below controls row when active) */}
            {data.addingLocation && (
              <AddLocationForm
                newLocationName={data.newLocationName}
                onNameChange={(v) => {
                  data.setNewLocationName(v);
                  data.setAddLocationError(null);
                }}
                onAdd={handleAddLocation}
                onCancel={() => {
                  data.setNewLocationName("");
                  data.setAddingLocation(false);
                  data.setAddLocationError(null);
                }}
                error={data.addLocationError}
                registeredLocations={data.registeredLocations}
              />
            )}
          </>
        )}

        {filters.activeTab === "quickAdd" ? (
          <QuickAddPage selectedLocation={selectedLocation} />
        ) : filters.activeTab === "logUsage" ? (
          <InventoryUsagePage selectedLocation={selectedLocation} />
        ) : (
          <>
            {filters.activeTab === "expired" && canEditInventory && filters.filteredRows.length > 0 && (
              <div className="inventory-retire-bar">
                <span className="inventory-retire-bar-label">
                  {filters.filteredRows.length} expired item{filters.filteredRows.length !== 1 ? "s" : ""}
                </span>
                <button
                  type="button"
                  className="inventory-retire-all-btn"
                  onClick={() => void data.onRetireRows(filters.filteredRows.map((r) => r.row.id))}
                >
                  Retire All Expired
                </button>
              </div>
            )}

            {isMobile ? (
              <InventoryMobileCards
                paginatedRows={filters.paginatedRows}
                visibleColumns={filters.visibleColumns}
                allColumns={filters.allColumns}
                selectedRowIds={filters.selectedRowIds}
                selectedRowId={data.selectedRowId}
                expandedCardId={mobileExpandedCardId}
                selectMode={false}
                canEdit={canEditInventory}
                canEditTable={data.canEditTable}
                showLocationPills={filters.showLocationPills}
                locationOptions={filters.locationOptions}
                effectiveLocationFilter={filters.effectiveLocationFilter}
                rows={data.rows}
                filteredRowsLength={filters.filteredRows.length}
                onToggleRowSelection={data.onToggleRowSelection}
                onToggleSelectAllFiltered={data.onToggleSelectAllFiltered}
                onExpandCard={setMobileExpandedCardId}
                onSetSelectMode={() => {}}
                onSetSelectedRowId={() => {}}
                onMoveSelectedRows={data.onMoveSelectedRows}
                onRequestDelete={data.onRequestDeleteSelectedRows}
                onCellChange={data.onCellChange}
                getReadOnlyCellText={data.getReadOnlyCellText}
                toDateInputValue={filters.toDateInputValue}
                normalizeLinkValue={data.normalizeLinkValue}
                beginCellEditSession={data.beginCellEditSession}
                endCellEditSession={data.endCellEditSession}
                getDaysUntilExpiration={filters.getDaysUntilExpiration}
                activeTab={filters.activeTab}
                onRetireRow={(rowId) => void data.onRetireRows([rowId])}
              />
            ) : (
              <InventoryDesktopTable
                paginatedRows={filters.paginatedRows}
                visibleColumns={filters.visibleColumns}
                allColumns={filters.allColumns}
                selectedRowIds={filters.selectedRowIds}
                selectedRowId={data.selectedRowId}
                canEdit={canEditInventory}
                canEditTable={data.canEditTable}
                selectAllCheckboxRef={data.selectAllCheckboxRef}
                allFilteredSelected={
                  filters.filteredRowIds.length > 0 &&
                  filters.filteredRowIds.every((id) => filters.selectedRowIds.has(id))
                }
                filteredRowIdsLength={filters.filteredRowIds.length}
                onToggleRowSelection={data.onToggleRowSelection}
                onToggleSelectAllFiltered={data.onToggleSelectAllFiltered}
                onSetSelectedRowId={data.setSelectedRowId}
                onSortColumn={filters.onSortColumn}
                onCellChange={data.onCellChange}
                sortState={filters.sortState}
                columnWidths={resize.columnWidths}
                getAppliedColumnWidth={resize.getAppliedColumnWidth}
                getColumnMinWidth={resize.getColumnMinWidth}
                onResizeMouseDown={resize.onResizeMouseDown}
                locationOptions={filters.locationOptions}
                categoryOptions={filters.categoryOptions}
                categoryFilter={filters.categoryFilter}
                effectiveCategoryFilter={filters.effectiveCategoryFilter}
                onCategoryChange={filters.setCategoryFilter}
                effectiveLocationFilter={filters.effectiveLocationFilter}
                onLocationChange={onLocationChange}
                getReadOnlyCellText={data.getReadOnlyCellText}
                toDateInputValue={filters.toDateInputValue}
                normalizeLinkValue={data.normalizeLinkValue}
                beginCellEditSession={data.beginCellEditSession}
                endCellEditSession={data.endCellEditSession}
                isEditingLinkCell={data.isEditingLinkCell}
                isEditingDateCell={data.isEditingDateCell}
                setEditingLinkCell={data.setEditingLinkCell}
                setEditingDateCell={data.setEditingDateCell}
                activeTab={filters.activeTab}
                onRetireRow={canEditInventory ? (rowId) => void data.onRetireRows([rowId]) : undefined}
              />
            )}

            <PaginationControls
              currentPage={filters.safePage}
              totalPages={filters.totalPages}
              totalItems={filters.filteredRows.length}
              pageSize={ROWS_PER_PAGE}
              onPageChange={filters.setCurrentPage}
            />
          </>
        )}

        <ImportDialogs
          csvImportDialog={data.csvImportDialog}
          pasteImportDialog={data.pasteImportDialog}
          showTemplateDialog={showTemplateDialog}
          columns={data.columns}
          templateSelectedIds={templateSelectedIds}
          importingCsv={data.importingCsv}
          onToggleImportHeader={data.onToggleImportHeader}
          onCancelCsvImport={data.onCancelCsvImport}
          onConfirmCsvImport={data.onConfirmCsvImport}
          onPasteTextChange={(text) =>
            data.setPasteImportDialog((prev) => (prev ? { ...prev, rawText: text } : prev))
          }
          onCancelPasteImport={data.onCancelPasteImport}
          onConfirmPasteImport={data.onConfirmPasteImport}
          onToggleTemplateColumn={handleToggleTemplateColumn}
          onCancelTemplate={() => {
            setShowTemplateDialog(false);
            setTemplateSelectedIds(null);
          }}
          onConfirmTemplate={handleConfirmTemplate}
          normalizeHeaderKey={normalizeHeaderKey}
        />

        {data.pendingDeleteRows ? (
          <DeleteConfirmDialog
            count={filters.selectedRowIds.size}
            onConfirm={data.onConfirmDeleteSelectedRows}
            onCancel={() => data.setPendingDeleteRows(false)}
          />
        ) : null}

        {data.deleteBlockedRows.length > 0 ? (
          <DeleteBlockedDialog
            blockedRows={data.deleteBlockedRows}
            onRetire={(reason) => void data.onRetireDeleteBlocked(reason)}
            onCancel={data.onDismissDeleteBlocked}
          />
        ) : null}
      </div>

      {isMobile && canEditInventory && data.canEditTable && (
        <button
          type="button"
          className="inventory-fab"
          onClick={(event) => data.onAddRow("below", event)}
          aria-label="Add item"
        >
          +
        </button>
      )}
    </section>
  );
}
