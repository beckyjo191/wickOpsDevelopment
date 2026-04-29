import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";
import type { ActiveTab } from "./inventoryTypes";

type HelpSection = {
  title: string;
  body: React.ReactNode;
};

function getHelpForTab(activeTab: ActiveTab): HelpSection {
  switch (activeTab) {
    case "expired":
      return {
        title: "Expired",
        body: (
          <>
            <p>
              Rows past their <strong>Expiration Date</strong>. Expired stock
              doesn't count toward on-hand totals — an item can show up here
              and still trigger Low Stock if the un-expired lots are below
              their min.
            </p>
            <ul>
              <li>
                <strong>Retire All Expired</strong> (top of the list) clears
                every expired row in this scope in one click. Retired rows
                move out of inventory and into the Activity log.
              </li>
              <li>
                Retire individual rows from the row's action menu if you only
                want to clear some.
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
                Expired stock doesn't count toward on-hand, so an item can
                show up as Low Stock even if there are expired units on the
                shelf.
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
                Search for an item, set how many were used, and submit. The
                matching lots decrement automatically — oldest expiration
                first.
              </li>
              <li>
                Usage is recorded in Activity, so you can see who used what
                and when. Each row has an <strong>Undo</strong> button if
                you logged something by mistake.
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
            <p className="orders-help-lead">
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
                <strong> Move to…</strong>. Blank rows can be discarded; rows
                with content are <strong>Retired</strong> instead so their
                history sticks around.
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

export function InventoryHelp({ activeTab }: { activeTab: ActiveTab }) {
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
            aria-labelledby="inventory-help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="orders-help-modal-header">
              <h3 id="inventory-help-title">{section.title}</h3>
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
