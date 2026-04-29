import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, Package, ShoppingCart } from "lucide-react";
import { LoadingState } from "./shared/LoadingState";
import type { AppModuleKey } from "../lib/moduleRegistry";
import { fetchInventoryAlertSummary, type InventoryAlertSummary } from "../lib/inventoryApi";
import { pickLoadingLine } from "../lib/loadingLines";

type InventoryFilter = "expired" | "exp30" | "lowStock" | "logUsage";

interface DashboardPageProps {
  accessibleModules: AppModuleKey[];
  canEditInventory?: boolean;
  selectedLocation: string | null;
  onLocationChange: (location: string | null) => void;
  onNavigate: (view: string) => void;
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

  // What the dropdown trigger and "No issues at X" text should actually
  // display. When the saved selectedLocation isn't valid (e.g. user just
  // emptied "Unassigned"), the auto-sync above will correct the stored
  // value on the next tick — but in this render we still want the UI to
  // show the location whose data is actually being shown, not the stale
  // saved value.
  const displayedLocation = validSelection
    ? selectedLocation
    : (locations[0]?.location ?? null);

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
        <LoadingState variant="card" message={loadingMessage} />
      </section>
    );
  }

  return (
    <section className="app-content">
      {hasInventory ? (
        <div className="dash-module-card">
          <div className="dash-module-header">
            <span className="dash-module-icon"><Package size={22} strokeWidth={2} /></span>
            <h3 className="dash-module-name">Inventory</h3>
            {showLocationPills && (
              <details className="inventory-dropdown dash-location-dropdown">
                <summary className="inventory-dropdown-trigger">
                  {displayedLocation || "All Locations"}
                  <ChevronDown className="inventory-dropdown-chevron" size={14} aria-hidden="true" />
                </summary>
                <div className="inventory-dropdown-panel">
                  {locationBadges.map((loc) => (
                    <button
                      key={loc.location}
                      type="button"
                      className={`inventory-dropdown-option${displayedLocation === loc.location ? " active" : ""}`}
                      onClick={(e) => {
                        onLocationChange(loc.location);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      {loc.location}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>

          {activeAlerts && !hasAlerts && displayedLocation ? (
            <div className="dash-no-alerts">
              <span className="dash-no-alerts-icon" aria-hidden="true"><Check size={16} /></span>
              <span>No issues at {displayedLocation}</span>
            </div>
          ) : null}

          {hasAlerts && onNavigateToInventoryWithFilter ? (
            <div className="app-alert-cards">
              {activeAlerts.expiredCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--danger"
                  onClick={() => onNavigateToInventoryWithFilter("expired", displayedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.expiredCount} expired item{activeAlerts.expiredCount !== 1 ? "s" : ""}
                  </span>
                  <span className="app-alert-card__action">View <ChevronRight size={14} /></span>
                </button>
              ) : null}
              {activeAlerts.expiringSoonCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--caution"
                  onClick={() => onNavigateToInventoryWithFilter("exp30", displayedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.expiringSoonCount} item{activeAlerts.expiringSoonCount !== 1 ? "s" : ""} expiring within 30 days
                  </span>
                  <span className="app-alert-card__action">View <ChevronRight size={14} /></span>
                </button>
              ) : null}
              {activeAlerts.lowStockCount > 0 ? (
                <button
                  type="button"
                  className="app-alert-card app-alert-card--warning"
                  onClick={() => onNavigateToInventoryWithFilter("lowStock", displayedLocation)}
                >
                  <span className="app-alert-card__icon">
                    <Package size={16} strokeWidth={2} />
                  </span>
                  <span className="app-alert-card__text">
                    {activeAlerts.lowStockCount} item{activeAlerts.lowStockCount !== 1 ? "s" : ""} low on stock
                  </span>
                  <span className="app-alert-card__action">View <ChevronRight size={14} /></span>
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
                  <span className="app-alert-card__action">Open <ChevronRight size={14} /></span>
                </button>
              ) : null}
            </div>
          ) : null}

          {(hasInventory || canEditInventory) ? (
            <div className="dash-quick-actions">
              {hasInventory && onNavigateToInventoryWithFilter ? (
                <button
                  type="button"
                  className="dash-action-btn"
                  onClick={() => onNavigateToInventoryWithFilter("logUsage", displayedLocation)}
                >
                  <ClipboardList size={18} strokeWidth={2} />
                  <span>Log Usage</span>
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
