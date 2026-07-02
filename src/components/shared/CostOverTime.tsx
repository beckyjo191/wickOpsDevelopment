// ── Cost over time (shared) ─────────────────────────────────────────────────
// The single item price-history view. Fed from an item's audit events — the
// fullest source of "what did this cost over time," capturing manual price
// edits, order receipts, and usage-approve derivations. Rendered in two
// places from ONE implementation:
//   - Activity → item-history → "Cost over time" tab
//   - the vendor-pricing modal's "History" tab (embedded)
//
// Two lenses via an internal toggle:
//   - Blended — the item's effective unit cost over time (all sources), as a
//     small SVG line chart with min/max/current callouts.
//   - By vendor — per-vendor paid-price timeline (receipts only, since only
//     RESTOCK_RECEIVED events carry a vendor), newest first with the change
//     vs. the previous receipt so drift is obvious.

import { useState } from "react";
import type { AuditEvent } from "../../lib/inventoryApi";
import { formatCurrency } from "../../lib/currency";

/** One point on the blended effective-cost line. */
export type CostTimelinePoint = {
  timestamp: string;
  unitCost: number;
  source: "edit" | "create" | "restock-received" | "restock-added" | "usage-approve" | "vendor-edit";
};

const SOURCE_LABEL: Record<CostTimelinePoint["source"], string> = {
  "create": "Initial price",
  "edit": "Manual edit",
  "restock-received": "Order received",
  "restock-added": "Fast restock",
  "usage-approve": "Usage logged",
  "vendor-edit": "Price updated",
};

/** Walks an item's audit events chronologically to reconstruct its effective
 *  unit cost over time. Sources: ITEM_CREATE initial values, ITEM_EDIT changes
 *  to unitCost / packCost / packSize, and the stamped per-unit cost on
 *  RESTOCK_RECEIVED / RESTOCK_ADDED / USAGE_APPROVE events. Effective cost
 *  prefers packCost / packSize when both set, else unitCost. Consecutive
 *  same-cost points are deduped so a flat line doesn't sprout redundant
 *  vertices. */
export function extractCostTimeline(events: AuditEvent[]): CostTimelinePoint[] {
  let curUnitCost = 0;
  let curPackCost = 0;
  let curPackSize = 0;

  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const points: CostTimelinePoint[] = [];

  const recordPoint = (timestamp: string, source: CostTimelinePoint["source"]) => {
    const effective = curPackCost > 0 && curPackSize > 0
      ? curPackCost / curPackSize
      : curUnitCost;
    if (effective <= 0) return;
    const last = points[points.length - 1];
    if (last && Math.abs(last.unitCost - effective) < 0.0001) return;
    points.push({ timestamp, unitCost: effective, source });
  };

  for (const e of sorted) {
    const details = e.details ?? {};
    if (e.action === "ITEM_CREATE") {
      const snap = (details.initialValues ?? details.snapshot ?? {}) as Record<string, unknown>;
      const u = Number(snap.unitCost ?? 0);
      const pc = Number(snap.packCost ?? 0);
      const ps = Number(snap.packSize ?? 0);
      if (Number.isFinite(u) && u > 0) curUnitCost = u;
      if (Number.isFinite(pc) && pc > 0) curPackCost = pc;
      if (Number.isFinite(ps) && ps > 0) curPackSize = ps;
      recordPoint(e.timestamp, "create");
      continue;
    }
    if (e.action === "ITEM_EDIT") {
      const changes = Array.isArray(details.changes)
        ? (details.changes as Array<{ field: string; from: unknown; to: unknown }>)
        : [];
      let touched = false;
      for (const c of changes) {
        if (c.field === "unitCost") {
          const n = Number(c.to ?? 0);
          curUnitCost = Number.isFinite(n) && n >= 0 ? n : 0;
          touched = true;
        } else if (c.field === "packCost") {
          const n = Number(c.to ?? 0);
          curPackCost = Number.isFinite(n) && n >= 0 ? n : 0;
          touched = true;
        } else if (c.field === "packSize") {
          const n = Number(c.to ?? 0);
          curPackSize = Number.isFinite(n) && n >= 0 ? n : 0;
          touched = true;
        }
      }
      if (touched) recordPoint(e.timestamp, "edit");
      continue;
    }
    if (
      e.action === "RESTOCK_RECEIVED" || e.action === "RESTOCK_ADDED"
      || e.action === "USAGE_APPROVE" || e.action === "VENDOR_PRICE_EDIT"
    ) {
      const stamped = Number(details.unitCost ?? 0);
      if (Number.isFinite(stamped) && stamped > 0) {
        curUnitCost = stamped;
        // A stamped per-unit cost supersedes any stale packCost/packSize ratio.
        curPackCost = 0;
        curPackSize = 0;
        recordPoint(
          e.timestamp,
          e.action === "RESTOCK_RECEIVED" ? "restock-received"
            : e.action === "RESTOCK_ADDED" ? "restock-added"
              : e.action === "VENDOR_PRICE_EDIT" ? "vendor-edit"
                : "usage-approve",
        );
      }
    }
  }

  return points;
}

