import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, Package, ShoppingCart } from "lucide-react";
import { LoadingState } from "./shared/LoadingState";
import type { AppModuleKey } from "../lib/moduleRegistry";
import {
  fetchInventoryAlertSummary,
  listInventoryLocations,
  type InventoryAlertSummary,
  type InventoryLocation,
} from "../lib/inventoryApi";
import { pickLoadingLine } from "../lib/loadingLines";
import { buildLocationPickerEntries, locationsInScope, locationPath } from "../lib/locationTree";

type InventoryFilter = "expired" | "exp30" | "lowStock" | "logUsage";

interface DashboardPageProps {
  accessibleModules: AppModuleKey[];
  canEditInventory?: boolean;
  /** Currently-scoped location id from App-level state. Empty string for "All Locations". */
  selectedLocationId: string | null;
  onSelectedLocationIdChange: (locationId: string | null) => void;
  onNavigate: (view: string) => void;
  /** Navigate to Inventory with a filter pre-applied. The optional locationId
   *  scopes the inventory view; pass undefined to leave the current scope. */
  onNavigateToInventoryWithFilter?: (filter: InventoryFilter, locationId?: string | null) => void;
}

export function DashboardPage({
  accessibleModules,
  canEditInventory,
  selectedLocationId,
  onSelectedLocationIdChange,
  onNavigate,
  onNavigateToInventoryWithFilter,
}: DashboardPageProps) {
  const [alertSummary, setAlertSummary] = useState<InventoryAlertSummary | null>(null);
  const [structuralLocations, setStructuralLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());

  const hasInventory = accessibleModules.includes("inventory");
  const canSeeAlerts = !!onNavigateToInventoryWithFilter && hasInventory;

  useEffect(() => {
    if (!canSeeAlerts) {
      setLoading(false);
      return;
    }
    // Load alert summary + locations in parallel. The summary is keyed by
    // locationId; the locations list gives us the tree to roll a primary up
    // over its sublocations and to render the grouped picker.
    void Promise.all([
      fetchInventoryAlertSummary().then(setAlertSummary),
      listInventoryLocations().then(setStructuralLocations).catch(() => setStructuralLocations([])),
    ]).finally(() => setLoading(false));
  }, [canSeeAlerts]);

  // Alert counts arrive keyed by location id. A primary rolls up by summing
  // its own counts plus those of its sublocations.
  const countsById = useMemo(() => {
    const m = new Map<string, { expiredCount: number; expiringSoonCount: number; lowStockCount: number }>();
    for (const b of alertSummary?.byLocation ?? []) {
      // Fall back to name only for legacy responses that lack locationId.
      m.set(b.locationId || b.location, {
        expiredCount: b.expiredCount,
        expiringSoonCount: b.expiringSoonCount,
        lowStockCount: b.lowStockCount,
      });
    }
    return m;
  }, [alertSummary]);
  const countsForScope = (scopeId: string) => {
    let expiredCount = 0;
    let expiringSoonCount = 0;
    let lowStockCount = 0;
    for (const locId of locationsInScope(structuralLocations, scopeId)) {
      const c = countsById.get(locId);
      if (!c) continue;
      expiredCount += c.expiredCount;
      expiringSoonCount += c.expiringSoonCount;
      lowStockCount += c.lowStockCount;
    }
    return { expiredCount, expiringSoonCount, lowStockCount };
  };

  useEffect(() => {
    if (!loading) return;
    const interval = window.setInterval(() => {
      setLoadingMessage(pickLoadingLine());
    }, 2200);
    return () => window.clearInterval(interval);
  }, [loading]);

  // Grouped picker entries (stations, each followed by their child cabinets).
  const pickerEntries = useMemo(
    () => buildLocationPickerEntries(structuralLocations),
    [structuralLocations],
  );
  const showLocationPills = pickerEntries.length >= 1;

  // The scope currently shown. Auto-default to the first entry when the saved
  // selection isn't a known location (e.g. it was just deleted).
  const selectedScopeId = selectedLocationId ?? "";
  const validSelection =
    selectedScopeId !== "" && structuralLocations.some((l) => l.id === selectedScopeId);
  const displayedScopeId = validSelection ? selectedScopeId : (pickerEntries[0]?.id ?? "");
  const displayedLocation = displayedScopeId ? (locationPath(structuralLocations, displayedScopeId) || null) : null;
  const displayedLocationId = displayedScopeId || null;

  useEffect(() => {
    if (!validSelection && pickerEntries.length > 0) {
      onSelectedLocationIdChange(pickerEntries[0].id);
    }
    // onSelectedLocationIdChange is stable enough here — only called when the
    // saved selection isn't a known location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validSelection, pickerEntries]);

  // Alert counts for the displayed scope (a station sums its cabinets).
  const activeAlerts = alertSummary && displayedScopeId ? countsForScope(displayedScopeId) : null;

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
                  {pickerEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`inventory-dropdown-option${displayedScopeId === entry.id ? " active" : ""}${entry.depth === 1 ? " inventory-dropdown-option--child" : ""}`}
                      onClick={(e) => {
                        onSelectedLocationIdChange(entry.id);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      {entry.label}
                      {entry.isStation ? <span className="inventory-dropdown-hint"> · all</span> : null}
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
                  onClick={() => onNavigateToInventoryWithFilter("expired", displayedLocationId)}
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
                  onClick={() => onNavigateToInventoryWithFilter("exp30", displayedLocationId)}
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
                  onClick={() => onNavigateToInventoryWithFilter("lowStock", displayedLocationId)}
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
                  onClick={() => onNavigateToInventoryWithFilter("logUsage", displayedLocationId)}
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
