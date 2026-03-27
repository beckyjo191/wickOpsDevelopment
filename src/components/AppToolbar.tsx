import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

type AppView = "dashboard" | "inventory" | "usage" | "quickadd" | "activity" | "invite" | "settings";

interface AppToolbarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
}

export function AppToolbar({
  view,
  onNavigate,
}: AppToolbarProps) {
  return (
    <header className="app-toolbar">
      <button
        type="button"
        className="app-toolbar-logo-link"
        onClick={() => onNavigate("dashboard")}
      >
        <img className="app-toolbar-logo" src={logoThumb} alt="WickOps" />
        <span className="app-toolbar-brand-text">WickOps</span>
      </button>

      <nav className="app-toolbar-nav">
        <button
          type="button"
          className={`app-toolbar-nav-item${view === "dashboard" ? " active" : ""}`}
          onClick={() => onNavigate("dashboard")}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={`app-toolbar-nav-item${view === "settings" || view === "invite" ? " active" : ""}`}
          onClick={() => onNavigate("settings")}
        >
          Settings
        </button>
      </nav>
    </header>
  );
}
