export type DiscardConfirmDialogProps = {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation dialog for discarding blank/never-touched inventory rows.
 * Discard is gated client-side to rows with no operational history; anything
 * with content goes through Retire instead.
 */
export function DiscardConfirmDialog({ count, onConfirm, onCancel }: DiscardConfirmDialogProps) {
  return (
    <div className="settings-destructive-overlay">
      <div className="settings-destructive-backdrop" onClick={onCancel} />
      <div className="settings-destructive-sheet" role="dialog" aria-label="Confirm discard">
        <div className="settings-destructive-sheet-body">
          <p className="settings-destructive-sheet-title">Discard rows</p>
          <p className="settings-destructive-sheet-msg">
            Discard {count} blank {count === 1 ? "row" : "rows"}? Rows with content
            should be retired instead so their history is preserved.
          </p>
        </div>
        <div className="settings-destructive-sheet-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onConfirm}>Discard</button>
        </div>
      </div>
    </div>
  );
}
