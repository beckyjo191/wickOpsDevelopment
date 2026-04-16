import { useState } from "react";
import type { RetireReason } from "../../lib/inventoryApi";

export type DeleteBlockedDialogProps = {
  blockedRows: Array<{ id: string; itemName: string }>;
  onRetire: (reason: RetireReason) => void;
  onCancel: () => void;
};

const REASON_OPTIONS: Array<{ value: RetireReason; label: string }> = [
  { value: "expired", label: "Expired" },
  { value: "damaged", label: "Damaged" },
  { value: "lost", label: "Lost" },
  { value: "recalled", label: "Recalled" },
];

export function DeleteBlockedDialog({ blockedRows, onRetire, onCancel }: DeleteBlockedDialogProps) {
  const [reason, setReason] = useState<RetireReason>("expired");
  const count = blockedRows.length;
  return (
    <div className="settings-destructive-overlay">
      <div className="settings-destructive-backdrop" onClick={onCancel} />
      <div className="settings-destructive-sheet" role="dialog" aria-label="Cannot delete — retire instead">
        <div className="settings-destructive-sheet-body">
          <p className="settings-destructive-sheet-title">Can't delete — retire instead</p>
          <p className="settings-destructive-sheet-msg">
            {count === 1 ? "This item has" : `${count} items have`} usage, restock, or edit
            history. Deleting would lose that history. Retire instead — the row stays at zero
            quantity so reorder and loss tracking still work.
          </p>
          {count <= 8 ? (
            <ul className="settings-destructive-sheet-list">
              {blockedRows.map((r) => (
                <li key={r.id}>{r.itemName}</li>
              ))}
            </ul>
          ) : null}
          <label className="settings-destructive-sheet-label">
            Retirement reason
            <select
              className="settings-destructive-sheet-select"
              value={reason}
              onChange={(e) => setReason(e.target.value as RetireReason)}
            >
              {REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-destructive-sheet-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={() => onRetire(reason)}>Retire Instead</button>
        </div>
      </div>
    </div>
  );
}
