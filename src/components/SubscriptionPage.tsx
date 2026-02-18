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
    <section className="app-page">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Subscription Required</h2>
            <p className="app-subtitle">
              Your organization does not have an active plan yet.
            </p>
          </div>
        </header>

        <div className="status-panel">
          Subscribe to continue using team features like user management and organization inventory.
        </div>

        <div className="app-actions">
          <button className="button button-primary" onClick={startCheckout}>
            Continue to Checkout
          </button>
          <button className="button button-ghost" type="button" onClick={signOut}>
            Sign Out
          </button>
        </div>
      </div>
    </section>
  );
}
