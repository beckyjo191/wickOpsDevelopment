import { useState } from "react";
import { Search, X } from "lucide-react";

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
          <Search size={18} />
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
              <X size={14} />
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
              <X size={14} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
