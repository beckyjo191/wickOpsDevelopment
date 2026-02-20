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
          <p className="lp-kicker">Practical systems for busy people.</p>
          <h1>WickOps builds organization systems that give you your time back.</h1>
          <p className="lp-sub">
            Spend less time digging through cabinets, pantry shelves, and supply bins. From homes to field teams,
            WickOps helps you track what you have, what you need, and what to reorder in a few clicks.
          </p>
          <div className="lp-cta-row">
            <a className="lp-button lp-button-primary" href="/signup">Create Account</a>
            <a className="lp-button lp-button-secondary" href="/app">Go To Existing Account</a>
          </div>
          <p className="lp-signup-note">
            Organization sign-up includes up to <strong>5 users</strong>. Other sign-ups are
            <strong> personal</strong> accounts.
          </p>
        </section>

        <section className="lp-pillars" aria-label="Core value">
          <article>
            <h2>Less Searching, More Doing</h2>
            <p>Know what is on hand before anyone opens another cabinet, truck bin, or closet.</p>
          </article>
          <article>
            <h2>Fast Reorder Actions</h2>
            <p>With a couple of clicks, reorder what matters and keep supplies ready.</p>
          </article>
          <article>
            <h2>Built Around Your Life</h2>
            <p>At WickOps, you are the priority. We move operational load off your plate.</p>
          </article>
        </section>

        <section className="lp-use-cases" aria-label="Who uses WickOps">
          <article>
            <h2>Home & Family</h2>
            <p>Parents can track pantry items while kids submit quick forms from a phone or iPad.</p>
          </article>
          <article>
            <h2>Service Businesses</h2>
            <p>Plumbing and field teams can track parts, job stock, and usage in one place.</p>
          </article>
          <article>
            <h2>Supply-Critical Teams</h2>
            <p>Manage gear, medical supplies, and operational checklists without spreadsheet chaos.</p>
          </article>
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
