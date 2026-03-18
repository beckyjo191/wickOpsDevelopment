import "./LandingPage.css";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";
import { PLAN_REGISTRY } from "../lib/planRegistry";
import { Search, Zap, Shield } from "lucide-react";

export function LandingPage() {
  return (
    <div className="lp-page">
      <header className="lp-nav">
        <a className="lp-brand" href="/">
          <img className="lp-brand-mark-image" src={logoThumb} alt="WickOps mark" />
          <span className="lp-brand-word">WickOps</span>
        </a>
        <nav className="lp-nav-actions">
          <a className="lp-link" href="/app">Log In</a>
          <a className="lp-button lp-button-primary" href="/signup">Sign Up</a>
        </nav>
      </header>

      <main className="lp-main">
        <section className="lp-hero">
          <p className="lp-kicker">Practical systems for busy people.</p>
          <h1>Know what you have.<br />Reorder in two clicks.</h1>
          <p className="lp-sub">
            From homes to field teams, WickOps tracks inventory, supplies, and operational gear
            so you spend less time searching and more time doing.
          </p>
          <div className="lp-cta-row">
            <a className="lp-button lp-button-primary" href="/signup">Get Started</a>
          </div>
        </section>

        <section className="lp-pillars" aria-label="Core value">
          <article>
            <div className="lp-pillar-icon"><Search size={24} strokeWidth={1.5} /></div>
            <h2>Less Searching, More Doing</h2>
            <p>Know what is on hand before anyone opens another cabinet, truck bin, or closet.</p>
          </article>
          <article>
            <div className="lp-pillar-icon"><Zap size={24} strokeWidth={1.5} /></div>
            <h2>Fast Reorder Actions</h2>
            <p>With a couple of clicks, reorder what matters and keep supplies ready.</p>
          </article>
          <article>
            <div className="lp-pillar-icon"><Shield size={24} strokeWidth={1.5} /></div>
            <h2>Built Around Your Life</h2>
            <p>You are the priority. WickOps moves operational load off your plate.</p>
          </article>
        </section>

        {/* Pricing overview — driven from PLAN_REGISTRY so it stays in sync */}
        <section className="lp-pricing" aria-label="Pricing overview">
          <h2 className="lp-pricing-heading">Simple, transparent pricing</h2>
          <div className="lp-pricing-grid">
            {PLAN_REGISTRY.map((plan) => (
              <article
                key={plan.key}
                className={`lp-pricing-card${plan.highlight ? " lp-pricing-card-highlight" : ""}`}
              >
                {plan.highlight && (
                  <div className="lp-pricing-badge">Most Popular</div>
                )}
                <div className="lp-pricing-name">{plan.name}</div>
                <div className="lp-pricing-price">
                  <span className="lp-pricing-amount">${plan.monthlyPrice}</span>
                  <span className="lp-pricing-period">/mo</span>
                </div>
                <div className="lp-pricing-seats">
                  {plan.maxUsers === 1 ? "1 user" : `Up to ${plan.maxUsers} users`}
                </div>
                <p className="lp-pricing-desc">{plan.description}</p>
                <a className="lp-button lp-button-secondary lp-pricing-cta" href="/signup">
                  Get Started
                </a>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-use-cases" aria-label="Who uses WickOps">
          <h2 className="lp-section-heading">Built for real operations</h2>
          <div className="lp-use-cases-grid">
            <article>
              <h3>Home & Family</h3>
              <p>Track pantry items while kids submit quick forms from a phone or iPad.</p>
            </article>
            <article>
              <h3>Service Businesses</h3>
              <p>Plumbing and field teams track parts, job stock, and usage in one place.</p>
            </article>
            <article>
              <h3>Supply-Critical Teams</h3>
              <p>Manage gear, medical supplies, and checklists without spreadsheet chaos.</p>
            </article>
          </div>
        </section>

        <section className="lp-modules" aria-label="Module flexibility">
          <h2>Use as many modules as you need, or as few as you want.</h2>
          <div className="lp-module-tags">
            <span>Inventory & Reorder</span>
            <span>Gear Tracking</span>
            <span>Truck Checks</span>
            <span>Mobile Forms</span>
            <span>Expense Tracking (MoM / YoY)</span>
            <span>Custom Workflows</span>
          </div>
          <p>Built for real life operations.</p>
        </section>

      </main>
    </div>
  );
}
