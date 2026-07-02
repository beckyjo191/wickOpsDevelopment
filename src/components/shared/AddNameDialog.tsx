// Small "create a named thing" sheet, styled to match AddColumnDialog. Used by
// Settings → Locations ("Add Location") and → Vendors ("Add Vendor") so the
// add flow feels consistent with Add Column. Self-contained: owns its name +
// error + saving state. `onConfirm` returns an error string to keep the sheet
// open (e.g. duplicate name), or null/void on success (the parent unmounts it).

import { useState } from "react";
import { X } from "lucide-react";

export function AddNameDialog({
  title,
  label,
  placeholder,
  confirmLabel = "Add",
  savingLabel = "Saving…",
  onConfirm,
  onCancel,
}: {
  title: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  savingLabel?: string;
  /** Perform the add. Return an error message to keep the sheet open, or
   *  null/undefined on success (the parent closes the sheet). */
  onConfirm: (name: string) => Promise<string | null | void> | string | null | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await onConfirm(name.trim());
      if (result) setError(result);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong.");
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
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.5rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span className="field-label">{label}</span>
            <input
              className={`field${error ? " field--error" : ""}`}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder={placeholder}
              autoFocus
              disabled={saving}
              onKeyDown={(e) => { if (e.key === "Enter" && canSave) void handleSave(); }}
            />
            {error ? <p className="field-error">{error}</p> : null}
          </label>
        </div>
        <div className="inventory-import-actions">
          <button className="button button-secondary" onClick={onCancel} disabled={saving} type="button">
            Cancel
          </button>
          <button className="button button-primary" onClick={() => void handleSave()} disabled={!canSave} type="button">
            {saving ? savingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
