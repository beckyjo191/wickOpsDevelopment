import { useCallback, useEffect, useState } from "react";
import {
  approveUsageSubmission,
  listPendingSubmissions,
  rejectUsageSubmission,
  type PendingEntry,
  type PendingSubmission,
} from "../lib/inventoryApi";

type ReviewFilter = "pending" | "recent";

const formatRelativeTime = (isoString: string): string => {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
};

const parseEntries = (entriesJson: string): PendingEntry[] => {
  try {
    const parsed = JSON.parse(entriesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

type SubmissionCardProps = {
  submission: PendingSubmission;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
};

function SubmissionCard({ submission, onApprove, onReject }: SubmissionCardProps) {
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState("");

  const entries = parseEntries(submission.entriesJson);
  const isPending = submission.status === "pending";

  const handleApprove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onApprove(submission.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to approve.");
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onReject(submission.id, rejectReason.trim());
    } catch (err: any) {
      setError(err?.message ?? "Failed to reject.");
      setBusy(false);
    }
  };

  return (
    <div className={`usage-review-card usage-review-card--${submission.status}`}>
      <div className="usage-review-card-header">
        <div className="usage-review-card-meta">
          <span className="usage-review-submitter">
            {submission.submittedByName || submission.submittedByEmail}
          </span>
          <span className="usage-review-time">{formatRelativeTime(submission.submittedAt)}</span>
        </div>
        <span className={`usage-review-badge usage-review-badge--${submission.status}`}>
          {submission.status}
        </span>
      </div>

      <ul className="usage-review-entries">
        {entries.map((entry, i) => (
          <li key={i} className="usage-review-entry">
            <span className="usage-review-entry-name">{entry.itemName}</span>
            <span className="usage-review-entry-qty">×{entry.quantityUsed}</span>
            {entry.location ? (
              <span className="usage-review-entry-loc">{entry.location}</span>
            ) : null}
            {entry.notes ? (
              <span className="usage-review-entry-notes">{entry.notes}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {submission.status === "rejected" && submission.rejectionReason ? (
        <p className="usage-review-rejection-reason">
          Rejected: {submission.rejectionReason}
        </p>
      ) : null}

      {submission.status !== "pending" && submission.reviewedByEmail ? (
        <p className="usage-review-reviewed-by">
          {submission.status === "approved" ? "Approved" : "Rejected"} by{" "}
          {submission.reviewedByEmail}
          {submission.reviewedAt ? ` · ${formatRelativeTime(submission.reviewedAt)}` : ""}
        </p>
      ) : null}

      {error ? <p className="usage-review-card-error">{error}</p> : null}

      {isPending ? (
        <div className="usage-review-card-actions">
          {rejectOpen ? (
            <div className="usage-review-reject-wrap">
              <input
                type="text"
                className="usage-review-reject-input"
                placeholder="Reason (optional)"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => {
                  setRejectOpen(false);
                  setRejectReason("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-ghost button-sm usage-review-reject-confirm"
                onClick={() => void handleReject()}
                disabled={busy}
              >
                {busy ? "Rejecting..." : "Confirm Reject"}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => setRejectOpen(true)}
                disabled={busy}
              >
                Reject
              </button>
              <button
                type="button"
                className="button button-primary button-sm"
                onClick={() => void handleApprove()}
                disabled={busy}
              >
                {busy ? "Approving..." : "Approve"}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type UsageReviewPageProps = {
  onNavigateToUsageForm: () => void;
};

export function UsageReviewPage({ onNavigateToUsageForm }: UsageReviewPageProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submissions, setSubmissions] = useState<PendingSubmission[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>("pending");

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const data = await listPendingSubmissions();
      setSubmissions(data);
    } catch (err: any) {
      if (!silent) setLoadError(err?.message ?? "Failed to load submissions.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApprove = async (id: string) => {
    await approveUsageSubmission(id);
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, status: "approved", reviewedAt: new Date().toISOString() } : s,
      ),
    );
  };

  const handleReject = async (id: string, reason: string) => {
    await rejectUsageSubmission(id, reason);
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, status: "rejected", rejectionReason: reason || undefined, reviewedAt: new Date().toISOString() }
          : s,
      ),
    );
  };

  const pending = submissions.filter((s) => s.status === "pending");
  const recent = submissions.filter((s) => s.status !== "pending");
  const displayed = filter === "pending" ? pending : recent;

  if (loading) {
    return (
      <section className="app-content">
        <div className="app-card app-loading-card">
          <span className="app-spinner" aria-hidden="true" />
          <span>Loading submissions...</span>
        </div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="app-content">
        <div className="app-card">{loadError}</div>
      </section>
    );
  }

  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Usage Review</h2>
            <p className="app-subtitle">
              Review and approve usage submissions from your team.
            </p>
          </div>
        </header>

        <div className="usage-review-filter-tabs">
          <button
            type="button"
            className={`usage-review-tab${filter === "pending" ? " usage-review-tab--active" : ""}`}
            onClick={() => setFilter("pending")}
          >
            Pending
            {pending.length > 0 ? (
              <span className="usage-review-tab-badge">{pending.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={`usage-review-tab${filter === "recent" ? " usage-review-tab--active" : ""}`}
            onClick={() => setFilter("recent")}
          >
            Reviewed
            {recent.length > 0 ? (
              <span className="usage-review-tab-badge usage-review-tab-badge--neutral">{recent.length}</span>
            ) : null}
          </button>
        </div>

        {displayed.length === 0 ? (
          <div className="usage-review-empty">
            {filter === "pending" ? (
              <>
                <p>No pending submissions.</p>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={onNavigateToUsageForm}
                >
                  Go to Usage Form
                </button>
              </>
            ) : (
              <p>No reviewed submissions yet.</p>
            )}
          </div>
        ) : (
          <div className="usage-review-list">
            {displayed.map((submission) => (
              <SubmissionCard
                key={submission.id}
                submission={submission}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
