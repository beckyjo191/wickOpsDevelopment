import { ConfirmDialog } from "../shared/ConfirmDialog";

export type DeleteConfirmDialogProps = {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation dialog for deleting inventory rows. Delete is gated client-side
 * to rows with zero on-hand quantity; the server's delete guard rejects any row
 * that still has stock. Past audit events stay in the audit table even after
 * the row itself is removed. Retire is a separate verb (lot loss with reason)
 * and is unaffected by Delete.
 */
export function DeleteConfirmDialog({ count, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  const noun = count === 1 ? "item" : "items";
  return (
    <ConfirmDialog
      title={`Delete ${noun}`}
      message={
        <>
          Delete {count} {noun}? They'll be removed from inventory and won't
          appear in reorder. Audit history is preserved. This can't be undone.
        </>
      }
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
