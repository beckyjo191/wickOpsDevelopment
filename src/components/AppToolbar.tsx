import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

interface AppToolbarProps {
  currentView: "dashboard" | "inventory" | "invite" | "settings";
  userName: string;
  onGoToDashboard: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function AppToolbar({
  currentView,
  userName,
  onGoToDashboard,
  onOpenSettings,
  onLogout,
}: AppToolbarProps) {
  return (
    <header className="app-toolbar">
      <a className="app-toolbar-logo-link" href="/">
        <img className="app-toolbar-logo" src={logoThumb} alt="WickOps Systems" />
        <span className="app-toolbar-brand-text">WickOps Systems</span>
      </a>

      <button
        className="app-toolbar-dashboard-link"
        onClick={onGoToDashboard}
        aria-current={currentView === "dashboard" ? "page" : undefined}
      >
        Dashboard
      </button>

      <details className="app-user-menu">
        <summary className="app-user-menu-trigger">
          {userName}
        </summary>
        <div className="app-user-menu-panel">
          <button className="app-user-menu-item" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="app-user-menu-item app-user-menu-item-danger" onClick={onLogout}>
            Logout
          </button>
        </div>
      </details>
    </header>
  );
}