type VendorPricePoint = { timestamp: string; unitCost: number };

/** Per-vendor paid-price timeline. Only RESTOCK_RECEIVED events carry a vendor,
 *  so this reflects actual receipts (what you paid where), newest first. */
export function extractCostTimelineByVendor(
  events: AuditEvent[],
): Array<{ vendor: string; points: VendorPricePoint[] }> {
  const byVendor = new Map<string, { vendor: string; points: VendorPricePoint[] }>();
  for (const e of events) {
    // Both a receipt (what was paid) and a modal price edit (the current price
    // you set) carry a vendor + unit cost, so both are per-vendor price points.
    if (e.action !== "RESTOCK_RECEIVED" && e.action !== "VENDOR_PRICE_EDIT") continue;
    const details = e.details ?? {};
    const vendor = String(details.vendor ?? "").trim();
    const cost = Number(details.unitCost ?? 0);
    if (!vendor || !Number.isFinite(cost) || cost <= 0) continue;
    const key = vendor.toLowerCase();
    const g = byVendor.get(key) ?? { vendor, points: [] };
    g.points.push({ timestamp: e.timestamp, unitCost: cost });
    byVendor.set(key, g);
  }
  // Newest first within each vendor; vendors sorted by name.
  for (const g of byVendor.values()) {
    g.points.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  return Array.from(byVendor.values()).sort((a, b) =>
    a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" }),
  );
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** Blended effective-cost line chart (existing look). */
function BlendedChart({ points }: { points: CostTimelinePoint[] }) {
  const costs = points.map((p) => p.unitCost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const current = costs[costs.length - 1];
  const first = costs[0];
  const deltaPct = first > 0 ? ((current - first) / first) * 100 : 0;
  const span = maxCost - minCost;

  const W = 100;
  const H = 40;
  const xFor = (i: number) => points.length === 1 ? W / 2 : (i / (points.length - 1)) * W;
  const yFor = (cost: number) => span === 0 ? H / 2 : H - ((cost - minCost) / span) * H;
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(p.unitCost)}`)
    .join(" ");

  return (
    <div className="audit-cost-trend">
      <div className="audit-cost-trend-stats">
        <div className="audit-cost-trend-stat">
          <span className="audit-cost-trend-stat-label">Current</span>
          <span className="audit-cost-trend-stat-value">{formatCurrency(current)}</span>
        </div>
        <div className="audit-cost-trend-stat">
          <span className="audit-cost-trend-stat-label">Lowest</span>
          <span className="audit-cost-trend-stat-value">{formatCurrency(minCost)}</span>
        </div>
        <div className="audit-cost-trend-stat">
          <span className="audit-cost-trend-stat-label">Highest</span>
          <span className="audit-cost-trend-stat-value">{formatCurrency(maxCost)}</span>
        </div>
        {points.length > 1 ? (
          <div className="audit-cost-trend-stat">
            <span className="audit-cost-trend-stat-label">Change</span>
            <span
              className="audit-cost-trend-stat-value"
              style={{ color: deltaPct > 0 ? "var(--danger)" : deltaPct < 0 ? "var(--success)" : "var(--text)" }}
            >
              {deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(1)}%
            </span>
          </div>
        ) : null}
      </div>
      <svg className="audit-cost-trend-chart" viewBox={`-2 -2 ${W + 4} ${H + 4}`} preserveAspectRatio="none">
        {points.length > 1 ? (
          <path d={pathD} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ) : null}
        {points.map((p, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(p.unitCost)} r="1.5" fill="var(--primary)" vectorEffect="non-scaling-stroke">
            <title>
              {fmtDate(p.timestamp)}: {formatCurrency(p.unitCost)} ({SOURCE_LABEL[p.source]})
            </title>
          </circle>
        ))}
      </svg>
      <ol className="audit-cost-trend-points">
        {points.slice().reverse().map((p, i) => (
          <li key={`${p.timestamp}-${i}`} className="audit-cost-trend-point">
            <span className="audit-cost-trend-point-date">{fmtDate(p.timestamp)}</span>
            <span className="audit-cost-trend-point-cost">{formatCurrency(p.unitCost)}</span>
            <span className="audit-cost-trend-point-source">{SOURCE_LABEL[p.source]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Per-vendor paid-price list with change vs. the previous receipt. */
function ByVendorList({ groups }: { groups: Array<{ vendor: string; points: VendorPricePoint[] }> }) {
  if (groups.length === 0) {
    return (
      <p className="audit-empty">
        No receipts with a vendor yet. Receiving an order records the price paid
        per vendor here.
      </p>
    );
  }
  return (
    <div className="cost-vendor">
      {groups.map(({ vendor, points }) => (
        <div className="cost-vendor-group" key={vendor}>
          <h4 className="cost-vendor-name">{vendor}</h4>
          <ul className="cost-vendor-list">
            {points.map((p, i) => {
              const older = points[i + 1];
              const delta = older ? p.unitCost - older.unitCost : null;
              const changed = delta !== null && Math.abs(delta) >= 0.005;
              return (
                <li className="cost-vendor-point" key={`${p.timestamp}-${i}`}>
                  <span className="cost-vendor-date">{fmtDate(p.timestamp)}</span>
                  <span className="cost-vendor-price">{formatCurrency(p.unitCost)}</span>
                  {changed ? (
                    <span className={`cost-vendor-delta ${delta! > 0 ? "up" : "down"}`}>
                      {delta! > 0 ? "↑" : "↓"} {formatCurrency(Math.abs(delta!))}
                    </span>
                  ) : delta !== null ? (
                    <span className="cost-vendor-delta flat">no change</span>
                  ) : (
                    // Oldest/only observation for this vendor — nothing to
                    // compare against, so no delta chip.
                    <span className="cost-vendor-delta" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The unified item cost-over-time view. `events` is the item's audit history. */
export function CostOverTime({ events }: { events: AuditEvent[] }) {
  const [lens, setLens] = useState<"blended" | "vendor">("blended");
  const blended = extractCostTimeline(events);
  const byVendor = extractCostTimelineByVendor(events);

  if (blended.length === 0 && byVendor.length === 0) {
    return (
      <div className="audit-cost-trend audit-cost-trend--empty">
        <p className="audit-empty">
          No cost history yet. Set a Unit Cost (or Pack Cost + Pack Size) on this
          item, or receive an order with a price, and trend data will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="cost-over-time">
      <div className="cost-over-time-lens" role="tablist" aria-label="Cost view">
        <button
          type="button"
          role="tab"
          aria-selected={lens === "blended"}
          className={`button button-sm ${lens === "blended" ? "button-primary" : "button-ghost"}`}
          onClick={() => setLens("blended")}
        >
          Trend
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={lens === "vendor"}
          className={`button button-sm ${lens === "vendor" ? "button-primary" : "button-ghost"}`}
          onClick={() => setLens("vendor")}
        >
          By vendor
        </button>
      </div>
      {lens === "blended" ? <BlendedChart points={blended} /> : <ByVendorList groups={byVendor} />}
    </div>
  );
}
