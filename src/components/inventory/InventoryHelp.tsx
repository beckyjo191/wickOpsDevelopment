import { HelpModal } from "../shared/HelpModal";
import type { ActiveTab } from "./inventoryTypes";

type HelpSection = {
  title: string;
  body: React.ReactNode;
};

function getHelpForTab(activeTab: ActiveTab, canEditInventory: boolean): HelpSection {
  switch (activeTab) {
    case "expired":
      return {
        title: "Expired",
        body: (
          <>
            <p>
              Rows past their <strong>Expiration Date</strong>. Expired stock
              still counts as on-hand until you retire it — so an expired item
              lives here, not in Low Stock. <strong>Retiring</strong> it zeroes
              that lot, which is what can drop the item below its min and move
              it into Low Stock.
            </p>
            <ul>
              <li>
                <strong>Retire All Expired</strong> (top of the list) clears
                every expired row in this scope in one click — recorded as
                expired loss.
              </li>
              <li>
                Use the per-row <strong>Remove</strong> button (or
                <strong> Remove (N)</strong> in the toolbar after selecting)
                to handle individual rows. The dialog asks what happened —
                "Expired" is pre-selected on this tab.
              </li>
              <li>
                Adjust the date in the <strong>Expiration Date</strong> cell
                if a row is here by mistake.
              </li>
            </ul>
          </>
        ),
      };

    case "exp30":
    case "exp60":
      return {
        title: "Expiring Soon",
        body: (
          <>
            <p>
              Rows whose <strong>Expiration Date</strong> falls inside the
              warning window — they still count as on-hand, but you'll want
              to replace or use them before they expire.
            </p>
            <ul>
              <li>
                Sort by <strong>Expiration Date</strong> to see what goes
                first.
              </li>
              <li>
                Once an item passes its date it moves to the
                <strong> Expired</strong> tab.
              </li>
            </ul>
          </>
        ),
      };

    case "lowStock":
      return {
        title: "Low Stock",
        body: (
          <>
            <p>
              On-hand quantity is at or below <strong>Min Quantity</strong>.
              These are the items that populate the Reorder list in the
              <strong> Orders</strong> tab.
            </p>
            <ul>
              <li>
                <strong>Min Quantity</strong> is set per item. When the same
                item has multiple lots, the highest min wins — the threshold
                is the same across all lots of that item.
              </li>
              <li>
                On-hand is summed across all lots. Expired stock still counts
                while it's on the shelf, so an expired item stays in the
                Expired tab — not here. Retire it and, if you're then below
                min, it shows up as Low Stock.
              </li>
              <li>
                Paste a vendor URL into <strong>Reorder Link</strong> so
                anyone can jump straight to the buy page.
              </li>
            </ul>
          </>
        ),
      };

    case "logUsage":
      return {
        title: "Log Usage",
        body: (
          <>
            <p>
              Record items used (e.g. on a call or job) so quantities stay
              accurate without hand-editing rows.
            </p>
            <ul>
              <li>
                Search for an item, set how many were used, and submit.
                When the same item has multiple lots, each appears
                separately in the dropdown with its quantity and expiration
                date — pick the lot you're drawing from (usually the
                soonest to expire).
              </li>
              <li>
                Add an optional <strong>note</strong> per line (job, room,
                reason). When inventory spans multiple locations, use
                <strong> + Add Location</strong> to log usage from another
                location in the same submission.
              </li>
              <li>
                Usage is recorded in Activity, so you can see who used what
                and when.
                {canEditInventory ? (
                  <> Each row has an <strong>Undo</strong> button if you
                    logged something by mistake.</>
                ) : (
                  <> Submissions can only be reversed by editors and admins,
                    so flag mistakes to one of them.</>
                )}
              </li>
              <li>
                For brand-new stock arriving, use
                <strong> Orders → Receive</strong> instead of Log Usage.
              </li>
            </ul>
          </>
        ),
      };

    case "all":
    default:
      return {
        title: "Inventory",
        body: (
          <>
            <p className="help-modal-lead">
              Each row is a single lot — same item across multiple lots
              (different expirations or vendors) gets its own row.
            </p>
            <h4>Locations</h4>
            <p>
              The dropdown at the top scopes the table to one location (e.g.
              <strong> EMS Cabinet</strong>) or
              <strong> All Locations</strong>. Use
              <strong> + Add Location</strong> at the bottom of the dropdown
              to create a new one. Select rows and use
              <strong> Move to…</strong> to relocate them.
            </p>
            <h4>Columns</h4>
            <ul>
              <li>
                <strong>Reorder Link</strong> — vendor URL for this item.
                Click the link to jump straight to reorder.
              </li>
              <li><strong>Item Name</strong> — what's on the shelf.</li>
              <li>
                <strong>Quantity</strong> — on-hand for this lot. Expired
                lots don't count toward on-hand totals.
              </li>
              <li>
                <strong>Min Quantity</strong> — reorder threshold. When the
                same item has multiple lots, the highest min wins.
              </li>
              <li>
                <strong>Expiration Date</strong> — used to flag Expired and
                Expiring Soon. Leave blank for items that don't expire.
              </li>
            </ul>
            <h4>Editing</h4>
            <ul>
              <li>
                <strong>+ Add Row</strong> inserts at the top. With a row
                selected, the chevron menu lets you add
                <strong> Above</strong> or <strong>Below</strong> the
                selection.
              </li>
              <li>
                Click any cell to edit inline. Changes batch up — a
                <strong> Save</strong> bar appears at the bottom.
              </li>
              <li>
                Use the row checkboxes for bulk
                <strong> Move to…</strong> or <strong> Remove</strong>. The
                Remove dialog asks what happened (expired, damaged, lost,
                recalled, no longer carrying it, or "created by mistake")
                and records the right loss event so analytics stay accurate.
              </li>
            </ul>
            <p>
              The other tabs (<strong>Expired</strong>,
              <strong> Expiring Soon</strong>, <strong>Low Stock</strong>)
              filter this same data — open this help while on one of those
              tabs for details.
            </p>
          </>
        ),
      };
  }
}

export function InventoryHelp({
  activeTab,
  canEditInventory = false,
}: {
  activeTab: ActiveTab;
  /** Whether the current user can use Activity-feed Undo. The Log Usage
   *  section's copy mentions Undo only when this is true; viewers see a note
   *  pointing them to an editor/admin instead. */
  canEditInventory?: boolean;
}) {
  const section = getHelpForTab(activeTab, canEditInventory);
  return (
    <HelpModal key={activeTab} title={section.title}>
      {section.body}
    </HelpModal>
  );
}
