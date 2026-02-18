interface DashboardPageProps {
  onGoToInventory: () => void;
}

export function DashboardPage({ onGoToInventory }: DashboardPageProps) {
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
          <button className="button button-primary" onClick={onGoToInventory}>
            Inventory
          </button>
        </div>
      </div>
    </section>
  );
}
