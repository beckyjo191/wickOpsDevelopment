import { useState } from "react";
import type { PendingEntry, PendingSubmission } from "./inventoryTypes";
import type { MergedEntry, PendingSubmissionCardProps } from "./inventoryTypes";
import { formatPendingTime, parseSubmissionEntries } from "./inventoryUtils";

export type PendingSubmissionsTabProps = {
  submissions: PendingSubmission[];
  loading: boolean;
  error: string;
  mergedItems: { entry: PendingEntry; totalQty: number }[];
  approvingAll: boolean;
  approveAllError: string;
  editedQtys: Record<string, Record<number, string>>;
  onEditQty: (submissionId: string, entryIndex: number, value: string) => void;
  onApprove: (submissionId: string, effectiveEntries?: PendingEntry[]) => Promise<void>;
  onApproveAll: () => Promise<void>;
  onDelete: (submissionId: string) => Promise<void>;
  buildLabel: (entry: PendingEntry) => string;
};

/**
 * PendingSubmissionCard - individual submission card with approve/delete actions.
 * Extracted from InventoryPage lines ~105-196.
 */
function PendingSubmissionCard({
  submission,
  entries,
  editedQtys,
  buildLabel,
  onEditQty,
  onApprove,
  onDelete,
}: PendingSubmissionCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handle = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err: any) {
      setError(err?.message ?? "Action failed.");
      setBusy(false);
    }
  };

  // Merge entries with the same itemId within this submission
  const merged: MergedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const existing = merged.find((m) => m.entry.itemId === e.itemId);
    if (existing) {
      existing.totalQty += e.quantityUsed;
    } else {
      merged.push({ entry: e, origIndex: i, totalQty: e.quantityUsed });
    }
  }

  return (
    <div className="inventory-pending-card">
      <div className="inventory-pending-card-meta">
        <span className="inventory-pending-who">{submission.submittedByName || submission.submittedByEmail}</span>
        <span className="inventory-pending-when">{formatPendingTime(submission.submittedAt)}</span>
      </div>
      <table className="inventory-pending-entries">
        <tbody>
          {merged.map(({ entry, origIndex, totalQty }) => (
            <tr key={entry.itemId}>
              <td className="inventory-pending-entry-name">
                {buildLabel(entry)}
                {entry.notes && (
                  <span className="inventory-pending-entry-note">{entry.notes}</span>
                )}
              </td>
              <td className="inventory-pending-entry-qty">
                <input
                  type="number"
                  min={1}
                  step="any"
                  className="inventory-pending-qty-input"
                  value={editedQtys[origIndex] !== undefined ? editedQtys[origIndex] : String(totalQty)}
                  onChange={(e) => onEditQty(origIndex, e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  disabled={busy}
                  aria-label={`Quantity for ${entry.itemName}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="inventory-pending-error">{error}</p> : null}
      <div className="inventory-pending-actions">
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => void handle(onDelete)}
          disabled={busy}
        >
          Delete
        </button>
        <button
          type="button"
          className="button button-primary button-sm"
          onClick={() => void handle(onApprove)}
          disabled={busy}
        >
          {busy ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

/**
 * Pending Submissions tab content with merged summary + individual cards.
 * Extracted from InventoryPage lines ~2241-2346.
 */
export function PendingSubmissionsTab({
  submissions,
  loading,
  error,
  mergedItems,
  approvingAll,
  approveAllError,
  editedQtys,
  onEditQty,
  onApprove,
  onApproveAll,
  onDelete,
  buildLabel,
}: PendingSubmissionsTabProps) {
  if (loading) {
    return (
      <div className="inventory-pending-wrap">
        <div className="app-loading-card" style={{ padding: "2rem", textAlign: "center" }}>
          <span className="app-spinner" aria-hidden="true" /> Loading submissions...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="inventory-pending-wrap">
        <p style={{ color: "var(--text-soft)", padding: "1rem" }}>{error}</p>
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div className="inventory-pending-wrap">
        <p style={{ color: "var(--text-soft)", padding: "1rem" }}>No pending submissions.</p>
      </div>
    );
  }

  return (
    <div className="inventory-pending-wrap">
      {/* Merged summary + Approve All */}
      <div className="inventory-pending-summary">
        <div className="inventory-pending-summary-header">
          <h4 className="inventory-pending-summary-title">All Pending Items</h4>
          <button
            type="button"
            className="button button-primary button-sm"
            disabled={approvingAll}
            onClick={() => void onApproveAll()}
          >
            {approvingAll ? "Approving..." : "Approve All"}
          </button>
        </div>
        <table className="inventory-pending-entries">
          <tbody>
            {mergedItems.map(({ entry, totalQty }) => (
              <tr key={entry.itemId}>
                <td className="inventory-pending-entry-name">{buildLabel(entry)}</td>
                <td className="inventory-pending-entry-qty" style={{ color: "var(--text-soft)", fontWeight: 600 }}>×{totalQty}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {approveAllError ? <p className="inventory-pending-error">{approveAllError}</p> : null}
      </div>

      {/* Individual submissions for delete (or qty edits before approve all) */}
      <h4 className="inventory-pending-summary-title" style={{ marginTop: "1.25rem" }}>Submissions</h4>
      {submissions.map((sub) => {
        const entries = parseSubmissionEntries(sub.entriesJson);
        const subEdits = editedQtys[sub.id] ?? {};
        const effectiveEntries: PendingEntry[] = entries.map((e, i) => ({
          ...e,
          quantityUsed: subEdits[i] !== undefined ? Number(subEdits[i]) || e.quantityUsed : e.quantityUsed,
        }));
        return (
          <PendingSubmissionCard
            key={sub.id}
            submission={sub}
            entries={effectiveEntries}
            editedQtys={subEdits}
            buildLabel={buildLabel}
            onEditQty={(entryIndex, value) => onEditQty(sub.id, entryIndex, value)}
            onApprove={() => onApprove(sub.id, effectiveEntries)}
            onDelete={() => onDelete(sub.id)}
          />
        );
      })}
    </div>
  );
}
