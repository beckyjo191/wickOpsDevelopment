import type { ActiveTab } from "./inventoryTypes";

export type InventoryFilterBarProps = {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  tabCounts: { expired: number; exp30: number; exp60: number; lowStock: number };
  hasExpirationColumn: boolean;
  hasMinQuantityColumn: boolean;
  canReviewSubmissions?: boolean;
  pendingCount: number;
  isMobile: boolean;
};

type TabDef = {
  key: ActiveTab;
  label: string;
  mobileLabel: string;
  count?: number;
  /** Only show this tab when this returns true */
  visible: boolean;
};

/**
 * Filter bar with tabs (desktop) / select (mobile) and search input.
 * Extracted from InventoryPage lines ~2111-2239.
 * Tab buttons are now data-driven instead of manually repeated.
 */
export function InventoryFilterBar({
  activeTab,
  onTabChange,
  searchTerm,
  onSearchChange,
  tabCounts,
  hasExpirationColumn,
  hasMinQuantityColumn,
  canReviewSubmissions,
  pendingCount,
  isMobile,
}: InventoryFilterBarProps) {
  const tabs: TabDef[] = [
    { key: "all", label: "All Items", mobileLabel: "All Items", visible: true },
    { key: "expired", label: "Expired", mobileLabel: "Expired", count: tabCounts.expired, visible: hasExpirationColumn },
    { key: "exp30", label: "Expiring Within 30 Days", mobileLabel: "Expiring 30d", count: tabCounts.exp30, visible: hasExpirationColumn },
    { key: "exp60", label: "Expiring Within 60 Days", mobileLabel: "Expiring 60d", count: tabCounts.exp60, visible: hasExpirationColumn },
    { key: "lowStock", label: "Low Stock", mobileLabel: "Low Stock", count: tabCounts.lowStock, visible: hasMinQuantityColumn },
    { key: "pendingSubmissions", label: "Pending Submissions", mobileLabel: "Pending", count: pendingCount, visible: !!canReviewSubmissions },
  ];

  const visibleTabs = tabs.filter((t) => t.visible);

  return (
    <div className="inventory-filter-bar">
      {isMobile ? (
        <select
          className="inventory-tab-select"
          value={activeTab}
          onChange={(e) => onTabChange(e.target.value as ActiveTab)}
        >
          {visibleTabs.map((tab) => (
            <option key={tab.key} value={tab.key}>
              {tab.mobileLabel}{tab.count && tab.count > 0 ? ` (${tab.count})` : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="inventory-tabs" role="tablist" aria-label="Inventory filters">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              className={`inventory-tab-btn${activeTab === tab.key ? " active" : ""}`}
              onClick={() => onTabChange(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
            >
              {tab.label}
              {tab.count && tab.count > 0 && activeTab !== tab.key ? (
                <span className="inventory-tab-badge">{tab.count}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
      <div className="inventory-filter-right">
        <div className="inventory-search-wrap">
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
      </div>
    </div>
  );
}
