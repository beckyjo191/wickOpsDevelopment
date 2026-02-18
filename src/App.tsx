import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";
import { InventoryPage } from "./components/InventoryPage";
import { SettingsPage } from "./components/SettingsPage";
import { DashboardPage } from "./components/DashboardPage";
import { AppToolbar } from "./components/AppToolbar";
import { authFetch } from "./lib/authFetch";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
} from "./lib/themePreference";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVITES_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVITES_API_BASE_URL);
const VIEW_STORAGE_KEY = "wickops.activeView";
const SUBSCRIPTION_RETRY_MS = 2000;
const MAX_SUBSCRIPTION_RETRIES = 6;
const APP_LOADING_LINES = [
  "Warming up the dashboard hamsters...",
  "Polishing your seat count...",
  "Negotiating with the loading bar...",
  "Counting pixels twice for accuracy...",
  "Folding business logic into tiny squares...",
];

const pickRandom = (items: string[]): string =>
  items[Math.floor(Math.random() * items.length)] ?? "Loading...";

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";
type AppView = "dashboard" | "inventory" | "invite" | "settings";
type BreadcrumbItem = {
  label: string;
  onClick?: () => void;
};

const isAppView = (value: unknown): value is AppView =>
  value === "dashboard" || value === "inventory" || value === "invite" || value === "settings";

