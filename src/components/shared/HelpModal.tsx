import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, X } from "lucide-react";

export type HelpModalProps = {
  /** Visible title in the modal header. Also used for aria-labelledby. */
  title: string;
  /** Help content rendered inside the modal body. */
  children: ReactNode;
  /** Optional override for the trigger button's aria-label / tooltip.
   *  Defaults to "{title} help". */
  triggerLabel?: string;
};

/**
 * Self-contained help modal: renders a circular HelpCircle trigger button and,
 * when open, an overlay with a sticky-header + scrollable-body modal. Replaces
 * the four hand-rolled help modals (Dashboard, Activity, Inventory, Orders)
 * that previously copy-pasted the same structure under the legacy
 * `.orders-help-*` class names.
 *
 * Mobile: at ≤600px the modal fills the viewport edge-to-edge with a sticky
 * header so the close button stays thumb-reachable. Backdrop tap, Escape, or
 * the close button all dismiss.
 *
 * Focus management: when the modal opens, focus moves to the close button so
 * Escape / Enter work immediately. On close, focus returns to the trigger.
 */
export function HelpModal({ title, children, triggerLabel }: HelpModalProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `help-modal-${title.toLowerCase().replace(/\s+/g, "-")}-title`;
  const label = triggerLabel ?? `${title} help`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Move focus into the modal on open, restore to trigger on close.
  // wasOpenRef gates the close-side restore so we don't steal focus on
  // initial mount (open starts false; we only restore after a real open).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      // requestAnimationFrame so the DOM is rendered before we focus.
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="help-modal-trigger"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
      >
        <HelpCircle size={16} />
      </button>
      {/* Portal to <body> so the overlay escapes the subnav's stacking context.
       *  On mobile .inventory-subnav is `position: sticky; z-index: 11`, which
       *  traps a nested fixed overlay — page dropdowns (z-index 30–50) would
       *  otherwise paint over the help modal. */}
      {open && createPortal(
        <div
          className="help-modal-overlay"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="help-modal app-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="help-modal-header">
              <h3 id={titleId}>{title}</h3>
              <button
                ref={closeButtonRef}
                type="button"
                className="button button-ghost button-sm help-modal-close"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="help-modal-body">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
