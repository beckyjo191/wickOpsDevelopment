// src/components/SubscriptionPage.tsx
import { useAuthenticator } from "@aws-amplify/ui-react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

interface SubscriptionPageProps {
  userEmail: string; // email of the logged-in user (admin)
}

export default function SubscriptionPage({ userEmail }: SubscriptionPageProps) {
  const { signOut } = useAuthenticator();

  const startCheckout = async () => {
    if (!userEmail) return alert("You must be logged in to start checkout");

    try {
      const res = await fetch(`${API_BASE_URL}/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: userEmail }), // orgId = email of first user/admin
      });

      const data = await res.json();
      if (!data.url) return alert("Failed to create checkout session");

      // Redirect to Stripe checkout
      window.location.href = data.url;
    } catch (err) {
      console.error("Checkout error:", err);
      alert("Checkout failed. See console for details.");
    }
  };

  return (
    <div style={{ padding: 32 }}>
      <h2>Subscription Required</h2>
      <p>Your organization does not have an active subscription. Please pay to continue.</p>
      <button type="button" onClick={startCheckout}>Continue to Checkout</button>
      <br /><br />
      <button type="button" onClick={signOut}>Sign Out</button>
    </div>
  );
}
