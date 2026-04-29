import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import type { AuditTab } from "./AuditLogPage";

type HelpSection = {
  title: string;
  body: React.ReactNode;
};

function getHelpForTab(activeTab: AuditTab): HelpSection {
  switch (activeTab) {
    case "pending":
      return {
        title: "Pending",
        body: (
          <>
            <p>
              Usage submissions waiting for a reviewer to approve before
              quantities are deducted from inventory. Only users with
              review permission see this tab.
            </p>
            <ul>
              <li>
                <strong>Approve</strong> — applies the submission and
                decrements the matching lots. A
                <strong> USAGE_APPROVE</strong> event is written to the
                Activity feed for audit.
              </li>
              <li>
                <strong>Edit qty</strong> — adjust per-line quantities
                before approving (e.g. someone logged 3 but you can see
                only 2 were really used).
              </li>
              <li>
                <strong>Delete</strong> — reject the submission. Nothing
                is decremented; the submission is discarded.
              </li>
              <li>
                Submissions stay here until acted on, so check back if
                someone else won't.
              </li>
            </ul>
          </>
        ),
      };

    case "analytics":
      return {
        title: "Analytics",
        body: (
          <>
            <p>
              Trends over the last <strong>7 / 30 / 90 days</strong>.
              Use the period selector at the top of the tab to switch.
            </p>
            <ul>
              <li>
                <strong>Usage spend</strong> — value of items consumed
                via Log Usage, multiplied by their per-unit price.
              </li>
              <li>
                <strong>Loss by reason</strong> — retired quantity
                grouped by reason (expired, damaged, etc.). Useful for
                spotting where stock is leaking.
              </li>
              <li>
                <strong>Top items / vendors</strong> — what you use and
                buy most. Helpful when negotiating with vendors or
                deciding what to keep more of in stock.
              </li>
            </ul>
            <p>
              Numbers come from approved usage and closed orders — items
              still in Pending don't count yet.
            </p>
          </>
        ),
      };

    case "item-history":
      return {
        title: "Item history",
        body: (
          <>
            <p>
              Every event for a single item — adds, edits, usage,
              retires, vendor changes — in chronological order.
            </p>
            <ul>
              <li>
                <strong>Events</strong> tab shows the timeline.
                <strong> Cost</strong> tab shows price-per-unit history
                across receives.
              </li>
              <li>
                <strong>Open in Inventory</strong> jumps back to the
                Inventory tab with this item pre-filtered.
              </li>
              <li>
                Useful for "when did this last get reordered" or "who
                edited the min quantity last week" questions.
              </li>
            </ul>
          </>
        ),
      };

    case "feed":
    default:
      return {
        title: "Activity",
        body: (
          <>
            <p className="orders-help-lead">
              The audit feed — every change that happened across
              inventory, grouped by day. Newest first.
            </p>

            <h4>What gets logged</h4>
            <ul>
              <li>Inventory edits (qty, min, expiration, vendor, etc.)</li>
              <li>Rows added, deleted, moved between locations</li>
              <li>Usage submissions and approvals</li>
              <li>Order events (placed, received, cancelled)</li>
              <li>Column adds / removes / renames</li>
            </ul>

            <h4>Reading an entry</h4>
            <p>
              Each row shows the time, the item (clickable — jumps to
              its full <strong>Item history</strong>), what changed,
              and who did it. The colored bar on the left codes the
              event type at a glance.
            </p>

            <h4>Search</h4>
            <p>
              The search box matches against item name and user name
              across loaded events. For older history, hit
              <strong> Load More</strong> at the bottom and the search
              picks up the new events too.
            </p>

            <h4>Other tabs</h4>
            <p>
              <strong>Pending</strong> — usage submissions awaiting
              approval (reviewers only).
              <strong> Analytics</strong> — usage spend, loss reasons,
              and top items/vendors. Open this help while on either tab
              for details.
            </p>
          </>
        ),
      };
  }
}

export function ActivityHelp({ activeTab }: { activeTab: AuditTab }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const section = getHelpForTab(activeTab);
  const labelText = `${section.title} help`;

  return (
    <>
      <button
        type="button"
        className="orders-help-btn"
        onClick={() => setOpen(true)}
        aria-label={labelText}
        title={labelText}
      >
        <HelpCircle size={16} />
      </button>
      {open && (
        <div
          className="orders-help-overlay"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="orders-help-modal app-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="orders-help-modal-header">
              <h3 id="activity-help-title">{section.title}</h3>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="orders-help-modal-body">{section.body}</div>
          </div>
        </div>
      )}
    </>
  );
}
