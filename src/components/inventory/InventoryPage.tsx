// ── InventoryPage orchestrator ───────────────────────────────────────────────
// Wires custom hooks to sub-components. All state lives in hooks.
import { useEffect, useRef, useState } from "react";
// Download (arrow pointing down into a tray) reads as "import — bringing
// data in." Upload looked like Export to the user, which is the opposite.
import { ChevronDown, Download, Plus } from "lucide-react";
import type { InventoryPageProps } from "./inventoryTypes";
import { isDeletableRow, normalizeHeaderKey } from "./inventoryUtils";
import { RemoveItemDialog } from "./RemoveItemDialog";
import {
  addInventoryLocation,
  addInventoryVendor,
  generateAndDownloadInventoryTemplate,
} from "../../lib/inventoryApi";

// Hooks
import { useMobileDetect } from "./hooks/useMobileDetect";
import { useColumnResize } from "./hooks/useColumnResize";
import { useInventoryFilters } from "./hooks/useInventoryFilters";
import { useInventoryData } from "./hooks/useInventoryData";

// Components
import { AddLocationForm } from "./AddLocationForm";
import { ColumnAttachmentDialog } from "./ColumnAttachmentDialog";
import { InventoryToolbar } from "./InventoryToolbar";
import { InventoryFilterBar } from "./InventoryFilterBar";
import { InventoryUsagePage } from "../InventoryUsagePage";
import { InventoryMobileCards } from "./InventoryMobileCards";
import { InventoryDesktopTable } from "./InventoryDesktopTable";
import { ImportDialogs } from "./ImportDialogs";
import { ItemDetailModal } from "./ItemDetailModal";
import { PaginationControls } from "./PaginationControls";
import { LoadingState } from "../shared/LoadingState";
import { ROWS_PER_PAGE } from "./inventoryTypes";
import type { ItemVendorPricingEntry } from "../../lib/inventoryApi";

