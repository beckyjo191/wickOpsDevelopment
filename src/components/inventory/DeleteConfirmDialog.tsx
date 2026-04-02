export type DeleteConfirmDialogProps = {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation dialog for bulk-deleting inventory rows.
 * Extracted from InventoryPage lines ~3125-3141.
 */
export function DeleteConfirmDialog({ count, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  return (
    <div className="settings-destructive-overlay">
      <div className="settings-destructive-backdrop" onClick={onCancel} />
      <div className="settings-destructive-sheet" role="dialog" aria-label="Confirm delete">
        <div className="settings-destructive-sheet-body">
          <p className="settings-destructive-sheet-title">Delete Items</p>
          <p className="settings-destructive-sheet-msg">
            Delete {count} selected {count === 1 ? "item" : "items"}? This cannot be undone after saving.
          </p>
        </div>
        <div className="settings-destructive-sheet-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}
