import type { AppModuleKey } from "../lib/moduleRegistry";

type InventorySubView = "inventory" | "usage" | "quickadd" | "activity";

interface InventorySubNavProps {
  activeView: InventorySubView;
  accessibleModules: AppModuleKey[];
  canEditInventory: boolean;
  onNavigate: (view: InventorySubView) => void;
}

export function InventorySubNav({
  activeView,
  accessibleModules,
  canEditInventory,
  onNavigate,
}: InventorySubNavProps) {
  const showInventory = accessibleModules.includes("inventory");
  const showUsage = accessibleModules.includes("usage");
  const showQuickAdd = showInventory && canEditInventory;
  const showActivity = showInventory;

  const visibleCount = (showInventory ? 1 : 0) + (showUsage ? 1 : 0) + (showQuickAdd ? 1 : 0) + (showActivity ? 1 : 0);
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
      {showActivity && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "activity"}
          className={`inventory-subnav-item${activeView === "activity" ? " active" : ""}`}
          onClick={() => onNavigate("activity")}
        >
          Activity
        </button>
      )}
    </nav>
  );
}
