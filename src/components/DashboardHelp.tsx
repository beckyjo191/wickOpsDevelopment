import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";

export function DashboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="orders-help-btn"
        onClick={() => setOpen(true)}
        aria-label="Dashboard help"
        title="Dashboard help"
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
            aria-labelledby="dashboard-help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="orders-help-modal-header">
              <h3 id="dashboard-help-title">Dashboard</h3>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="orders-help-modal-body">
              <p className="orders-help-lead">
                A daily snapshot of what needs attention. Use the location
                dropdown (top-right of each card) to scope the numbers, or
                leave it on All Locations to see everything.
              </p>

              <h4>Expired items</h4>
              <p>
                Count of rows past their expiration date in the selected
                scope. Click <strong>View</strong> to jump to the Inventory
                tab pre-filtered to the Expired view, where you can retire
                them in one click.
              </p>

              <h4>Expiring soon</h4>
              <p>
                Items inside the warning window — still on-hand, but worth
                replacing before they expire. <strong>View</strong> opens
                the Expiring Soon filter in Inventory.
              </p>

              <h4>Low stock</h4>
              <p>
                Items at or below their <strong>Min Quantity</strong>.
                These are what populate the Reorder list.
                <strong> View</strong> jumps to the Low Stock filter.
              </p>

              <h4>Reorder items</h4>
              <p>
                Shortcut to the <strong>Orders → Reorder</strong> tab,
                where low-stock items are grouped by vendor for fast
                bulk-ordering.
              </p>

              <h4>Log Usage</h4>
              <p>
                Quick-access to the usage form — record what was used on
                a call/job so quantities stay accurate without
                hand-editing rows.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
