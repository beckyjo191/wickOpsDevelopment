import { useEffect, useState } from "react";
import { AlertTriangle, Package } from "lucide-react";
import { MODULE_REGISTRY, type AppModuleKey } from "../lib/moduleRegistry";
import { fetchInventoryAlertSummary, type InventoryAlertSummary } from "../lib/inventoryApi";

type InventoryFilter = "expired" | "exp30" | "lowStock";

interface DashboardPageProps {
  accessibleModules: AppModuleKey[];
  onNavigateToModule: (key: AppModuleKey) => void;
  onNavigateToInventoryWithFilter?: (filter: InventoryFilter) => void;
}

export function DashboardPage({
  accessibleModules,
  onNavigateToModule,
  onNavigateToInventoryWithFilter,
}: DashboardPageProps) {
  const [alertSummary, setAlertSummary] = useState<InventoryAlertSummary | null>(null);

  const canSeeAlerts =
    !!onNavigateToInventoryWithFilter && accessibleModules.includes("inventory");

  useEffect(() => {
    if (!canSeeAlerts) return;
    void fetchInventoryAlertSummary().then(setAlertSummary);
  }, [canSeeAlerts]);

  const hasAlerts =
    alertSummary &&
    (alertSummary.expiredCount > 0 ||
      alertSummary.expiringSoonCount > 0 ||
      alertSummary.lowStockCount > 0);

  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Modules</h2>
            <p className="app-subtitle">Choose a module to continue.</p>
          </div>
        </header>

        {hasAlerts && onNavigateToInventoryWithFilter ? (
          <div className="app-alert-cards">
            {alertSummary.expiredCount > 0 ? (
              <button
                type="button"
                className="app-alert-card app-alert-card--danger"
                onClick={() => onNavigateToInventoryWithFilter("expired")}
              >
                <span className="app-alert-card__icon">
                  <AlertTriangle size={16} strokeWidth={2} />
                </span>
                <span className="app-alert-card__text">
                  {alertSummary.expiredCount} expired item{alertSummary.expiredCount !== 1 ? "s" : ""}
                </span>
                <span className="app-alert-card__action">View →</span>
              </button>
            ) : null}
            {alertSummary.expiringSoonCount > 0 ? (
              <button
                type="button"
                className="app-alert-card app-alert-card--warning"
                onClick={() => onNavigateToInventoryWithFilter("exp30")}
              >
                <span className="app-alert-card__icon">
                  <AlertTriangle size={16} strokeWidth={2} />
                </span>
                <span className="app-alert-card__text">
                  {alertSummary.expiringSoonCount} item{alertSummary.expiringSoonCount !== 1 ? "s" : ""} expiring within 30 days
                </span>
                <span className="app-alert-card__action">View →</span>
              </button>
            ) : null}
            {alertSummary.lowStockCount > 0 ? (
              <button
                type="button"
                className="app-alert-card app-alert-card--info"
                onClick={() => onNavigateToInventoryWithFilter("lowStock")}
              >
                <span className="app-alert-card__icon">
                  <Package size={16} strokeWidth={2} />
                </span>
                <span className="app-alert-card__text">
                  {alertSummary.lowStockCount} item{alertSummary.lowStockCount !== 1 ? "s" : ""} low on stock
                </span>
                <span className="app-alert-card__action">View →</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="app-actions">
          {MODULE_REGISTRY.filter((m) => accessibleModules.includes(m.key)).map((m, i) => (
            <button
              key={m.key}
              className={`button ${i === 0 ? "button-primary" : "button-secondary"}`}
              onClick={() => onNavigateToModule(m.key)}
            >
              {m.name}
            </button>
          ))}
          {accessibleModules.length === 0 ? (
            <p className="app-subtitle">No modules are enabled for your account.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
