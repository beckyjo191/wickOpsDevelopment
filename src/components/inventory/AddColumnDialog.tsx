// Add-column dialog: name + type + which locations to attach to. Replaces
// the previous inline-form approach that had no location selection step,
// causing every new column to default to "all locations" silently.
//
// Defaults to "All locations" selected — matches the pre-restructure
// expectation that a freshly-created column shows up everywhere unless the
// user opts out. The picker is right there for opt-out, no extra step.

import { useState } from "react";
import { X } from "lucide-react";
import type { InventoryLocation } from "./inventoryTypes";

type ColumnType = "text" | "number" | "date" | "link" | "boolean";

export type AddColumnDialogProps = {
  locations: InventoryLocation[];
  onCreate: (input: {
    label: string;
    type: ColumnType;
    attachedLocationIds: string[];
  }) => Promise<void> | void;
  onCancel: () => void;
};

export function AddColumnDialog({
  locations,
  onCreate,
  onCancel,
}: AddColumnDialogProps) {
  const sortedLocations = [...locations].sort((a, b) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
  );

  const [label, setLabel] = useState("");
  const [type, setType] = useState<ColumnType>("text");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(sortedLocations.map((l) => l.id)),
  );
  const [saving, setSaving] = useState(false);

  const allOn = sortedLocations.length > 0 && sortedLocations.every((l) => selected.has(l.id));
  const allOff = selected.size === 0;
  const trimmed = label.trim();
  const canSave = trimmed.length > 0 && !saving && !allOff;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onCreate({
        label: trimmed,
        type,
        attachedLocationIds: Array.from(selected),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inventory-import-overlay" role="dialog" aria-modal="true" aria-label="Add column">
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
          Add Column
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.5rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span className="field-label">Column name</span>
            <input
              className="field"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Lot Number"
              autoFocus
              disabled={saving}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) void handleSave();
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span className="field-label">Type</span>
            <select
              className="field"
              value={type}
              onChange={(e) => setType(e.target.value as ColumnType)}
              disabled={saving}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="link">Link</option>
              <option value="boolean">Yes/No</option>
            </select>
          </label>
          <div>
            <span className="field-label" style={{ display: "block", marginBottom: "0.25rem" }}>
              Show at which locations?
            </span>
            {sortedLocations.length === 0 ? (
              <p className="settings-section-copy" style={{ marginTop: 0 }}>
                No locations yet. Add a location in Settings → Locations first.
              </p>
            ) : (
              <>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    onClick={() => setSelected(new Set(sortedLocations.map((l) => l.id)))}
                    disabled={saving || allOn}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    onClick={() => setSelected(new Set())}
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
          </div>
        </div>
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
            onClick={() => void handleSave()}
            disabled={!canSave}
            type="button"
          >
            {saving ? "Creating…" : "Create Column"}
          </button>
        </div>
      </div>
    </div>
  );
}
