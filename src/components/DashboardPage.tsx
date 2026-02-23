import { MODULE_REGISTRY, type AppModuleKey } from "../lib/moduleRegistry";

interface DashboardPageProps {
  accessibleModules: AppModuleKey[];
  onNavigateToModule: (key: AppModuleKey) => void;
}

export function DashboardPage({
  accessibleModules,
  onNavigateToModule,
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
