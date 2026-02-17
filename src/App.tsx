import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";
import { InventoryPage } from "./components/InventoryPage";
import { SettingsPage } from "./components/SettingsPage";
import { authFetch } from "./lib/authFetch";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const normalizeBaseUrl = (value?: string) => (value ?? "").replace(/\/+$/, "");
const INVITES_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_INVITES_API_BASE_URL);
const INVITE_STEP_COMPLETE_KEY = "wickops_invite_step_complete";

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator() as any;
  const [view, setView] = useState<"dashboard" | "invite" | "settings">("dashboard");
  const [inviteStepComplete, setInviteStepComplete] = useState<boolean>(() => {
    return localStorage.getItem(INVITE_STEP_COMPLETE_KEY) === "true";
  });

  const [subState, setSubState] = useState<{
    status: SubscriptionState;
    seatLimit: number;
    seatsUsed: number;
    accessSuspended: boolean;
    canInviteUsers: boolean;
    loadError: boolean;
  }>({
    status: "loading",
    seatLimit: 1,
    seatsUsed: 0,
    accessSuspended: false,
    canInviteUsers: false,
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
  const seatsRemaining = subState.seatLimit - subState.seatsUsed;
  const canInviteMore = subState.canInviteUsers && seatsRemaining > 0;

  if (view === "settings") {
    return (
      <SettingsPage
        userEmail={userEmail}
        onBack={() => setView("dashboard")}
      />
    );
  }

  if (view === "dashboard" && (inviteStepComplete || !canInviteMore)) {
    return (
      <InventoryPage
        canInviteMore={canInviteMore}
        onInviteMore={() => {
          localStorage.removeItem(INVITE_STEP_COMPLETE_KEY);
          setInviteStepComplete(false);
          setView("invite");
        }}
        onOpenSettings={() => setView("settings")}
      />
    );
  }

  // Only render InviteUsersPage if there are seats remaining
  if (!canInviteMore) {
    return (
      <InventoryPage
        canInviteMore={false}
        onInviteMore={() => {}}
        onOpenSettings={() => setView("settings")}
      />
    );
  }

  return (
    <InviteUsersPage
      signOut={signOut}
      maxUsers={subState.seatLimit}  // total seats
      seatsUsed={subState.seatsUsed} // seats already used
      userEmail={userEmail}
      onBackToDashboard={() => {
        localStorage.setItem(INVITE_STEP_COMPLETE_KEY, "true");
        setInviteStepComplete(true);
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

        localStorage.setItem(INVITE_STEP_COMPLETE_KEY, "true");
        setInviteStepComplete(true);
        setView("dashboard");
      }}
    />
  );
}
