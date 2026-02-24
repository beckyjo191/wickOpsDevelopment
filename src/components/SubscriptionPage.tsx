import { useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { authFetch } from "../lib/authFetch";
import {
  PLAN_REGISTRY,
  ANNUAL_SAVINGS_PCT,
  type BillingPeriod,
  type PlanKey,
} from "../lib/planRegistry";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

export default function SubscriptionPage() {
  const { signOut } = useAuthenticator() as { signOut: () => void };
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("monthly");
  const [loadingPlan, setLoadingPlan] = useState<PlanKey | null>(null);

  const startCheckout = async (planKey: PlanKey) => {
    setLoadingPlan(planKey);
    try {
      const res = await authFetch(`${API_BASE_URL}/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey, billingPeriod }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Checkout failed");
      }

      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("No checkout URL returned");

      window.location.href = data.url;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Checkout error:", err);
      alert(`Checkout failed: ${message}`);
      setLoadingPlan(null);
    }
  };

  return (
    <section className="app-page">
      <div className="app-card plan-picker-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Choose Your Plan</h2>
            <p className="app-subtitle">
              Inventory and usage tracking built for teams. Every plan includes
              full access to all core modules.
            </p>
          </div>
        </header>

        {/* Billing period toggle */}
        <div className="plan-period-toggle">
          <button
            className={`plan-period-btn${billingPeriod === "monthly" ? " plan-period-btn-active" : ""}`}
            onClick={() => setBillingPeriod("monthly")}
            type="button"
          >
            Monthly
          </button>
          <button
            className={`plan-period-btn${billingPeriod === "yearly" ? " plan-period-btn-active" : ""}`}
            onClick={() => setBillingPeriod("yearly")}
            type="button"
          >
            Yearly
            <span className="plan-period-badge">Save {ANNUAL_SAVINGS_PCT}%</span>
          </button>
        </div>

        {/* Plan cards */}
        <div className="plan-cards">
          {PLAN_REGISTRY.map((plan) => {
            const price =
              billingPeriod === "monthly" ? plan.monthlyPrice : plan.annualPrice;
            const periodLabel = billingPeriod === "monthly" ? "/mo" : "/yr";
            const isLoading = loadingPlan === plan.key;
            const isDisabled = loadingPlan !== null;

            return (
              <div
                key={plan.key}
                className={`plan-card${plan.highlight ? " plan-card-highlight" : ""}`}
              >
                {plan.highlight && (
                  <div className="plan-card-badge">Most Popular</div>
                )}
                <div className="plan-card-name">{plan.name}</div>
                <div className="plan-card-price">
                  <span className="plan-card-price-amount">${price}</span>
                  <span className="plan-card-price-period">{periodLabel}</span>
                </div>
                <div className="plan-card-desc">{plan.description}</div>
                <ul className="plan-card-features">
                  {plan.features.map((feature) => (
                    <li key={feature} className="plan-card-feature">
                      <span className="plan-card-check" aria-hidden="true">
                        ✓
                      </span>
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className={`button ${plan.highlight ? "button-primary" : "button-secondary"} plan-card-cta`}
                  onClick={() => void startCheckout(plan.key)}
                  disabled={isDisabled}
                  type="button"
                >
                  {isLoading ? "Redirecting…" : "Choose Plan"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="app-actions" style={{ justifyContent: "center" }}>
          <button className="button button-ghost" type="button" onClick={signOut}>
            Sign Out
          </button>
        </div>
      </div>
    </section>
  );
}
