interface DashboardPageProps {
  canAccessInventory: boolean;
  canAccessUsage: boolean;
  onGoToInventory: () => void;
  onGoToUsage: () => void;
}

export function DashboardPage({
  canAccessInventory,
  canAccessUsage,
  onGoToInventory,
  onGoToUsage,
}: DashboardPageProps) {
  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Modules</h2>
            <p className="app-subtitle">Choose a module to continue.</p>
          </div>
        </header>

        <div className="app-actions">
          {canAccessInventory ? (
            <button className="button button-primary" onClick={onGoToInventory}>
              Inventory
            </button>
          ) : null}
          {canAccessUsage ? (
            <button className="button button-secondary" onClick={onGoToUsage}>
              Usage Form
            </button>
          ) : null}
          {!canAccessInventory && !canAccessUsage ? (
            <p className="app-subtitle">No modules are enabled for your account.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
