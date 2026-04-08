// ── InventoryPage orchestrator ───────────────────────────────────────────────
// Wires custom hooks to sub-components. All state lives in hooks.
import { useRef } from "react";
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
import { LocationPills } from "../LocationPills";
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
  selectedLocation,
  onLocationChange,
  onSaveFnChange,
}: InventoryPageProps) {
  const { isMobile } = useMobileDetect();

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
  });
  filtersRef.current = filters;

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
        <InventoryToolbar
          canEdit={canEditInventory}
          canEditTable={data.canEditTable}
          selectedCount={filters.selectedRowIds.size}
          saving={data.saving}
          showSaved={data.showSaved}
          isMobile={isMobile}
          hasSelectedRows={filters.selectedRowIds.size > 0}
          hasDirtyRows={data.dirtyRowIds.size > 0}
          hasDeletedRows={data.deletedRowIds.size > 0}
          showLocationPills={filters.showLocationPills}
          onAddRow={data.onAddRow}
          onMoveSelectedRows={data.onMoveSelectedRows}
          onRequestDelete={data.onRequestDeleteSelectedRows}
          onSave={() => void data.onSave(false)}
          onChooseCsvImport={data.onChooseCsvImport}
          onOpenPasteImport={data.onOpenPasteImport}
          onDownloadTemplate={handleDownloadTemplate}
          importInputRef={data.importInputRef}
          locationOptions={filters.locationOptions}
          effectiveLocationFilter={filters.effectiveLocationFilter}
          importingCsv={data.importingCsv}
          onCsvSelected={data.onCsvSelected}
          rowCount={data.rows.length}
        />

        {/* Location Pills */}
        {filters.showLocationPills ? (
          <>
            <LocationPills
              locations={filters.locationOptions.map((loc) => ({ location: loc }))}
              selectedLocation={selectedLocation}
              onLocationChange={onLocationChange}
            >
              {canEditInventory && !data.addingLocation ? (
                <button
                  type="button"
                  className="location-pill location-pill--add"
                  onClick={() => {
                    data.setAddingLocation(true);
                    data.setAddLocationError(null);
                    filters.setSelectedRowIds(new Set());
                  }}
                  aria-label="Add location"
                >
                  +
                </button>
              ) : null}
              {data.addingLocation && !isMobile ? (
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
                  compact
                />
              ) : null}
            </LocationPills>

            {/* Mobile add location form (below pills) */}
            {data.addingLocation && isMobile ? (
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
            ) : null}
          </>
        ) : canEditInventory && filters.locationOptions.length === 0 ? (
          /* Empty state — no locations yet */
          data.addingLocation ? (
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
          ) : null
        ) : null}

        <InventoryFilterBar
          activeTab={filters.activeTab}
          onTabChange={filters.setActiveTabRaw}
          searchTerm={filters.searchTerm}
          onSearchChange={filters.setSearchTerm}
          tabCounts={filters.tabCounts}
          hasExpirationColumn={filters.hasExpirationColumn}
          hasMinQuantityColumn={filters.hasMinQuantityColumn}
          canReviewSubmissions={canReviewSubmissions}
          pendingCount={pending.pendingSubmissions.length}
          isMobile={isMobile}
        />

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
                allFilteredSelected={data.allFilteredSelected}
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
    </section>
  );
}
