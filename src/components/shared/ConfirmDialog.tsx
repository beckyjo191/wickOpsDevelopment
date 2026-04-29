import { useEffect, useRef, type ReactNode } from "react";

export type ConfirmDialogProps = {
  /** Dialog title — short noun phrase ("Cancel Invite", "Remove Location"). */
  title: string;
  /** Body copy explaining what will happen if the user confirms. */
  message: ReactNode;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Fired when the user clicks confirm. */
  onConfirm: () => void;
  /** Fired when the user clicks cancel, hits Escape, or clicks the backdrop. */
  onCancel: () => void;
  /** Treat the action as destructive (red confirm button). Defaults to true,
   *  since the vast majority of these dialogs gate destructive actions. */
  destructive?: boolean;
  /** While the action is in flight, disable both buttons. The confirm
   *  button can also display a loading label via `loadingLabel`. */
  loading?: boolean;
  /** Optional alternate label shown on the confirm button while `loading`
   *  is true (e.g. "Removing…", "Cancelling…"). */
  loadingLabel?: string;
};

/**
 * Standard confirmation dialog used for destructive actions: Cancel Invite,
 * Remove Location, Remove Vendor, etc. Replaces the previous bespoke
 * `.settings-destructive-sheet` markup.
 *
 * Keyboard: Escape closes (calls `onCancel`). On open, focus moves to the
 * cancel button so a casual Enter doesn't accidentally confirm a
 * destructive action — the user has to explicitly tab over to confirm.
 *
 * Mobile: full-viewport overlay, sticky-ish layout, safe-area aware.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  destructive = true,
  loading = false,
  loadingLabel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `confirm-dialog-${title.toLowerCase().replace(/\s+/g, "-")}-title`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Focus the cancel button on open: makes accidental "Enter" press the
  // safe option (cancel) rather than confirm.
  useEffect(() => {
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);

  return (
    <div
      className="confirm-dialog-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="confirm-dialog-body">
          <h3 id={titleId} className="confirm-dialog-title">{title}</h3>
          <div className="confirm-dialog-message">{message}</div>
        </div>
        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${destructive ? "button-danger" : "button-primary"}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading && loadingLabel ? loadingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
