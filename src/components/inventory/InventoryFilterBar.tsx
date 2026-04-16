import type { ActiveTab, InventoryFilter } from "./inventoryTypes";

export type InventoryFilterBarProps = {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  tabCounts: { expired: number; exp30: number; exp60: number; lowStock: number; retired: number };
  hasExpirationColumn: boolean;
  hasMinQuantityColumn: boolean;
  isMobile: boolean;
};

type ChipDef = {
  key: InventoryFilter;
  label: string;
  mobileLabel: string;
  count?: number;
  visible: boolean;
};

/**
 * Filter chip row. Retired items are not surfaced here — they live under Activity.
 */
export function InventoryFilterBar({
  activeTab,
  onTabChange,
  tabCounts,
  hasExpirationColumn,
  hasMinQuantityColumn,
  isMobile,
}: InventoryFilterBarProps) {
  const chips: ChipDef[] = [
    { key: "all", label: "All", mobileLabel: "All", visible: true },
    { key: "expired", label: "Expired", mobileLabel: "Expired", count: tabCounts.expired, visible: hasExpirationColumn },
    { key: "exp30", label: "Expiring Soon", mobileLabel: "Expiring", count: tabCounts.exp30, visible: hasExpirationColumn },
    { key: "lowStock", label: "Low Stock", mobileLabel: "Low", count: tabCounts.lowStock, visible: hasMinQuantityColumn },
  ];

  const visible = chips.filter((c) => c.visible);
  // In quickAdd / logUsage modes, no chip should be highlighted (an inline panel is shown).
  const isInlineMode = activeTab === "quickAdd" || activeTab === "logUsage";
  const activeKey: InventoryFilter = isInlineMode ? "all" : activeTab;

  return (
    <div className="inventory-filter-chips" role="tablist" aria-label="Inventory filters">
      {visible.map((chip) => (
        <button
          key={chip.key}
          type="button"
          role="tab"
          aria-selected={!isInlineMode && activeKey === chip.key}
          className={`inventory-chip${!isInlineMode && activeKey === chip.key ? " active" : ""}`}
          onClick={() => onTabChange(chip.key)}
        >
          <span className="inventory-chip-label">{isMobile ? chip.mobileLabel : chip.label}</span>
          {chip.count && chip.count > 0 ? (
            <span className="inventory-chip-badge">{chip.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
