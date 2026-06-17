// Per-location column attachment modal. Opened from the Inventory toolbar
// when scoped to a single location. Lets the user toggle which custom columns
// render at that location. Mirrors (but doesn't duplicate) the per-location
// management surface in Settings.
//
// Core columns are intentionally out of scope here — they always render
// everywhere by definition. Showing them with a disabled checkbox would just
// add noise.

import { useState } from "react";
import { X } from "lucide-react";
import type { InventoryColumn, InventoryLocation } from "./inventoryTypes";
import {
  createInventoryColumn,
  updateInventoryColumnAttachments,
} from "../../lib/inventoryApi";
import { useToast } from "../shared/Toast";

type ColumnType = "text" | "number" | "date" | "link" | "boolean";

/** Keys for columns that USED to be core but are being phased out (see
 *  `DEPRECATED_CORE_KEYS` in amplify/functions/inventoryApi/src/columns.ts).
 *  Their data is preserved as a fallback during transition, but they
 *  shouldn't be manageable per-location — the canonical action is to
 *  delete them from Settings → Inventory Columns. Keep this list in sync
 *  with the server-side constant; future churn should ideally stamp an
 *  `isDeprecated` flag on the column row instead so the client doesn't
 *  need to know specific keys. */
const DEPRECATED_COLUMN_KEYS = new Set<string>([
  "dimension",
  "displayUnit",
  "vendor",
  "packSize",
  "packCost",
  "unitCost",
  "reorderLink",
  "category",
  "unit",
]);

export type ColumnAttachmentDialogProps = {
  columns: InventoryColumn[];
  location: InventoryLocation;
  onClose: () => void;
  /** Called after a successful attach/detach so the parent can refresh state. */
  onColumnsChanged: () => void;
};

export function ColumnAttachmentDialog({
  columns,
  location,
  onClose,
  onColumnsChanged,
}: ColumnAttachmentDialogProps) {
  const toast = useToast();
  const [savingColumnId, setSavingColumnId] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<ColumnType>("text");
  const [creating, setCreating] = useState(false);

  // Custom columns only — core renders everywhere by definition. Also
  // hide deprecated columns: they're being phased out, so per-location
  // attachment doesn't make sense. Users manage / delete them from
  // Settings → Inventory Columns instead.
  const customColumns = columns
    .filter((c) => !c.isCore && !DEPRECATED_COLUMN_KEYS.has(c.key))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const isAttached = (col: InventoryColumn): boolean => {
    const list = col.attachedLocationIds ?? [];
    return list.includes(location.id);
  };

  const toggle = async (col: InventoryColumn) => {
    if (savingColumnId) return;
    setSavingColumnId(col.id);
    const current = new Set(col.attachedLocationIds ?? []);
    if (current.has(location.id)) current.delete(location.id);
    else current.add(location.id);
    try {
      await updateInventoryColumnAttachments(col.id, Array.from(current));
      onColumnsChanged();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update column");
    } finally {
      setSavingColumnId(null);
    }
  };

  /** Create a new custom column attached only to the current location.
   *  Per-location intent is implicit in the entry point: the user is already
   *  scoped to one location and managing its columns. If they want it in
   *  more places, they can attach it elsewhere later (or use Settings →
   *  Inventory Columns, which defaults to attaching everywhere). */
  const create = async () => {
    const label = newLabel.trim();
    if (!label || creating) return;
    setCreating(true);
    try {
      await createInventoryColumn({
        label,
        type: newType,
        attachedLocationIds: [location.id],
      });
      setNewLabel("");
      setNewType("text");
      onColumnsChanged();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to create column");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Manage columns">
      <div className="inventory-import-dialog" style={{ position: "relative" }}>
        {/* X close in the corner — matches the pattern used by other dialogs
         *  in the app. Using a single inline-styled button avoids a CSS-class
         *  detour for one element. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: "0.75rem",
            right: "0.75rem",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: "0.25rem",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "0.25rem",
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
        <h3 className="inventory-import-title" style={{ paddingRight: "1.75rem" }}>
          Columns at {location.name}
        </h3>
        <div className="inventory-import-list">
          {customColumns.length === 0 ? (
            <p className="settings-section-copy">
              No custom columns yet. Create one from Settings → Inventory Columns.
            </p>
          ) : (
            customColumns.map((col) => (
              <label key={col.id} className="inventory-import-item">
                <input
                  type="checkbox"
                  checked={isAttached(col)}
                  disabled={savingColumnId !== null && savingColumnId !== col.id}
                  onChange={() => void toggle(col)}
                />
                <span>
                  {col.label}
                  <span style={{ opacity: 0.5, marginLeft: "0.5rem", fontSize: "0.75em" }}>
                    {col.type}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        {/* Inline "+ Add column" — defaults to attaching only to the current
         *  location, since the user is already scoped here. To create a column
         *  for all locations at once, use Settings → Inventory Columns. */}
        <div
          style={{
            marginTop: "0.75rem",
            paddingTop: "0.75rem",
            borderTop: "1px solid var(--surface-alt)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <span style={{ fontSize: "0.85em", opacity: 0.75 }}>
            Add a column to {location.name}
          </span>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              className="field"
              type="text"
              placeholder="Column name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newLabel.trim() && !creating) void create();
              }}
              disabled={creating}
              style={{ flex: "1 1 12rem", minWidth: 0 }}
            />
            <select
              className="field"
              value={newType}
              onChange={(e) => setNewType(e.target.value as ColumnType)}
              disabled={creating}
              style={{ flex: "0 0 auto" }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="link">Link</option>
              <option value="boolean">Yes/No</option>
            </select>
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() => void create()}
              disabled={!newLabel.trim() || creating}
            >
              {creating ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
        <p
          className="inventory-import-subtitle"
          style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.85em", opacity: 0.75 }}
        >
          Required columns are managed in Settings.
        </p>
        <div className="inventory-import-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
