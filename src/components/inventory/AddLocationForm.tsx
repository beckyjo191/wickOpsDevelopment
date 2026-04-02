export type AddLocationFormProps = {
  newLocationName: string;
  onNameChange: (name: string) => void;
  onAdd: () => void;
  onCancel: () => void;
  error: string | null;
  registeredLocations: string[];
  compact?: boolean;
};

/**
 * Reusable add-location form used in both inline (compact) and full-row variants.
 * Replaces the 4 copy-pasted location forms from InventoryPage.
 */
export function AddLocationForm({
  newLocationName,
  onNameChange,
  onAdd,
  onCancel,
  error,
  compact,
}: AddLocationFormProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && newLocationName.trim()) {
      onAdd();
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  if (compact) {
    return (
      <span className="location-pill-add-form">
        <input
          type="text"
          className={`location-pill-add-input${error ? " field--error" : ""}`}
          value={newLocationName}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Location name..."
          autoFocus
        />
        <button
          type="button"
          className="location-pill-add-confirm"
          onClick={() => {
            if (!newLocationName.trim()) return;
            onAdd();
          }}
        >
          Add
        </button>
        <button
          type="button"
          className="location-pill-add-cancel"
          onClick={onCancel}
        >
          ×
        </button>
        {error ? (
          <span className="location-pill-add-error">{error}</span>
        ) : null}
      </span>
    );
  }

  // Full-row (mobile) variant
  return (
    <div className="location-add-row">
      <input
        type="text"
        className={`location-pill-add-input${error ? " field--error" : ""}`}
        value={newLocationName}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Location name..."
        autoFocus
      />
      <button
        type="button"
        className="location-pill-add-confirm"
        onClick={() => {
          if (!newLocationName.trim()) return;
          onAdd();
        }}
      >
        Add
      </button>
      <button
        type="button"
        className="location-pill-add-cancel"
        onClick={onCancel}
      >
        ×
      </button>
      {error ? (
        <span className="location-pill-add-error">{error}</span>
      ) : null}
    </div>
  );
}
