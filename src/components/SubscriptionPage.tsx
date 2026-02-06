import { useAuthenticator } from "@aws-amplify/ui-react";
import { authFetch } from "../lib/authFetch";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function SubscriptionPage() {
  const { signOut } = useAuthenticator() as { signOut: () => void };

  const startCheckout = async () => {
    try {
      const res = await authFetch(`${API_BASE_URL}/create-checkout-session`, {
        method: "POST",
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Checkout failed");
      }

      const data = await res.json();

      if (!data.url) {
        throw new Error("No checkout URL returned");
      }

      window.location.href = data.url;
    } catch (err: any) {
      console.error("Checkout error:", err);
      alert(`Checkout failed: ${err.message}`);
    }
  };

  return (
    <div style={{ padding: 32 }}>
      <h2>Subscription Required</h2>
      <p>
        Your organization does not have an active subscription.
        Please subscribe to continue.
      </p>

      <button onClick={startCheckout}>
        Continue to Checkout
      </button>

      <br />
      <br />

      <button type="button" onClick={signOut}>Sign Out</button>
    </div>
  );
}