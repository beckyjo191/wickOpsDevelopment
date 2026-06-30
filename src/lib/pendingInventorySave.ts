import type { InventoryRow } from "./inventoryApi";

/** Durable, offline-safe stash of an inventory save that did not reach the
 *  server. Written synchronously to localStorage so it survives a tab close
 *  on a dead connection (where the keepalive network request silently fails).
 *  Replayed on next load once connectivity is back — this is the "queue and
 *  sync when reconnected" half of graceful offline degradation. */

const STORAGE_KEY = "wickops.inventory.pendingSave";

/** Stashes older than this are ignored on read and treated as stale. Keeps a
 *  forgotten payload from resurrecting weeks-old edits over current data. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingInventorySave {
  organizationId: string;
  rows: InventoryRow[];
  deletedRowIds: string[];
  /** epoch ms when stashed; used for the staleness cap on read. */
  savedAt: number;
}

/** Synchronously persist the unsaved diff. Safe to call from unload handlers.
 *  No-op when there is nothing pending. Swallows quota/serialization errors —
 *  a failed stash must never break the save path or block navigation. */
export const stashPendingSave = (
  organizationId: string,
  rows: InventoryRow[],
  deletedRowIds: string[],
  now: number = Date.now(),
): void => {
  if (rows.length === 0 && deletedRowIds.length === 0) return;
  try {
    const payload: PendingInventorySave = {
      organizationId,
      rows,
      deletedRowIds,
      savedAt: now,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort: quota exceeded or storage unavailable.
  }
};

/** Read a non-stale stash, or null. Drops (and clears) stale or malformed entries. */
export const readPendingSave = (now: number = Date.now()): PendingInventorySave | null => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingInventorySave;
    if (
      !parsed ||
      typeof parsed.organizationId !== "string" ||
      !Array.isArray(parsed.rows) ||
      !Array.isArray(parsed.deletedRowIds) ||
      typeof parsed.savedAt !== "number"
    ) {
      clearPendingSave();
      return null;
    }
    if (now - parsed.savedAt > MAX_AGE_MS) {
      clearPendingSave();
      return null;
    }
    return parsed;
  } catch {
    clearPendingSave();
    return null;
  }
};

export const clearPendingSave = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
