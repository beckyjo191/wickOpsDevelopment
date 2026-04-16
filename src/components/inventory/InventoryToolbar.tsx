import { useState } from "react";

export type InventoryToolbarProps = {
  canEdit: boolean;
  canEditTable: boolean;
  selectedCount: number;
  isMobile: boolean;
  hasSelectedRows: boolean;
  showLocationPills: boolean;
  onMoveSelectedRows: (location: string) => void;
  onRequestDelete: () => void;
  locationOptions: string[];
  effectiveLocationFilter: string;
  rowCount: number;
  searchTerm: string;
  onSearchChange: (term: string) => void;
};

/**
 * Search + bulk-action (Move/Delete) toolbar.
 * Log Usage / Fast Restock / + Add Row live on their own action strip in InventoryPage.
 */
export function InventoryToolbar({
  canEdit,
  canEditTable,
  selectedCount,
  isMobile,
  hasSelectedRows,
  showLocationPills,
  onMoveSelectedRows,
  onRequestDelete,
  locationOptions,
  effectiveLocationFilter,
  rowCount,
  searchTerm,
  onSearchChange,
}: InventoryToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const showSearchInput = !isMobile || searchOpen || searchTerm.length > 0;

  if (!canEdit) return null;

  return (
    <div className="inventory-header-actions">
      {canEditTable && !isMobile && rowCount > 1 && hasSelectedRows ? (
        <>
          {showLocationPills && locationOptions.length > 1 ? (
            <details className="inventory-move-menu">
              <summary className="inventory-import-trigger">
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
          <button className="inventory-import-trigger inventory-delete-trigger" onClick={onRequestDelete}>
            Delete ({selectedCount})
          </button>
        </>
      ) : null}
      {isMobile && !showSearchInput ? (
        <button
          type="button"
          className="inventory-search-toggle"
          onClick={() => setSearchOpen(true)}
          aria-label="Search"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      ) : (
        <div className="inventory-search-wrap inventory-toolbar-search">
          {isMobile && !searchTerm && (
            <button
              type="button"
              className="inventory-search-close"
              onClick={() => setSearchOpen(false)}
              aria-label="Close search"
            >
              ×
            </button>
          )}
          <input
            className="inventory-search-input"
            placeholder="Search inventory..."
            value={searchTerm}
            onChange={(event) => onSearchChange(event.target.value)}
            onBlur={() => { if (isMobile && !searchTerm) setSearchOpen(false); }}
            autoFocus={isMobile && searchOpen}
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
      )}
    </div>
  );
}
