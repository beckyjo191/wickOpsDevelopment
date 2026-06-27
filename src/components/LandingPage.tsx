import "./LandingPage.css";
import { PLAN_REGISTRY } from "../lib/planRegistry";
import { Search, Mail, Globe, Check } from "lucide-react";

function GearBadge({ size = 38, radius = 11 }: { size?: number; radius?: number }) {
  const gear = Math.round(size * 0.63);
  return (
    <span
      className="lp-gear-badge"
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden="true"
    >
      <svg width={gear} height={gear} viewBox="0 0 100 100">
        <g fill="#2563EB">
          <circle cx="50" cy="50" r="33" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
            <polygon
              key={deg}
              points="41,18 44,5 56,5 59,18"
              transform={`rotate(${deg} 50 50)`}
            />
          ))}
        </g>
        <circle cx="50" cy="50" r="20" fill="#0A0F1E" />
      </svg>
    </span>
  );
}

export function LandingPage() {
  const year = new Date().getFullYear();

  return (
    <div className="lp-page">
      <header className="lp-nav" id="top">
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="#top">
            <GearBadge size={38} radius={11} />
            <span className="lp-brand-word">WickOps</span>
          </a>
          <nav className="lp-nav-links" aria-label="Primary">
            <a href="#product">Product</a>
            <a href="#who">Who it's for</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="lp-nav-cta">
            <a className="lp-nav-login" href="/app">Log In</a>
            <a className="lp-btn lp-btn-primary lp-btn-nav" href="/signup">Sign Up</a>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-in">
            <div className="lp-hero-copy">
              <p className="lp-kicker lp-kicker-onnavy">Practical systems for busy people</p>
              <h1>
                Know what you have.
                <br />
                Reorder in a few clicks.
              </h1>
              <p className="lp-hero-sub">
                WickOps tracks inventory and supplies for the people who keep things running — so
                you spend less time searching and more time doing.
              </p>
              <div className="lp-cta-row">
                <a className="lp-btn lp-btn-primary" href="/signup">Get Started</a>
                <a className="lp-btn lp-btn-ghost" href="#product">See how it works</a>
              </div>
              <p className="lp-hero-trust">
                No credit card to explore · Import your spreadsheet and go live in minutes
              </p>
            </div>
            <div className="lp-preview" aria-hidden="true">
              <div className="lp-pv-bar">
                <span className="lp-pv-dot" />
                <span className="lp-pv-dot" />
                <span className="lp-pv-dot" />
                <span className="lp-pv-title">Inventory — Station &amp; Trucks</span>
              </div>
              <div className="lp-pv-row lp-pv-head">
                <span>Item</span>
                <span>On hand</span>
                <span style={{ textAlign: "right" }}>Status</span>
              </div>
              {([
                { name: "Nitrile gloves (L)", loc: "Truck 2 · Bin A", qty: "240", tag: "ok", tagText: "In stock" },
                { name: "SCBA cylinders", loc: "Station · Rack 1", qty: "6", tag: "low", tagText: "Low" },
                { name: "Saline IV bags 1L", loc: "Med kit · Shelf 3", qty: "2", tag: "crit", tagText: "Critical" },
                { name: "Copper fittings ¾\"", loc: "Van 1 · Drawer 4", qty: "58", tag: "ok", tagText: "In stock" },
              ] as const).map((row) => (
                <div key={row.name} className="lp-pv-row">
                  <span>
                    <span className="lp-pv-name">{row.name}</span>
                    <br />
                    <span className="lp-pv-loc">{row.loc}</span>
                  </span>
                  <span className="lp-pv-qty">{row.qty}</span>
                  <span style={{ textAlign: "right" }}>
                    <span className={`lp-tag lp-tag-${row.tag}`}>{row.tagText}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-sec-head">
              <p className="lp-kicker">Why WickOps</p>
              <h2>Everything you have, finally in one place.</h2>
            </div>
            <div className="lp-pillars">
              <article className="lp-pillar">
                <div className="lp-pillar-ic"><Search size={26} strokeWidth={1.7} /></div>
                <h3>Less searching, more doing</h3>
                <p>Know what's on hand before anyone opens another cabinet, truck bin, or supply closet.</p>
              </article>
              <article className="lp-pillar">
                <div className="lp-pillar-ic"><Mail size={26} strokeWidth={1.7} /></div>
                <h3>The right person gets the email</h3>
                <p>When stock runs low, WickOps emails whoever's responsible — a chief, an office manager — not another app notification nobody sees.</p>
              </article>
              <article className="lp-pillar">
                <div className="lp-pillar-ic"><Globe size={26} strokeWidth={1.7} /></div>
                <h3>Works anywhere, nothing to install</h3>
                <p>Runs in any browser, on any device. No app store, no iOS-vs-Android clash, and it's always up to date.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="lp-section lp-product" id="product">
          <div className="lp-wrap">
            <div className="lp-prod-grid">
              <div>
                <p className="lp-kicker">The product</p>
                <h2 className="lp-prod-heading">
                  Everything on hand, at a glance — and ready to reorder.
                </h2>
                {[
                  { h: "Track every location", p: "Trucks, vans, stations, shelves — custom columns and reorder points that match what you actually keep." },
                  { h: "Low-stock, surfaced automatically", p: "WickOps watches your minimums and flags anything running low — no counting by hand." },
                  { h: "Reorder in a few clicks", p: "Review the auto-built shopping list, adjust quantities, and send it on its way." },
                  { h: "Compare prices across vendors", p: "Once you've placed a few orders, WickOps estimates your stock costs and compares prices across vendors — so you reorder for less." },
                  { h: "Bring your spreadsheet", p: "CSV & Excel import gets you running without rebuilding from scratch." },
                ].map((f) => (
                  <div key={f.h} className="lp-feat">
                    <span className="lp-feat-arrow" aria-hidden="true">→</span>
                    <div>
                      <h4>{f.h}</h4>
                      <p>{f.p}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="lp-preview lp-preview-shop" aria-hidden="true">
                <div className="lp-pv-bar">
                  <span className="lp-pv-dot" />
                  <span className="lp-pv-dot" />
                  <span className="lp-pv-dot" />
                  <span className="lp-pv-title">Shopping list — auto-built from low stock</span>
                </div>
                <div className="lp-pv-body">
                  {[
                    { name: "SCBA cylinders", loc: "Station · Rack 1", add: "+2" },
                    { name: "Saline IV bags 1L", loc: "Med kit · Shelf 3", add: "+10" },
                    { name: "Pump fuel — 2-cycle", loc: "Station · Cabinet 2", add: "+2" },
                  ].map((row, i, arr) => (
                    <div
                      key={row.name}
                      className="lp-pv-row"
                      style={i === arr.length - 1 ? { borderBottom: 0 } : undefined}
                    >
                      <span className="lp-pv-name">{row.name}</span>
                      <span className="lp-pv-loc">{row.loc}</span>
                      <span className="lp-pv-add">{row.add}</span>
                    </div>
                  ))}
                </div>
                <div className="lp-pv-foot">
                  <a className="lp-btn lp-btn-primary lp-btn-full" href="/signup">Reorder all →</a>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section" id="who">
          <div className="lp-wrap">
            <div className="lp-sec-head">
              <p className="lp-kicker">Who it's for</p>
              <h2>Teams that can't afford to run out.</h2>
              <p>
                If your supplies still live on a spreadsheet or a clipboard, WickOps is for you. Big
                inventory software is too complicated and too pricey for the teams that need it
                most — we pick up where the spreadsheet gives out.
              </p>
            </div>
            <div className="lp-uses">
              {[
                { h: "Volunteer fire & EMS", p: "Gear, SCBA, and medical supplies tracked and accountable — always ready for the call." },
                { h: "Trades & service crews", p: "Plumbing, electrical, and HVAC parts tracked across every truck and van." },
                { h: "Clinics & dental offices", p: "Consumables, PPE, and instruments — off the spreadsheet and never short before a patient." },
                { h: "Veterinary practices", p: "Medications, surgical supplies, and feed kept in stock across the whole practice." },
              ].map((u) => (
                <div key={u.h} className="lp-use">
                  <h3>{u.h}</h3>
                  <p>{u.p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-pricing-section" id="pricing">
          <div className="lp-wrap">
            <div className="lp-sec-head lp-pricing-head">
              <p className="lp-kicker">Pricing</p>
              <h2>Simple, transparent tiers.</h2>
              <p>Annual billing saves ~16%. Extra seats available at +$15/mo.</p>
            </div>
            <div className="lp-plans">
              {PLAN_REGISTRY.map((plan) => (
                <article
                  key={plan.key}
                  className={`lp-plan${plan.highlight ? " lp-plan-hot" : ""}`}
                >
                  {plan.highlight && <span className="lp-plan-pop">Most Popular</span>}
                  <h3>{plan.name}</h3>
                  <div className="lp-plan-price">
                    <span className="lp-plan-amt">${plan.monthlyPrice}</span>
                    <span className="lp-plan-per">/mo</span>
                  </div>
                  <p className="lp-plan-who">
                    {plan.maxUsers === 1 ? "1 user" : `Up to ${plan.maxUsers} users`} · {plan.description.replace(/^For\s/i, "")}
                  </p>
                  <ul className="lp-plan-features">
                    {plan.features.map((feat) => (
                      <li key={feat}>
                        <Check size={18} strokeWidth={2.5} />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                  <a
                    className={`lp-btn ${plan.highlight ? "lp-btn-primary" : "lp-btn-ghost-ink"} lp-btn-full`}
                    href="/signup"
                  >
                    Get Started
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-ctaband">
          <div className="lp-wrap">
            <h2>
              Less time searching.
              <br />
              More time doing.
            </h2>
            <p>
              Let's get your supplies in one place. Reach out for a walkthrough with your own
              inventory — every bit of feedback shapes what we build next.
            </p>
            <div className="lp-cta-row lp-cta-row-center">
              <a className="lp-btn lp-btn-primary" href="/signup">Get Started</a>
              <a className="lp-btn lp-btn-ghost" href="mailto:support@wickops.com">
                support@wickops.com
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-foot-in">
          <a className="lp-brand lp-brand-onnavy" href="#top">
            <GearBadge size={32} radius={9} />
            <span className="lp-brand-word">WickOps</span>
          </a>
          <span>© {year} Wired Wick Consulting LLC</span>
          <nav className="lp-foot-links" aria-label="Legal">
            <a href="/terms">Terms of Service</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/cookies">Cookie Policy</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
