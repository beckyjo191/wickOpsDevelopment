import { Settings as SettingsIcon } from "lucide-react";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

interface AppToolbarProps {
  view: string;
  onNavigate: (view: string) => void;
}

export function AppToolbar({
  view,
  onNavigate,
}: AppToolbarProps) {
  const settingsActive = view === "settings" || view === "invite";
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
          className={`app-toolbar-nav-item${settingsActive ? " active" : ""}`}
          onClick={() => onNavigate("settings")}
          aria-label="Settings"
        >
          <SettingsIcon size={18} className="app-toolbar-nav-icon" />
          <span className="app-toolbar-nav-label">Settings</span>
        </button>
      </nav>
    </header>
  );
}