const loadInitialView = (): AppView => {
  try {
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isAppView(saved) ? saved : "dashboard";
  } catch {
    return "dashboard";
  }
};

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator() as any;
  const [view, setView] = useState<AppView>(() => loadInitialView());
  const [loadingLine, setLoadingLine] = useState(() => pickRandom(APP_LOADING_LINES));
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => loadThemePreference());

  const [subState, setSubState] = useState<{
    status: SubscriptionState;
    displayName: string;
    organizationId: string;
    orgName: string;
    seatLimit: number;
    seatsUsed: number;
    accessSuspended: boolean;
    canInviteUsers: boolean;
    role: string;
    loadError: boolean;
  }>({
    status: "loading",
    displayName: "",
    organizationId: "",
    orgName: "",
    seatLimit: 1,
    seatsUsed: 0,
    accessSuspended: false,
    canInviteUsers: false,
    role: "",
    loadError: false,
  });

  useEffect(() => {
    if (authStatus !== "authenticated") return;

    let pollInterval: number | undefined;
    let retryTimeout: number | undefined;
    let cancelled = false;
    let consecutiveFailures = 0;

    const checkoutSuccess =
      window.location.pathname === "/success" ||
      new URLSearchParams(window.location.search).get("checkout") === "success";

    const checkSubscription = async () => {
      if (cancelled) return;
      try {
        const res = await authFetch(`${API_BASE_URL}/user-subscription`);
        if (res.status === 202) {
          consecutiveFailures = 0;
          setSubState((prev) => ({
            ...prev,
            status: "loading",
            loadError: false,
          }));
          return;
        }
        if (!res.ok) throw new Error("Subscription check failed");

        const data = await res.json();
        consecutiveFailures = 0;

        const status =
          data.subscribed && !data.accessSuspended
            ? "subscribed"
            : "unsubscribed";

        setSubState({
          status,
          displayName: String(data.displayName ?? ""),
          organizationId: String(data.organizationId ?? ""),
          orgName: String(data.orgName ?? ""),
          seatLimit: data.seatLimit ?? 1,
          seatsUsed: data.seatsUsed ?? 0,
          accessSuspended: !!data.accessSuspended,
          canInviteUsers: !!data.canInviteUsers,
          role: String(data.role ?? "").toUpperCase(),
          loadError: false,
        });

        if (status === "subscribed" && pollInterval) {
          clearInterval(pollInterval);
        }
      } catch (err) {
        console.error("Subscription check error:", err);
        consecutiveFailures += 1;
        if (checkoutSuccess || consecutiveFailures < MAX_SUBSCRIPTION_RETRIES) {
          setSubState((prev) => ({
            ...prev,
            status: "loading",
            loadError: false,
          }));
          if (!checkoutSuccess) {
            if (retryTimeout) window.clearTimeout(retryTimeout);
            retryTimeout = window.setTimeout(() => {
              void checkSubscription();
            }, SUBSCRIPTION_RETRY_MS);
          }
          return;
        }
        setView("dashboard");
        setSubState({
          status: "loading",
          displayName: "",
          organizationId: "",
          orgName: "",
          seatLimit: 1,
          seatsUsed: 0,
          accessSuspended: false,
          canInviteUsers: false,
          role: "",
          loadError: true,
        });
      }
    };

    void checkSubscription();

    if (checkoutSuccess) {
      pollInterval = window.setInterval(checkSubscription, 3000);
      setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
      }, 30000);
    }

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (retryTimeout) window.clearTimeout(retryTimeout);
    };
  }, [authStatus]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // No-op: storage may be unavailable in private mode or locked environments.
    }
  }, [view]);

  useEffect(() => {
    applyThemePreference(themePreference);
    saveThemePreference(themePreference);
  }, [themePreference]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const openMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("details[open]"));
      for (const menu of openMenus) {
        if (!target || !menu.contains(target)) {
          menu.removeAttribute("open");
        }
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openMenus = Array.from(document.querySelectorAll<HTMLDetailsElement>("details[open]"));
      for (const menu of openMenus) {
        menu.removeAttribute("open");
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  useEffect(() => {
    if (!(authStatus === "configuring" || (subState.status === "loading" && !subState.loadError))) {
      return;
    }
    const interval = window.setInterval(() => {
      setLoadingLine(pickRandom(APP_LOADING_LINES));
    }, 2200);
    return () => window.clearInterval(interval);
  }, [authStatus, subState.status, subState.loadError]);

  if (authStatus === "configuring" || (subState.status === "loading" && !subState.loadError)) {
    return <div>{loadingLine}</div>;
  }

  if (subState.loadError) {
    return (
      <section className="app-page">
        <div className="app-card">
          <header className="app-header">
            <div>
              <h2 className="app-title">Could Not Load Subscription</h2>
              <p className="app-subtitle">Please refresh in a few seconds and try again.</p>
            </div>
          </header>
          <div className="app-actions">
            <button className="button button-ghost" onClick={signOut}>
              Sign Out
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (authStatus !== "authenticated" || !user) return null;

  if (subState.status === "unsubscribed" || subState.accessSuspended) {
    return <SubscriptionPage />;
  }

  const userEmail = user?.attributes?.email ?? user?.signInDetails?.loginId ?? "";
  const userName =
    subState.displayName.trim() ||
    user?.attributes?.name?.trim() ||
    user?.attributes?.preferred_username?.trim() ||
    userEmail ||
    "User";
  const seatsRemaining = subState.seatLimit - subState.seatsUsed;
  const canInviteMore = subState.canInviteUsers && seatsRemaining > 0;
  const canEditInventory = ["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"].includes(subState.role);
  const canManageInventoryColumns = ["ADMIN", "OWNER", "ACCOUNT_OWNER"].includes(subState.role);
  const breadcrumbs: BreadcrumbItem[] =
    view === "inventory"
      ? [
          { label: "Dashboard", onClick: () => setView("dashboard") },
          { label: "Inventory" },
        ]
      : view === "settings"
        ? [
            { label: "Dashboard", onClick: () => setView("dashboard") },
            { label: "Settings" },
          ]
        : view === "invite"
          ? [
              { label: "Dashboard", onClick: () => setView("dashboard") },
              { label: "Settings", onClick: () => setView("settings") },
              { label: "Invite Users" },
            ]
          : [{ label: "Dashboard" }];

  let content: JSX.Element;
  if (view === "settings") {
    content = (
      <SettingsPage
        canInviteMore={canInviteMore}
        seatsRemaining={seatsRemaining}
        seatLimit={subState.seatLimit}
        seatsUsed={subState.seatsUsed}
        canManageInventoryColumns={canManageInventoryColumns}
        themePreference={themePreference}
        onThemePreferenceChange={setThemePreference}
        onInviteUsers={() => {
          if (!canInviteMore) return;
          setView("invite");
        }}
      />
    );
  } else if (view === "inventory") {
    content = (
      <InventoryPage
        canEditInventory={canEditInventory}
        canManageInventoryColumns={canManageInventoryColumns}
      />
    );
  } else if (view === "invite") {
    content = canInviteMore ? (
      <InviteUsersPage
        maxUsers={subState.seatLimit}  // total seats
        seatsUsed={subState.seatsUsed} // seats already used
        onContinue={async (invites) => {
          if (!INVITES_API_BASE_URL) {
            throw new Error("Missing VITE_INVITES_API_BASE_URL");
          }

          const res = await authFetch(`${INVITES_API_BASE_URL}/send-invites`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invites }),
          });

          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || "Failed to send invites");
          }

          const data = await res.json();
          if ((data?.invitedCount ?? 0) <= 0) {
            throw new Error(data?.failed?.[0]?.error ?? "No invites were sent");
          }

          setView("dashboard");
        }}
      />
    ) : (
      <DashboardPage
        onGoToInventory={() => setView("inventory")}
      />
    );
  } else {
    content = (
      <DashboardPage
        onGoToInventory={() => setView("inventory")}
      />
    );
  }

  return (
    <section className="app-shell">
      <AppToolbar
        currentView={view}
        userName={userName}
        orgName={subState.orgName}
        onGoToInventory={() => setView("inventory")}
        onOpenSettings={() => setView("settings")}
        onLogout={signOut}
      />
      <nav className="app-breadcrumbs" aria-label="Breadcrumb">
        {breadcrumbs.map((item, index) => (
          <span key={`${item.label}-${index}`} className="app-breadcrumb-item">
            {item.onClick ? (
              <button
                type="button"
                className="app-breadcrumb-link"
                onClick={item.onClick}
              >
                {item.label}
              </button>
            ) : (
              <span className="app-breadcrumb-current" aria-current="page">
                {item.label}
              </span>
            )}
            {index < breadcrumbs.length - 1 ? (
              <span className="app-breadcrumb-separator" aria-hidden="true">
                &gt;
              </span>
            ) : null}
          </span>
        ))}
      </nav>
      {content}
    </section>
  );
}
