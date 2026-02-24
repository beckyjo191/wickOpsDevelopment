// ─────────────────────────────────────────────────────────────────────────────
// planRegistry.ts
// Single source of truth for WickOps plan definitions and Stripe price IDs.
// To add a new plan tier: add one entry to PLAN_REGISTRY and add the
// corresponding VITE_STRIPE_PRICE_* env vars to both .env files.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanKey = "Personal" | "Department" | "Organization";

export type BillingPeriod = "monthly" | "yearly";

export type PlanDefinition = {
  key: PlanKey;
  name: string;
  monthlyPrice: number; // display only — Stripe is the billing source of truth
  annualPrice: number;  // display only
  maxUsers: number;     // -1 = unlimited
  description: string;
  highlight: boolean;   // show "Most Popular" badge on plan picker
  features: string[];
};

export const PLAN_REGISTRY: PlanDefinition[] = [
  {
    key: "Personal",
    name: "Personal",
    monthlyPrice: 75,
    annualPrice: 750,
    maxUsers: 1,
    description: "For solo contractors and individual technicians.",
    highlight: false,
    features: [
      "1 user",
      "Inventory tracking",
      "Usage form",
      "Custom columns",
      "CSV import",
    ],
  },
  {
    key: "Department",
    name: "Department",
    monthlyPrice: 175,
    annualPrice: 1750,
    maxUsers: 5,
    description: "For volunteer fire departments and small trade crews.",
    highlight: true,
    features: [
      "Up to 5 users",
      "Everything in Personal",
      "Team roles & permissions",
      "Module access control",
      "Email invitations",
      "Dedicated onboarding",
      "Ongoing priority support",
      "Extra seats available (+$15/seat)",
    ],
  },
  {
    key: "Organization",
    name: "Organization",
    monthlyPrice: 299,
    annualPrice: 2990,
    maxUsers: 15,
    description: "For larger departments and growing organizations.",
    highlight: false,
    features: [
      "Up to 15 users",
      "Everything in Department",
      "Future premium modules",
      "Extra seats available (+$15/seat)",
    ],
  },
];

/** Quick lookup by plan key */
export const PLAN_BY_KEY: Record<PlanKey, PlanDefinition> = Object.fromEntries(
  PLAN_REGISTRY.map((p) => [p.key, p]),
) as Record<PlanKey, PlanDefinition>;

/** Annual savings percentage vs monthly (rounded) */
export const ANNUAL_SAVINGS_PCT = 16; // ~2 months free