export function InventoryPage({
  canEditInventory,
  canManageInventoryColumns,
  canLogUsage,
  initialFilter,
  initialSearch,
  initialEditCell,
  initialAction,
  selectedLocationId,
  onSelectedLocationIdChange,
  onSaveFnChange,
  onActiveTabChange,
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
    selectedLocationId,
    onSelectedLocationIdChange,
    onSaveFnChange,
    // From filters (ref bridge — stale by at most 1 render, which is fine)
    effectiveLocationId: filtersRef.current?.effectiveLocationId ?? "",
    ALL_LOCATIONS: filtersRef.current?.ALL_LOCATIONS ?? "",
    allColumns: filtersRef.current?.allColumns ?? [],
    filteredRows: filtersRef.current?.filteredRows ?? [],
    filteredRowIds: filtersRef.current?.filteredRowIds ?? [],
    visibleColumns: filtersRef.current?.visibleColumns ?? [],
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
    locations: data.locations,
    selectedLocationId,
    initialFilter,
    initialSearch,
    userColumnOverrides: data.userColumnOverrides,
    loading: data.loading,
    editingRowIdRef: data.editingRowIdRef,
    recentlyEditedRowIdRef: data.recentlyEditedRowIdRef,
    newRowAnchorIdRef: data.newRowAnchorIdRef,
    newRowPositionRef: data.newRowPositionRef,
    editingOriginalIndexRef: data.editingOriginalIndexRef,
    sortEpoch: data.sortEpoch,
    vendorPricing: data.vendorPricing,
  });

  // ── Notify parent of active tab so subnav-level UI can react ──────────────
  useEffect(() => {
    onActiveTabChange?.(filters.activeTab);
  }, [filters.activeTab, onActiveTabChange]);
  filtersRef.current = filters;

  // ── Stale-location auto-sync ──────────────────────────────────────────────
  // When the saved `selectedLocationId` (persisted to localStorage) refers to
  // a location that's been deleted, snap to the first available one so the
  // dropdown trigger, table, and storage all agree.
  useEffect(() => {
    if (
      selectedLocationId !== null &&
      selectedLocationId !== filters.ALL_LOCATIONS &&
      filters.sortedLocations.length > 0 &&
      !filters.locationById.has(selectedLocationId)
    ) {
      onSelectedLocationIdChange(filters.sortedLocations[0].id);
    }
  }, [selectedLocationId, filters.sortedLocations, filters.locationById, filters.ALL_LOCATIONS, onSelectedLocationIdChange]);

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

  // ── Per-location column-attachment dialog ──────────────────────────────
  const [showColumnDialog, setShowColumnDialog] = useState(false);
  const currentLocation = filters.locationById.get(filters.effectiveLocationId) ?? null;
  const refetchAfterColumnChange = async () => {
    // Cheapest path: reload bootstrap + reapply. The dialog is rare enough
    // that the extra round trip is fine.
    try {
      const bootstrap = await (await import("../../lib/inventoryApi")).loadInventoryBootstrap();
      data.applyBootstrap(bootstrap);
    } catch { /* surfaced by the dialog's own error handling */ }
  };

  // ── Vendor add handler ────────────────────────────────────────────────────
  // Quick-add a vendor from the inventory grid's vendor cell. Refreshes
  // registeredVendors so the new entry appears in every dropdown without a
  // bootstrap reload — same pattern used by OrdersPage/ReorderTab.
  const handleAddVendor = async (name: string) => {
    const next = await addInventoryVendor(name);
    data.setRegisteredVendors(next);
  };

  // ── Location add handler ──────────────────────────────────────────────────
  const handleAddLocation = () => {
    const name = data.newLocationName.trim();
    if (!name) return;
    const dup = filters.sortedLocations.find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    );
    if (dup) {
      data.setAddLocationError(`"${dup.name}" already exists`);
      return;
    }
    void addInventoryLocation(name)
      .then(({ location, locations }) => {
        data.setLocations(locations);
        data.pendingNewLocationRef.current = location.id;
        onSelectedLocationIdChange(location.id);
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

  // ── Item detail modal (1g.4) ─────────────────────────────────────────────
  // Per-item vendor pricing surface. Opened via the row's "Details" button;
  // reads the in-memory vendorPricing map from useInventoryData. Saves go
  // direct to the upsert endpoint and patch the map in place — no full
  // bootstrap reload.
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const detailItem = detailItemId
    ? data.rows.find((r) => r.id === detailItemId) ?? null
    : null;
  const detailItemPricing: ItemVendorPricingEntry[] = detailItemId
    ? Array.from(data.vendorPricing.get(detailItemId)?.values() ?? [])
    : [];
  const handlePricingUpserted = (entry: ItemVendorPricingEntry) => {
    data.setVendorPricing((prev) => {
      const next = new Map(prev);
      const inner = new Map(next.get(entry.itemId) ?? new Map());
      inner.set(entry.vendorLower, entry);
      next.set(entry.itemId, inner);
      return next;
    });
  };
  const handlePricingDeleted = (id: string) => {
    data.setVendorPricing((prev) => {
      const next = new Map(prev);
      // Find the inner map containing this id and remove the entry. The id
      // shape is `${itemId}#${vendorLower}` but we don't trust that here —
      // walk the maps so a future id-format change doesn't silently break
      // delete state sync.
      for (const [itemId, inner] of next.entries()) {
        for (const [vendorLower, entry] of inner.entries()) {
          if (entry.id === id) {
            const updated = new Map(inner);
            updated.delete(vendorLower);
            if (updated.size === 0) next.delete(itemId);
            else next.set(itemId, updated);
            return next;
          }
        }
      }
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
        <LoadingState
          variant="card"
          className="app-card--inventory"
          message={data.loadingMessage}
        />
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

  // Inline mode (LogUsage) hides the table-scoped controls
  // like search that don't apply to the form view.
  const isInlineMode = filters.activeTab === "logUsage";

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
                    {filters.effectiveLocationName}
                    <ChevronDown className="inventory-dropdown-chevron" size={14} aria-hidden="true" />
                  </summary>
                  <div className="inventory-dropdown-panel">
                    {filters.sortedLocations.map((loc) => (
                      <button
                        key={loc.id}
                        type="button"
                        className={`inventory-dropdown-option${filters.effectiveLocationId === loc.id ? " active" : ""}`}
                        onClick={(e) => {
                          onSelectedLocationIdChange(loc.id);
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        {loc.name}
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
                          <Plus size={14} /> Add Location
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
                registeredLocations={data.locations.map((l) => l.name)}
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
                    {filters.effectiveLocationName}
                    <ChevronDown className="inventory-dropdown-chevron" size={14} aria-hidden="true" />
                  </summary>
                  <div className="inventory-dropdown-panel">
                    {filters.sortedLocations.map((loc) => (
                      <button
                        key={loc.id}
                        type="button"
                        className={`inventory-dropdown-option${filters.effectiveLocationId === loc.id ? " active" : ""}`}
                        onClick={(e) => {
                          onSelectedLocationIdChange(loc.id);
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        {loc.name}
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
                          <Plus size={14} /> Add Location
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
                {/* Import dropdown — scoped to the current location since CSV
                 *  imports always land items at one specific location. Hidden
                 *  in "All Locations" view because a destination is required. */}
                {canEditInventory
                && data.canEditTable
                && !isMobile
                && filters.effectiveLocationId !== filters.ALL_LOCATIONS
                ? (
                  <details className="inventory-move-menu">
                    <summary
                      className="inventory-toolbar-action"
                      title="Import items into this location"
                    >
                      <Download size={14} aria-hidden="true" /> Import
                    </summary>
                    <div className="inventory-move-panel">
                      <button
                        type="button"
                        className="inventory-move-option"
                        onClick={(e) => {
                          data.onChooseCsvImport();
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        Upload CSV / XLSX
                      </button>
                      <button
                        type="button"
                        className="inventory-move-option"
                        onClick={(e) => {
                          data.onOpenPasteImport();
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        Paste from clipboard
                      </button>
                      <button
                        type="button"
                        className="inventory-move-option"
                        onClick={(e) => {
                          handleDownloadTemplate();
                          e.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                      >
                        Download template
                      </button>
                    </div>
                  </details>
                ) : null}
                {data.canEditTable
                && !isMobile
                && filters.effectiveLocationId !== filters.ALL_LOCATIONS
                && currentLocation
                ? (
                  <button
                    type="button"
                    className="inventory-toolbar-action"
                    onClick={() => setShowColumnDialog(true)}
                    title="Manage which custom columns appear at this location"
                  >
                    Manage columns
                  </button>
                ) : null}
                {data.canEditTable && !isMobile && data.rows.length > 1 && filters.selectedRowIds.size > 0 ? (
                  <>
                    {filters.showLocationPills && filters.sortedLocations.length > 1 ? (
                      <details className="inventory-move-menu">
                        <summary className="inventory-toolbar-action">
                          Move to…
                        </summary>
                        <div className="inventory-move-panel">
                          {filters.sortedLocations
                            .filter((loc) => loc.id !== filters.effectiveLocationId)
                            .map((loc) => (
                              <button
                                key={loc.id}
                                type="button"
                                className="inventory-move-option"
                                onClick={(e) => {
                                  void data.onMoveSelectedRows(loc.id);
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
                    {/* Unified Remove: opens the reason-picker dialog for
                     *  every selected row. Replaces the previous separate
                     *  Delete (qty-zero only) and Retire (Expired tab only)
                     *  toolbar buttons. The dialog gates "Created by mistake"
                     *  to selections where every row has qty == 0. */}
                    <button
                      type="button"
                      className="inventory-toolbar-action inventory-toolbar-action--danger"
                      onClick={data.onRequestRemoveSelectedRows}
                      title="Remove the selected rows"
                    >
                      Remove ({filters.selectedRowIds.size})
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
                      <Plus size={14} /> Add Row
                    </button>
                    {filters.selectedRowIds.size > 0 && (
                      <details className="inventory-add-row-menu">
                        <summary className="inventory-add-row-chevron" aria-label="Add row options">
                          <ChevronDown size={14} aria-hidden="true" />
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
                registeredLocations={data.locations.map((l) => l.name)}
              />
            )}
          </>
        )}

        {filters.activeTab === "logUsage" ? (
          <InventoryUsagePage
            selectedLocationId={selectedLocationId}
            canEditInventory={canEditInventory}
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
                expandedCardId={mobileExpandedCardId}
                selectMode={false}
                canEdit={canEditInventory}
                canEditTable={data.canEditTable}
                showLocationPills={filters.showLocationPills}
                locations={filters.sortedLocations}
                effectiveLocationId={filters.effectiveLocationId}
                rows={data.rows}
                filteredRowsLength={filters.filteredRows.length}
                onToggleRowSelection={data.onToggleRowSelection}
                onToggleSelectAllFiltered={data.onToggleSelectAllFiltered}
                onExpandCard={setMobileExpandedCardId}
                onSetSelectMode={() => {}}
                onSetSelectedRowId={() => {}}
                onMoveSelectedRows={data.onMoveSelectedRows}
                onRequestRemove={data.onRequestRemoveSelectedRows}
                onRequestRemoveRow={data.onRequestRemoveRow}
                onCellChange={data.onCellChange}
                getReadOnlyCellText={data.getReadOnlyCellText}
                toDateInputValue={filters.toDateInputValue}
                normalizeLinkValue={data.normalizeLinkValue}
                beginCellEditSession={data.beginCellEditSession}
                endCellEditSession={data.endCellEditSession}
                getDaysUntilExpiration={filters.getDaysUntilExpiration}
                isEditingLinkCell={data.isEditingLinkCell}
                setEditingLinkCell={data.setEditingLinkCell}
                activeTab={filters.activeTab}
                availableVendors={data.registeredVendors}
                onAddVendor={canManageInventoryColumns ? handleAddVendor : undefined}
                allowedUnits={data.allowedUnits}
                vendorPricing={data.vendorPricing}
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
                groupableFilters={filters.groupableFilters}
                groupableColumnOptions={filters.groupableColumnOptions}
                onGroupableFilterChange={filters.setGroupableFilter}
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
                onRemoveRow={canEditInventory ? data.onRequestRemoveRow : undefined}
                availableVendors={data.registeredVendors}
                onAddVendor={canManageInventoryColumns ? handleAddVendor : undefined}
                allowedUnits={data.allowedUnits}
                vendorPricing={data.vendorPricing}
                onOpenItemDetails={canEditInventory ? setDetailItemId : undefined}
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

        {showColumnDialog && currentLocation ? (
          <ColumnAttachmentDialog
            columns={data.columns}
            location={currentLocation}
            onClose={() => setShowColumnDialog(false)}
            onColumnsChanged={() => { void refetchAfterColumnChange(); }}
          />
        ) : null}

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

        {data.removeTarget ? (() => {
          const targetRows = data.rows.filter((r) =>
            data.removeTarget!.rowIds.includes(r.id),
          );
          // "Created by mistake" is the only path that hard-deletes the row.
          // Allow it only when every targeted row has qty == 0; otherwise
          // the server's delete guard would reject anyway and surfacing the
          // option would be misleading.
          const allowCreatedInError = targetRows.every(isDeletableRow);
          // On the Expired tab the obvious answer is "expired" — pre-select
          // it so a one-click flow is still possible. On every other tab
          // leave it unselected so the user has to make an explicit choice.
          const defaultReason =
            filters.activeTab === "expired" ? "expired" : undefined;
          return (
            <RemoveItemDialog
              count={data.removeTarget.rowIds.length}
              itemName={
                targetRows.length === 1
                  ? String(targetRows[0]?.values.itemName ?? "").trim() || undefined
                  : undefined
              }
              allowCreatedInError={allowCreatedInError}
              defaultReason={defaultReason}
              onConfirm={data.onConfirmRemove}
              onCancel={data.onCancelRemove}
            />
          );
        })() : null}
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

      {detailItemId && detailItem ? (
        <ItemDetailModal
          itemId={detailItemId}
          itemName={String(detailItem.values.itemName ?? "").trim() || `Item ${detailItemId.slice(0, 8)}`}
          pricing={detailItemPricing}
          availableVendors={data.registeredVendors}
          allowedUnits={data.allowedUnits}
          tracksUnits={data.tracksUnits}
          onClose={() => setDetailItemId(null)}
          onPricingUpserted={handlePricingUpserted}
          onPricingDeleted={handlePricingDeleted}
          onAddVendor={canManageInventoryColumns ? handleAddVendor : undefined}
        />
      ) : null}
    </section>
  );
}
