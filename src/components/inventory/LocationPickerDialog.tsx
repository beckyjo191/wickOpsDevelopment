// Reusable "where should this thing appear?" dialog. Today: column
// attachment editor (Settings → Inventory Columns checkbox click, and
// Settings → Add Column). Tomorrow: any new feature that needs the same
// "pick from N locations with All/None shortcuts" UX.
//
// Deliberately stateful (own draft selection) so the user can fiddle with
// checkboxes without each click hitting the network. Confirm fires once.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { InventoryLocation } from "./inventoryTypes";

export type LocationPickerDialogProps = {
  title: string;
  /** Optional subtitle / explanatory line shown under the title. */
  subtitle?: string;
  locations: InventoryLocation[];
  /** Currently-selected location ids. The dialog seeds its draft state
   *  from this; downstream changes happen on Confirm. */
  initialSelectedIds: string[];
  /** "Confirm" button label. Defaults to "Save". */
  confirmLabel?: string;
  /** Whether confirm is disabled even if a selection exists. Used by the
   *  Add Column flow to require a non-empty column name first. */
  confirmDisabled?: boolean;
  onConfirm: (selectedIds: string[]) => Promise<void> | void;
  onCancel: () => void;
};

export function LocationPickerDialog({
  title,
  subtitle,
  locations,
  initialSelectedIds,
  confirmLabel = "Save",
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: LocationPickerDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedIds),
  );
  const [saving, setSaving] = useState(false);

  // Re-seed if the parent mounts the dialog with a different column.
  // (Cheap; the Set never shares identity with the parent's array.)
  useEffect(() => {
    setSelected(new Set(initialSelectedIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedIds.join("|")]);

  const sortedLocations = [...locations].sort((a, b) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
  );

  const allOn = sortedLocations.length > 0 && sortedLocations.every((l) => selected.has(l.id));
  const allOff = selected.size === 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(sortedLocations.map((l) => l.id)));
  const selectNone = () => setSelected(new Set());

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm(Array.from(selected));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="inventory-import-dialog" style={{ position: "relative" }}>
        <button
          type="button"
          onClick={onCancel}
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
          {title}
        </h3>
        {subtitle ? (
          <p className="inventory-import-subtitle" style={{ marginTop: "0.25rem" }}>
            {subtitle}
          </p>
        ) : null}

        {sortedLocations.length === 0 ? (
          <p className="settings-section-copy">
            No locations yet. Add a location in Settings → Locations first.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                marginTop: "0.5rem",
                marginBottom: "0.5rem",
              }}
            >
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={selectAll}
                disabled={saving || allOn}
              >
                All
              </button>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={selectNone}
                disabled={saving || allOff}
              >
                None
              </button>
              <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: "0.85em", opacity: 0.7 }}>
                {selected.size} of {sortedLocations.length} selected
              </span>
            </div>
            <div className="inventory-import-list">
              {sortedLocations.map((loc) => (
                <label key={loc.id} className="inventory-import-item">
                  <input
                    type="checkbox"
                    checked={selected.has(loc.id)}
                    onChange={() => toggle(loc.id)}
                    disabled={saving}
                  />
                  <span>{loc.name}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="inventory-import-actions">
          <button
            className="button button-secondary"
            onClick={onCancel}
            disabled={saving}
            type="button"
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            onClick={() => void handleConfirm()}
            disabled={saving || confirmDisabled || sortedLocations.length === 0}
            type="button"
          >
            {saving ? "Saving…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
