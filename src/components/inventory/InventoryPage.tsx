// ── InventoryPage orchestrator ───────────────────────────────────────────────
// Wires custom hooks to sub-components. All state lives in hooks.
import { useEffect, useRef, useState } from "react";
import type { InventoryPageProps } from "./inventoryTypes";
import { normalizeHeaderKey } from "./inventoryUtils";
import {
  addInventoryLocation,
  generateAndDownloadInventoryTemplate,
  approveUsageSubmission,
  deleteUsageSubmission,
} from "../../lib/inventoryApi";

// Hooks
import { useMobileDetect } from "./hooks/useMobileDetect";
import { useColumnResize } from "./hooks/useColumnResize";
import { useInventoryFilters } from "./hooks/useInventoryFilters";
import { useInventoryData } from "./hooks/useInventoryData";
import { usePendingSubmissions } from "./hooks/usePendingSubmissions";

// Components
import { AddLocationForm } from "./AddLocationForm";
import { InventoryToolbar } from "./InventoryToolbar";
import { InventoryFilterBar } from "./InventoryFilterBar";
import { PendingSubmissionsTab } from "./PendingSubmissionsTab";
import { InventoryMobileCards } from "./InventoryMobileCards";
import { InventoryDesktopTable } from "./InventoryDesktopTable";
import { ImportDialogs } from "./ImportDialogs";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { PaginationControls } from "./PaginationControls";
import { ROWS_PER_PAGE } from "./inventoryTypes";

export function InventoryPage({
  canEditInventory,
  canReviewSubmissions,
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

  // ── Pending submissions hook ──────────────────────────────────────────────
  const pending = usePendingSubmissions(filters.activeTab, canReviewSubmissions);

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
    pending.setShowTemplateDialog(true);
    pending.setTemplateSelectedIds(
      new Set(data.columns.map((c) => c.id)),
    );
  };

  const handleConfirmTemplate = () => {
    if (!pending.templateSelectedIds) return;
    const selected = data.columns.filter((c) => pending.templateSelectedIds!.has(c.id));
    void generateAndDownloadInventoryTemplate(selected);
    pending.setShowTemplateDialog(false);
    pending.setTemplateSelectedIds(null);
  };

  const handleToggleTemplateColumn = (colId: string) => {
    pending.setTemplateSelectedIds((prev) => {
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
            <InventoryToolbar
              canEdit={canEditInventory}
              canEditTable={data.canEditTable}
              selectedCount={filters.selectedRowIds.size}
              isMobile={isMobile}
              hasSelectedRows={filters.selectedRowIds.size > 0}
              showLocationPills={filters.showLocationPills}
              onMoveSelectedRows={data.onMoveSelectedRows}
              onRequestDelete={data.onRequestDeleteSelectedRows}
              locationOptions={filters.locationOptions}
              effectiveLocationFilter={filters.effectiveLocationFilter}
              rowCount={data.rows.length}
              searchTerm={filters.searchTerm}
              onSearchChange={filters.setSearchTerm}
            />
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
              <InventoryFilterBar
                activeTab={filters.activeTab}
                onTabChange={filters.setActiveTabRaw}
                tabCounts={filters.tabCounts}
                hasExpirationColumn={filters.hasExpirationColumn}
                hasMinQuantityColumn={filters.hasMinQuantityColumn}
                canReviewSubmissions={canReviewSubmissions}
                pendingCount={pending.pendingSubmissions.length}
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
            {/* ── Desktop layout: single controls row ──────────────────── */}
            <div className="inventory-controls-row">
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

              <InventoryFilterBar
                activeTab={filters.activeTab}
                onTabChange={filters.setActiveTabRaw}
                tabCounts={filters.tabCounts}
                hasExpirationColumn={filters.hasExpirationColumn}
                hasMinQuantityColumn={filters.hasMinQuantityColumn}
                canReviewSubmissions={canReviewSubmissions}
                pendingCount={pending.pendingSubmissions.length}
                isMobile={false}
              />

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

              <InventoryToolbar
                canEdit={canEditInventory}
                canEditTable={data.canEditTable}
                selectedCount={filters.selectedRowIds.size}
                isMobile={false}
                hasSelectedRows={filters.selectedRowIds.size > 0}
                showLocationPills={filters.showLocationPills}
                onMoveSelectedRows={data.onMoveSelectedRows}
                onRequestDelete={data.onRequestDeleteSelectedRows}
                locationOptions={filters.locationOptions}
                effectiveLocationFilter={filters.effectiveLocationFilter}
                rowCount={data.rows.length}
                searchTerm={filters.searchTerm}
                onSearchChange={filters.setSearchTerm}
              />
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

        {filters.activeTab === "pendingSubmissions" ? (
          <PendingSubmissionsTab
            submissions={pending.pendingSubmissions}
            loading={pending.pendingLoading}
            error={pending.pendingError}
            mergedItems={pending.mergedPendingItems}
            approvingAll={pending.approvingAll}
            approveAllError={pending.approveAllError}
            editedQtys={pending.editedQtys}
            onEditQty={(submissionId, entryIndex, value) =>
              pending.setEditedQtys((prev) => ({
                ...prev,
                [submissionId]: { ...(prev[submissionId] ?? {}), [entryIndex]: value },
              }))
            }
            onApprove={async (submissionId, effectiveEntries) => {
              await approveUsageSubmission(submissionId, effectiveEntries);
              pending.setPendingSubmissions((prev) =>
                prev.filter((s) => s.id !== submissionId),
              );
            }}
            onApproveAll={async () => {
              pending.setApprovingAll(true);
              pending.setApproveAllError("");
              try {
                for (const sub of pending.pendingSubmissions) {
                  await approveUsageSubmission(sub.id);
                }
                pending.setPendingSubmissions([]);
              } catch (err: any) {
                pending.setApproveAllError(err?.message ?? "Failed to approve all");
              } finally {
                pending.setApprovingAll(false);
              }
            }}
            onDelete={async (submissionId) => {
              await deleteUsageSubmission(submissionId);
              pending.setPendingSubmissions((prev) =>
                prev.filter((s) => s.id !== submissionId),
              );
            }}
            buildLabel={data.buildPendingEntryLabel}
          />
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
                expandedCardId={data.selectedRowId}
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
                onExpandCard={(id) => data.setSelectedRowId(id === data.selectedRowId ? null : id)}
                onSetSelectMode={() => {}}
                onSetSelectedRowId={data.setSelectedRowId}
                onMoveSelectedRows={data.onMoveSelectedRows}
                onRequestDelete={data.onRequestDeleteSelectedRows}
                onCellChange={data.onCellChange}
                onSetAddingLocation={data.setAddingLocation}
                onSetNewLocationName={data.setNewLocationName}
                onSetAddLocationError={data.setAddLocationError}
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
          showTemplateDialog={pending.showTemplateDialog}
          columns={data.columns}
          templateSelectedIds={pending.templateSelectedIds}
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
            pending.setShowTemplateDialog(false);
            pending.setTemplateSelectedIds(null);
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
