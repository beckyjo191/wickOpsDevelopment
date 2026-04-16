import type { ActiveTab } from "./inventoryTypes";

export type InventoryFilterBarProps = {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  tabCounts: { expired: number; exp30: number; exp60: number; lowStock: number; retired: number };
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
    { key: "retired", label: "Retired", mobileLabel: "Retired", count: tabCounts.retired, visible: hasExpirationColumn && (tabCounts.retired > 0 || activeTab === "retired") },
    { key: "pendingSubmissions", label: "Pending Submissions", mobileLabel: "Pending", count: pendingCount, visible: !!canReviewSubmissions },
  ];

  const visibleTabs = tabs.filter((t) => t.visible);
  const activeTabDef = visibleTabs.find((t) => t.key === activeTab) ?? visibleTabs[0];
  const activeLabel = isMobile ? activeTabDef.mobileLabel : activeTabDef.label;

  return (
    <details className="inventory-dropdown">
      <summary className="inventory-dropdown-trigger">
        {activeLabel}
        {activeTabDef.count && activeTabDef.count > 0 ? (
          <span className="inventory-dropdown-badge">{activeTabDef.count}</span>
        ) : null}
        <svg className="inventory-dropdown-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </summary>
      <div className="inventory-dropdown-panel">
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`inventory-dropdown-option${activeTab === tab.key ? " active" : ""}`}
            onClick={(e) => {
              onTabChange(tab.key);
              e.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            {isMobile ? tab.mobileLabel : tab.label}
            {tab.count && tab.count > 0 ? (
              <span className="inventory-dropdown-badge">{tab.count}</span>
            ) : null}
          </button>
        ))}
      </div>
    </details>
  );
}
