import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";
import { InventoryPage } from "./components/InventoryPage";
import { authFetch } from "./lib/authFetch";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator() as any;

  const [subState, setSubState] = useState<{
    status: SubscriptionState;
    seatLimit: number;
    seatsUsed: number;
    accessSuspended: boolean;
  }>({
    status: "loading",
    seatLimit: 1,
    seatsUsed: 0,
    accessSuspended: false,
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
        });

        if (status === "subscribed" && pollInterval) {
          clearInterval(pollInterval);
        }
      } catch (err) {
        console.error("Subscription check error:", err);
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

  if (authStatus === "configuring" || subState.status === "loading") {
    return <div>Loading...</div>;
  }

  if (authStatus !== "authenticated" || !user) return null;

  if (subState.status === "unsubscribed" || subState.accessSuspended) {
    return <SubscriptionPage />;
  }

  // Only render InviteUsersPage if there are seats remaining
  const seatsRemaining = subState.seatLimit - subState.seatsUsed;
  if (seatsRemaining <= 0) {
    return <InventoryPage />;
  }

  return (
    <InviteUsersPage
      signOut={signOut}
      maxUsers={subState.seatLimit}  // total seats
      seatsUsed={subState.seatsUsed} // seats already used
      userEmail={
        user?.attributes?.email ?? user?.signInDetails?.loginId ?? ""
      }
    />
  );
}
