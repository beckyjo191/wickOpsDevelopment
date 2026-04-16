import { useEffect, useMemo, useState } from "react";
import { listPendingSubmissions } from "../../../lib/inventoryApi";
import type { PendingEntry, PendingSubmission } from "../inventoryTypes";

/**
 * Owns the pending-usage-submissions queue for reviewers.
 * `isActive` controls loading UI — when true the hook puts up a spinner while fetching.
 * Fetch happens whenever `isActive` OR `canReviewSubmissions` changes (so a reviewer
 * outside the pending view still has data for a count badge).
 */
export function usePendingSubmissions(
  isActive: boolean,
  canReviewSubmissions: boolean | undefined,
) {
  const [pendingSubmissions, setPendingSubmissions] = useState<PendingSubmission[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState("");
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllError, setApproveAllError] = useState("");
  // Per-submission edited quantities: submissionId -> entry index -> quantityUsed
  const [editedQtys, setEditedQtys] = useState<Record<string, Record<number, string>>>({});

  const mergedPendingItems = useMemo(() => {
    if (!isActive) return [] as { entry: PendingEntry; totalQty: number }[];
    const map = new Map<string, { entry: PendingEntry; totalQty: number }>();
    for (const sub of pendingSubmissions) {
      let entries: PendingEntry[] = [];
      try { entries = JSON.parse(sub.entriesJson); } catch { entries = []; }
      for (const e of entries) {
        const existing = map.get(e.itemId);
        if (existing) {
          existing.totalQty += e.quantityUsed;
        } else {
          map.set(e.itemId, { entry: e, totalQty: e.quantityUsed });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.entry.itemName.localeCompare(b.entry.itemName),
    );
  }, [pendingSubmissions, isActive]);

  // Fetch pending submissions on mount (for badge count) and when activation changes
  useEffect(() => {
    if (!canReviewSubmissions) return;
    if (isActive) setPendingLoading(true);
    setPendingError("");
    listPendingSubmissions()
      .then((subs) => {
        setPendingSubmissions(subs.filter((s) => s.status === "pending"));
        if (isActive) setPendingLoading(false);
      })
      .catch((err: any) => {
        if (isActive) {
          setPendingError(err?.message ?? "Failed to load pending submissions.");
          setPendingLoading(false);
        }
      });
  }, [isActive, canReviewSubmissions]);

  return {
    pendingSubmissions,
    setPendingSubmissions,
    pendingLoading,
    setPendingLoading,
    pendingError,
    setPendingError,
    approvingAll,
    setApprovingAll,
    approveAllError,
    setApproveAllError,
    editedQtys,
    setEditedQtys,
    mergedPendingItems,
  };
}
