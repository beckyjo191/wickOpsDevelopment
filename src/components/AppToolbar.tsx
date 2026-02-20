import type { MouseEvent } from "react";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

interface AppToolbarProps {
  currentView: "dashboard" | "inventory" | "usage" | "invite" | "settings";
  userName: string;
  orgName?: string;
  canAccessInventory: boolean;
  canAccessUsage: boolean;
  onGoToInventory: () => void;
  onGoToUsage: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function AppToolbar({
  currentView,
  userName,
  orgName,
  canAccessInventory,
  canAccessUsage,
  onGoToInventory,
  onGoToUsage,
  onOpenSettings,
  onLogout,
}: AppToolbarProps) {
  const closeMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const details = event.currentTarget.closest("details");
    details?.removeAttribute("open");
  };

  return (
    <header className="app-toolbar">
      <a className="app-toolbar-logo-link" href="/">
        <img className="app-toolbar-logo" src={logoThumb} alt="WickOps Systems" />
        <span className="app-toolbar-brand-text">WickOps Systems</span>
      </a>

      {canAccessInventory || canAccessUsage ? (
        <details className="app-module-menu">
          <summary className="app-module-menu-trigger">Modules</summary>
          <div className="app-module-menu-panel">
            {canAccessInventory ? (
              <button
                className="app-module-menu-item"
                onClick={(event) => {
                  closeMenu(event);
                  onGoToInventory();
                }}
                aria-current={currentView === "inventory" ? "page" : undefined}
              >
                Inventory
              </button>
            ) : null}
            {canAccessUsage ? (
              <button
                className="app-module-menu-item"
                onClick={(event) => {
                  closeMenu(event);
                  onGoToUsage();
                }}
                aria-current={currentView === "usage" ? "page" : undefined}
              >
                Usage Form
              </button>
            ) : null}
          </div>
        </details>
      ) : null}

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
