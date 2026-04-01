import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Package, ClipboardList, Zap, ShoppingCart } from "lucide-react";
import type { AppModuleKey } from "../lib/moduleRegistry";
import { fetchInventoryAlertSummary, type InventoryAlertSummary } from "../lib/inventoryApi";
import { LocationPills } from "./LocationPills";
import { pickLoadingLine } from "../lib/loadingLines";

type InventoryFilter = "expired" | "exp30" | "lowStock";
type AppView = "inventory" | "usage" | "orders";

interface DashboardPageProps {
  accessibleModules: AppModuleKey[];
  canEditInventory?: boolean;
  selectedLocation: string | null;
  onLocationChange: (location: string | null) => void;
  onNavigate: (view: AppView) => void;
  onNavigateToInventoryWithFilter?: (filter: InventoryFilter, location?: string | null) => void;
}

export function DashboardPage({
  accessibleModules,
  canEditInventory,
  selectedLocation,
  onLocationChange,
  onNavigate,
  onNavigateToInventoryWithFilter,
}: DashboardPageProps) {
  const [alertSummary, setAlertSummary] = useState<InventoryAlertSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());

  const hasInventory = accessibleModules.includes("inventory");
  const hasUsage = accessibleModules.includes("usage");
  const canSeeAlerts = !!onNavigateToInventoryWithFilter && hasInventory;

  useEffect(() => {
    if (!canSeeAlerts) {
      setLoading(false);
      return;
    }
    void fetchInventoryAlertSummary()
      .then(setAlertSummary)
      .finally(() => setLoading(false));
  }, [canSeeAlerts]);

  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => {
      setLoadingMessage(pickLoadingLine());
    }, 2200);
    return () => window.clearInterval(interval);
  }, [loading]);

  // Derive locations from byLocation (only non-empty location names)
  const locations = alertSummary?.byLocation?.filter((b) => b.location !== "") ?? [];
  const showLocationPills = locations.length >= 1;

  const locationBadges = useMemo(
    () =>
      locations.map((loc) => ({
        location: loc.location,
        badge: loc.expiredCount + loc.expiringSoonCount + loc.lowStockCount,
      })),
    [locations],
  );

  // Auto-select first location if none selected or selected location isn't a real dashboard location
  const validSelection = selectedLocation !== null
    && selectedLocation !== "Unassigned"
    && locations.some((l) => l.location === selectedLocation);

  useEffect(() => {
    if (!validSelection && locations.length > 0) {
      onLocationChange(locations[0].location);
    }
  }, [validSelection, locations, onLocationChange]);

  // Get alert counts for the selected location
  const activeAlerts = (() => {
    if (!alertSummary) return null;
    if (!validSelection && locations.length > 0) {
      // Will auto-select soon, use first location's data in the meantime
      return locations[0];
    }
    const match = alertSummary.byLocation?.find((b) => b.location === selectedLocation);
    return match ?? { expiredCount: 0, expiringSoonCount: 0, lowStockCount: 0 };
  })();

  const hasAlerts =
    activeAlerts &&
    (activeAlerts.expiredCount > 0 ||
      activeAlerts.expiringSoonCount > 0 ||
      activeAlerts.lowStockCount > 0);

  if (loading) {
    return (
      <section className="app-content">
        <div className="app-card app-loading-card">
          <span className="app-spinner" aria-hidden="true" />
          <span>{loadingMessage}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="app-content">
      <h2 className="dash-title">Dashboard</h2>

      {hasInventory ? (
        <div className="dash-module-card">
          <div className="dash-module-header">
            <span className="dash-module-icon"><Package size={22} strokeWidth={2} /></span>
            <h3 className="dash-module-name">Inventory</h3>
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={() => onNavigate("inventory")}
            >
              Open
            </button>
          </div>

          {showLocationPills ? (
            <LocationPills
              locations={locationBadges}
              selectedLocation={selectedLocation}
              onLocationChange={(loc) => onLocationChange(loc)}
            />
          ) : null}

          {activeAlerts && !hasAlerts && selectedLocation ? (
            <div className="dash-no-alerts">
              <span className="dash-no-alerts-icon">✓</span>
              <span>No issues at {selectedLocation}</span>
            </div>
          ) : null}

          {hasAlerts && onNavigateToInventoryWithFilter ? (
            <div className="app-alert-cards">
              {activeAlerts.expiredCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--danger"
                  onClick={() => onNavigateToInventoryWithFilter("expired", selectedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.expiredCount} expired item{activeAlerts.expiredCount !== 1 ? "s" : ""}
                  </span>
                  <span className="app-alert-card__action">View →</span>
                </button>
              ) : null}
              {activeAlerts.expiringSoonCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--caution"
                  onClick={() => onNavigateToInventoryWithFilter("exp30", selectedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.expiringSoonCount} item{activeAlerts.expiringSoonCount !== 1 ? "s" : ""} expiring within 30 days
                  </span>
                  <span className="app-alert-card__action">View →</span>
                </button>
              ) : null}
              {activeAlerts.lowStockCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--warning"
                  onClick={() => onNavigateToInventoryWithFilter("lowStock", selectedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <Package size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.lowStockCount} item{activeAlerts.lowStockCount !== 1 ? "s" : ""} low on stock
                  </span>
                  <span className="app-alert-card__action">View →</span>
                </button>
              ) : null}
              {(activeAlerts.expiredCount > 0 || activeAlerts.lowStockCount > 0) ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--reorder"
                  onClick={() => onNavigate("orders")}
                >
                  <span className="app-alert-card__icon">
                    <ShoppingCart size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    Reorder items
                  </span>
                  <span className="app-alert-card__action">Open →</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {(hasUsage || canEditInventory) ? (
            <div className="dash-quick-actions">
              {hasUsage ? (
                <button
                  type="button"
                  className="dash-action-btn"
                  onClick={() => onNavigate("usage")}
                >
                  <ClipboardList size={18} strokeWidth={2} />
                  <span>Log Usage</span>
                </button>
              ) : null}
              {canEditInventory ? (
                <button
                  type="button"
                  className="dash-action-btn"
                  onClick={() => onNavigate("orders")}
                >
                  <Zap size={18} strokeWidth={2} />
                  <span>Quick Add</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!hasInventory && accessibleModules.length === 0 ? (
        <div className="app-card">
          <p className="app-subtitle">No modules are enabled for your account.</p>
        </div>
      ) : null}
    </section>
  );
}
