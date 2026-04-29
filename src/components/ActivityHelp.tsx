import { HelpModal } from "./shared/HelpModal";
import type { AuditTab } from "./AuditLogPage";

type HelpSection = {
  title: string;
  body: React.ReactNode;
};

function getHelpForTab(activeTab: AuditTab): HelpSection {
  switch (activeTab) {
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
              Numbers come from logged usage and closed orders. Undone
              usage events are excluded automatically.
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
            <p className="help-modal-lead">
              The audit feed — every change that happened across
              inventory, grouped by day. Newest first.
            </p>

            <h4>What gets logged</h4>
            <ul>
              <li>Inventory edits (qty, min, expiration, vendor, etc.)</li>
              <li>Rows added, deleted, moved between locations</li>
              <li>Usage logged (and undone, if reversed)</li>
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

            <h4>Undo</h4>
            <p>
              Three event types can be reversed inline from this feed:
              <strong> usage</strong> (restores the decremented qty),
              <strong> retire</strong> (clears retire markers and restores
              the qty), and <strong>column delete</strong> (recreates the
              column — per-row values are preserved through the delete and
              reappear). Each leaves a matching <em>undone</em> event
              behind for the audit trail; already-undone events hide the
              button.
            </p>

            <h4>Search</h4>
            <p>
              The search box matches against item name and user name
              across loaded events. For older history, hit
              <strong> Load More</strong> at the bottom and the search
              picks up the new events too.
            </p>

            <h4>Analytics tab</h4>
            <p>
              <strong>Analytics</strong> — usage spend, loss reasons,
              and top items/vendors. Open this help while on that tab
              for details.
            </p>
          </>
        ),
      };
  }
}

export function ActivityHelp({ activeTab }: { activeTab: AuditTab }) {
  const section = getHelpForTab(activeTab);
  // Re-mounting on tab change ensures the modal's title + content stay in
  // sync if the user happens to swap tabs while the modal is open.
  return (
    <HelpModal key={activeTab} title={section.title}>
      {section.body}
    </HelpModal>
  );
}
