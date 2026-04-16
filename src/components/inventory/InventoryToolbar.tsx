import { useState } from "react";

export type InventoryToolbarProps = {
  canEdit: boolean;
  isMobile: boolean;
  searchTerm: string;
  onSearchChange: (term: string) => void;
};

/**
 * Search input for the inventory list.
 * Selection actions (Move to / Delete) and workflow buttons (Log Usage / Fast
 * Restock / + Add Row) live on their own action row in InventoryPage.
 */
export function InventoryToolbar({
  canEdit,
  isMobile,
  searchTerm,
  onSearchChange,
}: InventoryToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const showSearchInput = !isMobile || searchOpen || searchTerm.length > 0;

  if (!canEdit) return null;

  return (
    <div className="inventory-header-actions">
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
