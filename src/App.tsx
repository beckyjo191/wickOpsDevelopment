import { useAuthenticator } from "@aws-amplify/ui-react";
import { useEffect, useState } from "react";
import SubscriptionPage from "./components/SubscriptionPage";
import { InviteUsersPage } from "./components/InviteUsersPage";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

type SubscriptionState = "loading" | "unsubscribed" | "subscribed";

export default function App() {
  const { user, authStatus, signOut } = useAuthenticator();

  const [subState, setSubState] = useState<{
    status: SubscriptionState;
    maxUsers: number;
    seatsUsed: number;
    accessSuspended: boolean;
  }>({
    status: "loading",
    maxUsers: 5,
    seatsUsed: 0,
    accessSuspended: false,
  });

  const email = user?.username ?? null;

  // 🔐 Always call hooks — no early returns above this point
  useEffect(() => {
    if (!email || authStatus !== "authenticated") return;

    const checkSubscription = async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/user-subscription?email=${encodeURIComponent(email)}`
        );

        if (!res.ok) throw new Error("Subscription check failed");

        const data = await res.json();

        setSubState({
          status:
            data.subscribed && !data.accessSuspended
              ? "subscribed"
              : "unsubscribed",
          maxUsers: data.maxUsers ?? 5,
          seatsUsed: data.seatsUsed ?? 0,
          accessSuspended: !!data.accessSuspended,
        });
      } catch (err) {
        console.error("Subscription check error:", err);
        setSubState({
          status: "unsubscribed",
          maxUsers: 5,
          seatsUsed: 0,
          accessSuspended: true,
        });
      }
    };

    checkSubscription();
  }, [email, authStatus]);

  // Conditional rendering AFTER hooks
  if (authStatus === "configuring" || subState.status === "loading") {
    return <div>Loading...</div>;
  }

  if (authStatus !== "authenticated" || !user) return null;

  // 🔒 Always enforce subscription and access
  if (subState.status === "unsubscribed" || subState.accessSuspended) {
    return <SubscriptionPage userEmail={email!} />;
  }

  return (
    <InviteUsersPage
      userEmail={email!}
      signOut={signOut}
      maxUsers={subState.maxUsers}
      seatsUsed={subState.seatsUsed}
    />
  );
}
