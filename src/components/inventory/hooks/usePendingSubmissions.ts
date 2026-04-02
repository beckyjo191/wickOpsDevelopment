import { useEffect, useMemo, useState } from "react";
import { listPendingSubmissions } from "../../../lib/inventoryApi";
import type { ActiveTab, PendingEntry, PendingSubmission } from "../inventoryTypes";

export function usePendingSubmissions(
  activeTab: ActiveTab,
  canReviewSubmissions: boolean | undefined,
) {
  const [pendingSubmissions, setPendingSubmissions] = useState<PendingSubmission[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState("");
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllError, setApproveAllError] = useState("");
  // Per-submission edited quantities: submissionId -> entry index -> quantityUsed
  const [editedQtys, setEditedQtys] = useState<Record<string, Record<number, string>>>({});
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templateSelectedIds, setTemplateSelectedIds] = useState<Set<string> | null>(null);

  const mergedPendingItems = useMemo(() => {
    if (activeTab !== "pendingSubmissions") return [] as { entry: PendingEntry; totalQty: number }[];
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
  }, [pendingSubmissions, activeTab]);

  // Fetch pending submissions on mount (for badge count) and when tab is active
  useEffect(() => {
    if (!canReviewSubmissions) return;
    const isOnTab = activeTab === "pendingSubmissions";
    if (isOnTab) setPendingLoading(true);
    setPendingError("");
    listPendingSubmissions()
      .then((subs) => {
        setPendingSubmissions(subs.filter((s) => s.status === "pending"));
        if (isOnTab) setPendingLoading(false);
      })
      .catch((err: any) => {
        if (isOnTab) {
          setPendingError(err?.message ?? "Failed to load pending submissions.");
          setPendingLoading(false);
        }
      });
  }, [activeTab, canReviewSubmissions]);

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
    showTemplateDialog,
    setShowTemplateDialog,
    templateSelectedIds,
    setTemplateSelectedIds,
    mergedPendingItems,
  };
}
