import type { AppModuleKey } from "../lib/moduleRegistry";

type InventorySubView = "inventory" | "usage" | "quickadd";

interface InventorySubNavProps {
  activeView: InventorySubView;
  accessibleModules: AppModuleKey[];
  onNavigate: (view: InventorySubView) => void;
}

export function InventorySubNav({
  activeView,
  accessibleModules,
  onNavigate,
}: InventorySubNavProps) {
  const showInventory = accessibleModules.includes("inventory");
  const showUsage = accessibleModules.includes("usage");
  // Quick Add requires inventory editing access (same gate as inventory)
  const showQuickAdd = showInventory;

  const visibleCount = (showInventory ? 1 : 0) + (showUsage ? 1 : 0) + (showQuickAdd ? 1 : 0);
  if (visibleCount < 2) return null;

  return (
    <nav
      className="inventory-subnav"
      role="tablist"
      aria-label="Inventory section"
    >
      {showInventory && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "inventory"}
          className={`inventory-subnav-item${activeView === "inventory" ? " active" : ""}`}
          onClick={() => onNavigate("inventory")}
        >
          Inventory
        </button>
      )}
      {showUsage && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "usage"}
          className={`inventory-subnav-item${activeView === "usage" ? " active" : ""}`}
          onClick={() => onNavigate("usage")}
        >
          Log Usage
        </button>
      )}
      {showQuickAdd && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "quickadd"}
          className={`inventory-subnav-item${activeView === "quickadd" ? " active" : ""}`}
          onClick={() => onNavigate("quickadd")}
        >
          Quick Add
        </button>
      )}
    </nav>
  );
}
