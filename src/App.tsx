import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import { LayoutDashboard, Settings as SettingsIcon } from "lucide-react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";
import { InventoryPage } from "./components/InventoryPage";
import { SettingsPage } from "./components/SettingsPage";
import { DashboardPage } from "./components/DashboardPage";
import { AppToolbar } from "./components/AppToolbar";
import { InventoryUsagePage } from "./components/InventoryUsagePage";
import { OnboardingPage } from "./components/OnboardingPage";
import { InventorySubNav } from "./components/InventorySubNav";
import { QuickAddPage } from "./components/QuickAddPage";
import { authFetch } from "./lib/authFetch";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
} from "./lib/themePreference";

import { normalizeModuleKeys, type AppModuleKey } from "./lib/moduleRegistry";
import type { InventoryFilter } from "./components/InventoryPage";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVITES_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVITES_API_BASE_URL);
const VIEW_STORAGE_KEY = "wickops.activeView";

const SUBSCRIPTION_RETRY_MS = 2000;
const MAX_SUBSCRIPTION_RETRIES = 6;
import { pickAppLine } from "./lib/loadingLines";

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";
type AppView = "dashboard" | "inventory" | "usage" | "quickadd" | "invite" | "settings";

const isAppView = (value: unknown): value is AppView =>
  value === "dashboard" ||
  value === "inventory" ||
  value === "usage" ||
  value === "quickadd" ||
  value === "invite" ||
  value === "settings";

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator() as any;
  const [currentUserEmail, setCurrentUserEmail] = useState("");
  const [view, setViewRaw] = useState<AppView>("dashboard");
  const [inventoryInitialFilter, setInventoryInitialFilter] = useState<InventoryFilter | undefined>(undefined);
  const [inventoryKey, setInventoryKey] = useState(0);
  const setView = (v: AppView) => {
    if (v !== "inventory") setInventoryInitialFilter(undefined);
    setViewRaw(v);
  };
  const [selectedLocation, setSelectedLocation] = useState<string | null>(() => {
    try { return localStorage.getItem("wickops.selectedLocation") ?? null; } catch { return null; }
  });
  const onLocationChange = (loc: string | null) => {
    setSelectedLocation(loc);
    try { if (loc === null) localStorage.removeItem("wickops.selectedLocation"); else localStorage.setItem("wickops.selectedLocation", loc); } catch { /* noop */ }
  };
  const [loadingLine, setLoadingLine] = useState(() => pickAppLine());
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => loadThemePreference());
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 780px)").matches);

  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 780px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Hide the mobile bottom bar when the virtual keyboard is open (iOS/Android)
  useEffect(() => {
    if (!isMobile) return;
    const onFocus = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        setKeyboardOpen(true);
      }
    };
    const onBlur = () => setKeyboardOpen(false);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, [isMobile]);

  const userViewScope =
    String(user?.attributes?.sub ?? "") ||
    String(user?.username ?? "") ||
    String(user?.signInDetails?.loginId ?? "");
  const scopedViewStorageKey = userViewScope ? `${VIEW_STORAGE_KEY}.${userViewScope}` : VIEW_STORAGE_KEY;

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
    allowedModules: AppModuleKey[];
    orgAvailableModules: AppModuleKey[];
    orgEnabledModules: AppModuleKey[];
    onboardingCompleted: boolean;
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
    allowedModules: ["inventory", "usage"],
    orgAvailableModules: [],
    orgEnabledModules: [],
    onboardingCompleted: true,
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
          allowedModules: normalizeModuleKeys(data.allowedModules),
          orgAvailableModules: normalizeModuleKeys(data.orgAvailableModules),
          orgEnabledModules: normalizeModuleKeys(data.orgEnabledModules),
          onboardingCompleted: data.onboardingCompleted !== false,
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
          allowedModules: ["inventory", "usage"],
          orgAvailableModules: [],
          orgEnabledModules: [],
          onboardingCompleted: true,
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
    if (authStatus !== "authenticated" || !userViewScope) {
      setView("dashboard");
      return;
    }
    try {
      const saved = window.localStorage.getItem(scopedViewStorageKey);
      setView(isAppView(saved) ? saved : "dashboard");
    } catch {
      setView("dashboard");
    }
  }, [authStatus, scopedViewStorageKey, userViewScope]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !userViewScope) return;
    try {
      window.localStorage.setItem(scopedViewStorageKey, view);
    } catch {
      // No-op: storage may be unavailable in private mode or locked environments.
    }
  }, [authStatus, scopedViewStorageKey, userViewScope, view]);

  useEffect(() => {
    applyThemePreference(themePreference);
    saveThemePreference(themePreference);
  }, [themePreference]);


  useEffect(() => {
    if (authStatus !== "authenticated") {
      setCurrentUserEmail("");
      return;
    }
    const derived = String(user?.attributes?.email ?? user?.signInDetails?.loginId ?? "");
    if (derived) {
      setCurrentUserEmail(derived);
    }
  }, [authStatus, user?.attributes?.email, user?.signInDetails?.loginId]);

  useEffect(() => {
    const detailsMenuSelector = [
      "details.app-module-menu[open]",
      "details.inventory-import-menu[open]",
      "details.inventory-columns-menu[open]",
      "details.inventory-location-menu[open]",
      "details.inventory-move-menu[open]",
    ].join(", ");

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const openMenus = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(detailsMenuSelector),
      );
      for (const menu of openMenus) {
        if (!target || !menu.contains(target)) {
          menu.removeAttribute("open");
        }
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openMenus = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(detailsMenuSelector),
      );
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
      setLoadingLine(pickAppLine());
    }, 2200);
    return () => window.clearInterval(interval);
  }, [authStatus, subState.status, subState.loadError]);

  useEffect(() => {
    if (view === "inventory" && !subState.allowedModules.includes("inventory")) {
      setView("dashboard");
      return;
    }
    if (view === "usage" && !subState.allowedModules.includes("usage")) {
      setView("dashboard");
    }
    if (view === "quickadd" && !subState.allowedModules.includes("inventory")) {
      setView("dashboard");
    }
  }, [view, subState.allowedModules]);

  if (authStatus === "configuring" || (subState.status === "loading" && !subState.loadError)) {
    return (
      <div className="app-loading-fullscreen">
        <span className="app-spinner" aria-hidden="true" />
        <span>{loadingLine}</span>
      </div>
    );
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

  const derivedUserEmail = String(user?.attributes?.email ?? user?.signInDetails?.loginId ?? "");

  if (subState.status === "unsubscribed" || subState.accessSuspended) {
    return <SubscriptionPage />;
  }

  const isOrgOwner = ["OWNER", "ACCOUNT_OWNER"].includes(subState.role);
  if (subState.status === "subscribed" && !subState.onboardingCompleted && isOrgOwner) {
    return (
      <OnboardingPage
        orgName={subState.orgName}
        onComplete={() => setSubState((prev) => ({ ...prev, onboardingCompleted: true }))}
      />
    );
  }

  const userEmail = currentUserEmail || derivedUserEmail;
  const userName =
    subState.displayName.trim() ||
    user?.attributes?.name?.trim() ||
    user?.attributes?.preferred_username?.trim() ||
    userEmail ||
    "User";
  const seatsRemaining = subState.seatLimit - subState.seatsUsed;
  const canInviteMore = subState.canInviteUsers && seatsRemaining > 0;
  const canAccessInventory = subState.allowedModules.includes("inventory");
  const canAccessUsage = subState.allowedModules.includes("usage");
  const canEditInventory = ["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"].includes(subState.role);
  const canManageInventoryColumns = ["ADMIN", "OWNER", "ACCOUNT_OWNER"].includes(subState.role);
  const canManageModuleAccess = ["ADMIN", "OWNER", "ACCOUNT_OWNER"].includes(subState.role);
  const canReviewUsageSubmissions = canEditInventory && canAccessUsage;

  let content: JSX.Element;
  if (view === "settings") {
    content = (
      <SettingsPage
        currentDisplayName={subState.displayName}
        currentUserEmail={String(userEmail)}
        canInviteMore={canInviteMore}
        seatsRemaining={seatsRemaining}
        seatLimit={subState.seatLimit}
        seatsUsed={subState.seatsUsed}
        canManageInventoryColumns={canManageInventoryColumns}
        themePreference={themePreference}
        onThemePreferenceChange={setThemePreference}
        onCurrentUserAllowedModulesChange={(allowedModules) =>
          setSubState((prev) => ({ ...prev, allowedModules }))
        }
        onCurrentUserDisplayNameChange={(displayName) =>
          setSubState((prev) => ({ ...prev, displayName }))
        }
        onCurrentUserEmailChange={(email) => setCurrentUserEmail(email)}
        onUserRevoked={(_userId, newSeatsUsed) =>
          setSubState((prev) => ({ ...prev, seatsUsed: newSeatsUsed }))
        }
        canManageModuleAccess={canManageModuleAccess}
        currentUserId={String(user?.attributes?.sub ?? "")}
        onInviteUsers={() => {
          if (!canInviteMore) return;
          setView("invite");
        }}
        userName={userName}
        onLogout={signOut}
      />
    );
  } else if (view === "inventory") {
    content = canAccessInventory ? (
      <InventoryPage
        key={inventoryKey}
        canEditInventory={canEditInventory}
        canManageInventoryColumns={canManageInventoryColumns}
        canReviewSubmissions={canReviewUsageSubmissions}
        initialFilter={inventoryInitialFilter}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
      />
    ) : (
      <DashboardPage
        accessibleModules={subState.allowedModules}
        canEditInventory={canEditInventory}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
        onNavigate={(v) => setView(v)}
      />
    );
  } else if (view === "usage") {
    content = canAccessUsage ? (
      <InventoryUsagePage selectedLocation={selectedLocation} />
    ) : (
      <DashboardPage
        accessibleModules={subState.allowedModules}
        canEditInventory={canEditInventory}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
        onNavigate={(v) => setView(v)}
      />
    );
  } else if (view === "quickadd") {
    content = canAccessInventory && canEditInventory ? (
      <QuickAddPage selectedLocation={selectedLocation} />
    ) : (
      <DashboardPage
        accessibleModules={subState.allowedModules}
        canEditInventory={canEditInventory}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
        onNavigate={(v) => setView(v)}
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
        accessibleModules={subState.allowedModules}
        canEditInventory={canEditInventory}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
        onNavigate={(v) => setView(v)}
      />
    );
  } else {
    content = (
      <DashboardPage
        accessibleModules={subState.allowedModules}
        canEditInventory={canEditInventory}
        selectedLocation={selectedLocation}
        onLocationChange={onLocationChange}
        onNavigate={(v) => setView(v)}
        onNavigateToInventoryWithFilter={(filter, location) => {
          if (location !== undefined) onLocationChange(location);
          setInventoryInitialFilter(filter);
          setInventoryKey((k) => k + 1);
          setView("inventory");
        }}
      />
    );
  }

  const isInventorySection = view === "inventory" || view === "usage" || view === "quickadd";

  return (
    <section className={`app-shell${isMobile && !keyboardOpen ? " app-shell--mobile" : ""}`}>
      <AppToolbar
        view={view}
        onNavigate={(v) => setView(v)}
      />
      {isInventorySection && (
        <InventorySubNav
          activeView={view}
          accessibleModules={subState.allowedModules}
          onNavigate={(v) => setView(v)}
        />
      )}
      {content}
      {isMobile && !keyboardOpen && (
        <nav className="app-bottom-bar" aria-label="Main navigation">
          <button
            type="button"
            className={`app-bottom-bar-item${view === "dashboard" ? " active" : ""}`}
            onClick={() => setView("dashboard")}
          >
            <LayoutDashboard size={20} />
            <span>Dashboard</span>
          </button>
          <button
            type="button"
            className={`app-bottom-bar-item${view === "settings" || view === "invite" ? " active" : ""}`}
            onClick={() => setView("settings")}
          >
            <SettingsIcon size={20} />
            <span>Settings</span>
          </button>
        </nav>
      )}
    </section>
  );
}
