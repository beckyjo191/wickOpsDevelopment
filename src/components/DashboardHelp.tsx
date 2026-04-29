import { HelpModal } from "./shared/HelpModal";

export function DashboardHelp() {
  return (
    <HelpModal title="Dashboard">
      <p className="help-modal-lead">
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
    </HelpModal>
  );
}
