import "./LandingPage.css";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";
import logoOriginal from "../assets/brand/wickops-logo-original.svg";

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
          <img className="lp-hero-logo" src={logoOriginal} alt="WickOps Systems" />
          <p className="lp-kicker">Built for operational teams</p>
          <h1>WickOps helps departments and small businesses run equipment, users, and workflows in one place.</h1>
          <p className="lp-sub">
            From fire departments to field service teams, WickOps gives organizations a simple system to manage access,
            track inventory, and keep operations moving.
          </p>
          <div className="lp-cta-row">
            <a className="lp-button lp-button-primary" href="/signup">Create Organization Account</a>
            <a className="lp-button lp-button-secondary" href="/app">Go To Existing Account</a>
          </div>
        </section>

        <section className="lp-pillars" aria-label="Core value">
          <article>
            <h2>Role-Based Access</h2>
            <p>Clear permissions for View Only, Editor, and Administrator users.</p>
          </article>
          <article>
            <h2>Operational Clarity</h2>
            <p>Single place for subscriptions, team onboarding, and inventory operations.</p>
          </article>
          <article>
            <h2>Organization-Ready</h2>
            <p>Designed for real teams, real workflows, and field-first operations.</p>
          </article>
        </section>

      </main>
    </div>
  );
}
