import { useEffect, useRef, useState } from "react";
import {
  RETIRE_REASON_LABEL,
  type RetireReason,
} from "../../lib/inventoryApi";

/** Outcome the parent acts on. Retire → soft-delete with a loss reason
 *  (preserves audit + analytics). Delete → hard-remove the row, used only
 *  when the row was created in error. */
export type RemoveChoice =
  | { kind: "retire"; reason: RetireReason; notes?: string }
  | { kind: "delete" };

type RemoveOption =
  | { kind: "retire"; reason: RetireReason; label: string }
  | { kind: "delete"; label: string };

/** All options shown in the picker, in display order. The "Created by
 *  mistake" Delete path is the only one that hard-removes a row; everything
 *  else is a Retire with that reason. Keeping the reason→label map in
 *  inventoryApi.ts means analytics surfaces share the wording. */
const REMOVE_OPTIONS: RemoveOption[] = [
  { kind: "retire", reason: "expired", label: RETIRE_REASON_LABEL.expired },
  { kind: "retire", reason: "damaged", label: RETIRE_REASON_LABEL.damaged },
  { kind: "retire", reason: "lost", label: RETIRE_REASON_LABEL.lost },
  { kind: "retire", reason: "recalled", label: RETIRE_REASON_LABEL.recalled },
  { kind: "retire", reason: "discontinued", label: RETIRE_REASON_LABEL.discontinued },
  { kind: "delete", label: "Created by mistake — never stocked" },
];

const optionId = (opt: RemoveOption): string =>
  opt.kind === "delete" ? "delete" : opt.reason;

export type RemoveItemDialogProps = {
  /** Number of rows the action will apply to. Drives pluralization and lets
   *  the title/copy reflect bulk vs single without the parent rendering two
   *  variants. */
  count: number;
  /** When count === 1, the item name is shown in the title for clarity.
   *  Optional for bulk operations or rows without a populated itemName. */
  itemName?: string;
  /** When false, the "Created by mistake" option is disabled and an
   *  explanatory note is shown. Set this when any selected row has on-hand
   *  stock or audit history beyond ITEM_CREATE — the server's delete guard
   *  would reject the request anyway, and offering the option in the UI
   *  would be misleading. */
  allowCreatedInError: boolean;
  /** Default-selected option. Useful for the Expired tab where "Expired"
   *  is the obvious answer; pre-selecting saves a click. */
  defaultReason?: RetireReason;
  onConfirm: (choice: RemoveChoice) => void;
  onCancel: () => void;
  /** While the parent is processing the request, disable inputs and show
   *  a loading label on the confirm button. */
  loading?: boolean;
};

/**
 * Unified Remove dialog. Replaces the separate "Delete" and "Retire"
 * affordances by asking the user *what happened* and routing to the right
 * backend operation. The Delete vs Retire distinction (hard remove vs
 * loss-event soft delete) lives in the resulting `RemoveChoice` so the
 * parent can dispatch — but the user never has to think about it.
 */
export function RemoveItemDialog({
  count,
  itemName,
  allowCreatedInError,
  defaultReason,
  onConfirm,
  onCancel,
  loading = false,
}: RemoveItemDialogProps) {
  const [selectedId, setSelectedId] = useState<string>(
    () => (defaultReason ? defaultReason : ""),
  );
  const [notes, setNotes] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = "remove-item-dialog-title";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, loading]);

  // Same accessibility pattern as ConfirmDialog: focus Cancel on open so an
  // accidental Enter cancels rather than removes.
  useEffect(() => {
    requestAnimationFrame(() => cancelRef.current?.focus());
  }, []);

  const noun = count === 1 ? "item" : `${count} items`;
  const title =
    count === 1
      ? itemName
        ? `Remove "${itemName}"`
        : "Remove item"
      : `Remove ${count} items`;

  const handleConfirm = () => {
    const opt = REMOVE_OPTIONS.find((o) => optionId(o) === selectedId);
    if (!opt) return;
    if (opt.kind === "delete") {
      onConfirm({ kind: "delete" });
    } else {
      onConfirm({
        kind: "retire",
        reason: opt.reason,
        notes: notes.trim() || undefined,
      });
    }
  };

  const canConfirm = selectedId !== "" && !loading;

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
          <h3 id={titleId} className="confirm-dialog-title">{title}</h3>
          <p className="confirm-dialog-message">
            What happened to {count === 1 ? "it" : `these ${noun}`}?
          </p>

          <ul className="remove-reason-list" role="radiogroup" aria-labelledby={titleId}>
            {REMOVE_OPTIONS
              // "Created by mistake" only applies to rows with no on-hand
              // stock — it's the only path that hard-deletes the row, and
              // the server's delete guard would reject it otherwise. When
              // it doesn't apply we hide it entirely rather than showing a
              // disabled option, so the user isn't shown choices they
              // can't pick.
              .filter((opt) => opt.kind !== "delete" || allowCreatedInError)
              .map((opt) => {
                const id = optionId(opt);
                const checked = selectedId === id;
                return (
                  <li key={id} className="remove-reason-option">
                    <label className="remove-reason-label">
                      <input
                        type="radio"
                        name="remove-reason"
                        value={id}
                        checked={checked}
                        onChange={() => setSelectedId(id)}
                        disabled={loading}
                      />
                      <span className="remove-reason-text">{opt.label}</span>
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
              placeholder="Anything worth recording — context, who pulled it, etc."
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
            className="button button-danger"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {loading ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
