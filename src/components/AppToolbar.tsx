import type { MouseEvent } from "react";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

interface AppToolbarProps {
  userName: string;
  orgName?: string;
  onNavigateToDashboard: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function AppToolbar({
  userName,
  orgName,
  onNavigateToDashboard,
  onOpenSettings,
  onLogout,
}: AppToolbarProps) {
  const closeMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const details = event.currentTarget.closest("details");
    details?.removeAttribute("open");
  };

  return (
    <header className="app-toolbar">
      <button
        type="button"
        className="app-toolbar-logo-link"
        onClick={onNavigateToDashboard}
      >
        <img className="app-toolbar-logo" src={logoThumb} alt="WickOps" />
        <span className="app-toolbar-brand-text">WickOps</span>
      </button>

      <details className="app-user-menu">
        <summary className="app-user-menu-trigger">
          {userName}
        </summary>
        <div className="app-user-menu-panel">
          {orgName ? (
            <div className="app-user-menu-org" aria-label="Current organization">
              {orgName}
            </div>
          ) : null}
          <button
            className="app-user-menu-item"
            onClick={(event) => {
              closeMenu(event);
              onOpenSettings();
            }}
          >
            Settings
          </button>
          <button
            className="app-user-menu-item app-user-menu-item-danger"
            onClick={(event) => {
              closeMenu(event);
              onLogout();
            }}
          >
            Logout
          </button>
        </div>
      </details>
    </header>
  );
}
