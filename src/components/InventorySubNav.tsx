import type { AppModuleKey } from "../lib/moduleRegistry";

type InventorySubView = "dashboard" | "inventory" | "orders" | "activity";

interface InventorySubNavProps {
  activeView: string;
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
  const showOrders = showInventory && canEditInventory;
  const showActivity = showInventory;

  // Dashboard is always visible. If it's the only tab (user has no inventory
  // access), hide the nav entirely — the user can still reach Dashboard via
  // the logo.
  const visibleCount = 1 + (showInventory ? 1 : 0) + (showOrders ? 1 : 0) + (showActivity ? 1 : 0);
  if (visibleCount < 2) return null;

  return (
    <nav
      className="inventory-subnav"
      role="tablist"
      aria-label="Primary navigation"
    >
      <button
        type="button"
        role="tab"
        aria-selected={activeView === "dashboard"}
        className={`inventory-subnav-item${activeView === "dashboard" ? " active" : ""}`}
        onClick={() => onNavigate("dashboard")}
      >
        Dashboard
      </button>
      {showInventory && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "inventory" || activeView === "usage"}
          className={`inventory-subnav-item${activeView === "inventory" || activeView === "usage" ? " active" : ""}`}
          onClick={() => onNavigate("inventory")}
        >
          Inventory
        </button>
      )}
      {showOrders && (
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "orders"}
          className={`inventory-subnav-item${activeView === "orders" ? " active" : ""}`}
          onClick={() => onNavigate("orders")}
        >
          Orders
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
