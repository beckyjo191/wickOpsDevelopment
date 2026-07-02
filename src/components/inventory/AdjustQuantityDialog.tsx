import { useEffect, useMemo, useRef, useState } from "react";
import {
  ADJUST_REASON_LABEL,
  type AdjustReason,
} from "../../lib/inventoryApi";

/** Outcome the parent acts on: the corrected on-hand count plus the required
 *  reason and an optional free-text note. */
export type AdjustQuantityChoice = {
  newQty: number;
  reason: AdjustReason;
  notes?: string;
};

/** Reasons shown in the picker, in display order. Kept in sync with the
 *  backend ADJUST_REASONS list; the labels live in inventoryApi.ts so the
 *  activity feed renders the same wording. */
const ADJUST_OPTIONS: AdjustReason[] = [
  "recount",
  "found",
  "shrinkage",
  "damaged",
  "data_entry",
  "other",
];

export type AdjustQuantityDialogProps = {
  /** Item name shown in the title for context. */
  itemName: string;
  /** The on-hand count before this correction. Pre-fills the input. */
  currentQty: number;
  /** Optional unit label ("lb", "ct") shown beside the inputs. */
  unit?: string;
  onConfirm: (choice: AdjustQuantityChoice) => void;
  onCancel: () => void;
  /** While the parent is saving, disable inputs and show a loading label. */
  loading?: boolean;
};

/**
 * Quantity reconciliation dialog. Reached by editing the Quantity cell of an
 * already-saved row — the on-hand count drifted from reality and the user is
 * correcting it. Unlike a silent inline edit, this captures *why* (a required
 * reason + optional note) so the change lands in the audit trail as a
 * first-class ITEM_QTY_ADJUST event. Mirrors RemoveItemDialog's structure.
 */
export function AdjustQuantityDialog({
  itemName,
  currentQty,
  unit,
  onConfirm,
  onCancel,
  loading = false,
}: AdjustQuantityDialogProps) {
  const [qtyText, setQtyText] = useState<string>(() => String(currentQty));
  const [reason, setReason] = useState<AdjustReason | "">("");
  const [notes, setNotes] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = "adjust-qty-dialog-title";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, loading]);

  // Focus Cancel on open so an accidental Enter cancels rather than commits a
  // correction (same pattern as RemoveItemDialog / ConfirmDialog).
  useEffect(() => {
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);

  const parsedQty = useMemo(() => {
    const n = Number(qtyText);
    return Number.isFinite(n) ? Math.max(0, n) : NaN;
  }, [qtyText]);

  const delta = Number.isFinite(parsedQty) ? parsedQty - currentQty : 0;
  const unitSuffix = (unit ?? "").trim();

  // Confirm requires a valid new count that actually differs from the current
  // one, plus a chosen reason. No-op "corrections" shouldn't write an event.
  const canConfirm =
    !loading &&
    reason !== "" &&
    Number.isFinite(parsedQty) &&
    parsedQty !== currentQty;

  const handleConfirm = () => {
    // canConfirm already guarantees a chosen reason + a valid, changed count,
    // so TS narrows `reason` to AdjustReason past this guard.
    if (!canConfirm) return;
    onConfirm({
      newQty: parsedQty,
      reason,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <div
      className="confirm-dialog-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div
        className="confirm-dialog remove-item-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="confirm-dialog-body">
          <h3 id={titleId} className="confirm-dialog-title">
            Adjust "{itemName}"
          </h3>
          <p className="confirm-dialog-message">
            Correct the on-hand count to match what's actually there. This is
            recorded in the activity log with the reason below.
          </p>

          <label className="adjust-qty-field">
            <span className="adjust-qty-field-label">New on-hand count</span>
            <div className="inventory-number-with-unit">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={qtyText}
                onChange={(e) => setQtyText(e.currentTarget.value)}
                onFocus={(e) => e.currentTarget.select()}
                disabled={loading}
                aria-label="New on-hand count"
              />
              {unitSuffix && <span className="inventory-unit-suffix">{unitSuffix}</span>}
            </div>
            <span className="adjust-qty-delta">
              {currentQty}
              {unitSuffix ? ` ${unitSuffix}` : ""} on record
              {Number.isFinite(parsedQty) && parsedQty !== currentQty
                ? ` → ${delta > 0 ? "+" : ""}${delta}`
                : ""}
            </span>
          </label>

          <p className="confirm-dialog-message">Why is it changing?</p>
          <ul className="remove-reason-list" role="radiogroup" aria-labelledby={titleId}>
            {ADJUST_OPTIONS.map((r) => {
              const checked = reason === r;
              return (
                <li key={r} className="remove-reason-option">
                  <label className="remove-reason-label">
                    <input
                      type="radio"
                      name="adjust-reason"
                      value={r}
                      checked={checked}
                      onChange={() => setReason(r)}
                      disabled={loading}
                    />
                    <span className="remove-reason-text">{ADJUST_REASON_LABEL[r]}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          <label className="remove-reason-notes">
            <span className="remove-reason-notes-label">
              Notes <span className="remove-reason-notes-optional">(optional)</span>
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 500))}
              placeholder="Anything worth recording — who counted, where the gap was, etc."
              rows={2}
              disabled={loading}
            />
          </label>
        </div>

        <div className="confirm-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {loading ? "Saving…" : "Save adjustment"}
          </button>
        </div>
      </div>
    </div>
  );
}
