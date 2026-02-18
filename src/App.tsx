import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";
import { InventoryPage } from "./components/InventoryPage";
import { SettingsPage } from "./components/SettingsPage";
import { DashboardPage } from "./components/DashboardPage";
import { AppToolbar } from "./components/AppToolbar";
import { authFetch } from "./lib/authFetch";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVITES_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVITES_API_BASE_URL);

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator() as any;
  const [view, setView] = useState<"dashboard" | "inventory" | "invite" | "settings">("dashboard");

  const [subState, setSubState] = useState<{
    status: SubscriptionState;
    seatLimit: number;
    seatsUsed: number;
    accessSuspended: boolean;
    canInviteUsers: boolean;
    role: string;
    loadError: boolean;
  }>({
    status: "loading",
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

    const checkSubscription = async () => {
      try {
        const res = await authFetch(`${API_BASE_URL}/user-subscription`);
        if (!res.ok) throw new Error("Subscription check failed");

        const data = await res.json();

        const status =
          data.subscribed && !data.accessSuspended
            ? "subscribed"
            : "unsubscribed";

        setSubState({
          status,
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
        setSubState({
          status: "loading",
          seatLimit: 1,
          seatsUsed: 0,
          accessSuspended: false,
          canInviteUsers: false,
          role: "",
          loadError: true,
        });
      }
    };

    checkSubscription();

    if (window.location.pathname === "/success") {
      pollInterval = window.setInterval(checkSubscription, 3000);
      setTimeout(() => {
        if (pollInterval) clearInterval(pollInterval);
      }, 30000);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [authStatus]);

  if (authStatus === "configuring" || (subState.status === "loading" && !subState.loadError)) {
    return <div>Loading...</div>;
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
    user?.attributes?.name?.trim() ||
    user?.attributes?.preferred_username?.trim() ||
    userEmail ||
    "User";
  const seatsRemaining = subState.seatLimit - subState.seatsUsed;
  const canInviteMore = subState.canInviteUsers && seatsRemaining > 0;
  const canEditInventory = ["ADMIN", "OWNER", "ACCOUNT_OWNER", "EDITOR"].includes(subState.role);
  const canManageInventoryColumns = ["ADMIN", "OWNER", "ACCOUNT_OWNER"].includes(subState.role);

  let content: JSX.Element;
  if (view === "settings") {
    content = (
      <SettingsPage
        canInviteMore={canInviteMore}
        canManageInventoryColumns={canManageInventoryColumns}
        onInviteUsers={() => {
          if (!canInviteMore) return;
          setView("invite");
        }}
        onBack={() => setView("dashboard")}
      />
    );
  } else if (view === "inventory") {
    content = <InventoryPage canEditInventory={canEditInventory} />;
  } else if (view === "invite") {
    content = canInviteMore ? (
      <InviteUsersPage
        maxUsers={subState.seatLimit}  // total seats
        seatsUsed={subState.seatsUsed} // seats already used
        onBackToDashboard={() => {
          setView("dashboard");
        }}
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
        onGoToDashboard={() => setView("dashboard")}
        onOpenSettings={() => setView("settings")}
        onLogout={signOut}
      />
      {content}
    </section>
  );
}
