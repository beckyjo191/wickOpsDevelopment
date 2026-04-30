import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useToast } from "./shared/Toast";
import { LoadingState } from "./shared/LoadingState";
import {
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  type InventoryLocation,
  submitInventoryUsage,
  type InventoryColumn,
  type InventoryRow,
  type InventoryUsageEntryInput,
} from "../lib/inventoryApi";

type UsageEntry = {
  id: string;
  itemId: string;
  itemSearch: string;
  quantityUsed: string;
  notes: string;
  notesOpen: boolean;
  error: string;
};

type UsageGroup = {
  id: string;
  location: string;
  locationError: string;
  entries: UsageEntry[];
};

const DEFAULT_PROVISIONING_RETRY_MS = 2000;
import { pickLoadingLine } from "../lib/loadingLines";

const toDateInputValue = (value: unknown): string => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
};

const createUsageEntry = (): UsageEntry => ({
  id: crypto.randomUUID(),
  itemId: "",
  itemSearch: "",
  quantityUsed: "0",
  notes: "",
  notesOpen: false,
  error: "",
});

const createUsageGroup = (location = ""): UsageGroup => ({
  id: crypto.randomUUID(),
  location,
  locationError: "",
  entries: [createUsageEntry()],
});

const getItemDisplayName = (row: InventoryRow): string => {
  const name = String(row.values.itemName ?? "").trim();
  return name || `Item ${row.id.slice(0, 8)}`;
};

/* ── Custom autocomplete dropdown ──────────────────────────────────────── */

type AutocompleteOption = {
  id: string;
  name: string;
  quantity: number;
  expirationDate: string;
};

function ItemAutocomplete({
  inputId,
  options,
  value,
  selectedId,
  onSelect,
  onChange,
  onClear,
  disabled,
  placeholder,
  ariaInvalid,
  ariaDescribedBy,
}: {
  inputId?: string;
  options: AutocompleteOption[];
  value: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (value: string) => void;
  onClear: () => void;
  disabled: boolean;
  placeholder: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!value.trim() || selectedId) return options;
    const q = value.toLowerCase();
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, value, selectedId]);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [filtered.length, open]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const selectOption = (opt: AutocompleteOption) => {
    onSelect(opt.id);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && filtered[highlightIndex]) {
        selectOption(filtered[highlightIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const el = listRef.current.children[highlightIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const showDropdown = open && !selectedId && filtered.length > 0;

  return (
    <div className="usage-autocomplete" ref={wrapRef}>
      <div className="usage-autocomplete-input-wrap">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          className="usage-autocomplete-input"
          value={selectedId ? `${options.find((o) => o.id === selectedId)?.name ?? value}` : value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!selectedId) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          readOnly={!!selectedId}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-invalid={ariaInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          autoComplete="off"
        />
        {(selectedId || value) && (
          <button
            type="button"
            className="usage-autocomplete-clear"
            onClick={() => {
              onClear();
              setOpen(false);
              inputRef.current?.focus();
            }}
            disabled={disabled}
            aria-label="Clear selection"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {selectedId && (
        <span className="usage-autocomplete-badge">
          Qty: {options.find((o) => o.id === selectedId)?.quantity ?? "—"}
          {options.find((o) => o.id === selectedId)?.expirationDate
            ? ` · Exp ${options.find((o) => o.id === selectedId)?.expirationDate}`
            : ""}
        </span>
      )}
      {showDropdown && (
        <ul className="usage-autocomplete-list" ref={listRef} role="listbox">
          {filtered.map((opt, i) => (
            <li
              key={opt.id}
              className={`usage-autocomplete-option${i === highlightIndex ? " usage-autocomplete-option--hl" : ""}`}
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectOption(opt)}
            >
              <span className="usage-autocomplete-option-name">{opt.name}</span>
              <span className="usage-autocomplete-option-meta">
                Qty {opt.quantity}
                {opt.expirationDate ? ` · ${opt.expirationDate}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Quantity Input ────────────────────────────────────────────────────── */

function QtyStepper({
  inputId,
  value,
  max,
  onChange,
  disabled,
  ariaInvalid,
  ariaDescribedBy,
}: {
  inputId?: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
  disabled: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  return (
    <div className="usage-qty-stepper">
      <input
        id={inputId}
        type="number"
        className="usage-qty-input"
        inputMode="numeric"
        min={0}
        max={max}
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
        onBlur={(e) => { if (e.currentTarget.value === "") onChange("0"); }}
        disabled={disabled}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
      />
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────────── */

export function InventoryUsagePage({
  selectedLocationId,
  canEditInventory = false,
}: {
  /** Currently-scoped location id (or empty string for "All Locations").
   *  Used to seed the default UsageGroup so the user doesn't have to pick a
   *  location they're already viewing. */
  selectedLocationId?: string | null;
  /** Whether the current user can undo events from the Activity feed. The
   *  Activity-feed Undo button is gated by edit privileges, so the page's
   *  instructional copy only mentions Undo when the user can actually use it.
   *  Viewers can still submit usage; they just can't reverse it themselves. */
  canEditInventory?: boolean;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());
  const [, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  // The UsageGroup `location` field stores a locationId (UUID) post-restructure.
  // Empty string = unset. The picker resolves id→name for display.
  const [groups, setGroups] = useState<UsageGroup[]>([createUsageGroup(selectedLocationId ?? "")]);
  const [formError, setFormError] = useState("");

  const refreshInventoryRows = useCallback(
    async (opts?: { initial?: boolean; silent?: boolean }) => {
      const initial = !!opts?.initial;
      const silent = !!opts?.silent;
      if (initial) {
        setLoading(true);
        setLoadError("");
        setLoadingMessage(pickLoadingLine());
      }

      while (true) {
        try {
          const bootstrap = await loadInventoryBootstrap();
          setColumns(bootstrap.columns ?? []);
          setRows(bootstrap.items);
          setLocations(bootstrap.locations ?? []);
          if (initial) setLoading(false);
          return;
        } catch (err: any) {
          if (isInventoryProvisioningError(err)) {
            if (initial) {
              setLoadingMessage(pickLoadingLine());
            }
            const retryAfterMs =
              Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) : DEFAULT_PROVISIONING_RETRY_MS;
            await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
            if (!initial) return;
            continue;
          }
          if (!silent) {
            setLoadError(err?.message ?? "Failed to load usage form");
          }
          if (initial) {
            setLoading(false);
          }
          return;
        }
      }
    },
    [],
  );

  useEffect(() => {
    void refreshInventoryRows({ initial: true });
  }, [refreshInventoryRows]);

  useEffect(() => {
    if (loading) return;
    const interval = window.setInterval(() => {
      void refreshInventoryRows({ silent: true });
    }, 10000);
    const onFocus = () => {
      void refreshInventoryRows({ silent: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loading, refreshInventoryRows]);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  // Locations are first-class entities post-restructure. The picker shows
  // location names, but the UsageGroup.location field stores a locationId.
  const sortedLocations = useMemo(
    () =>
      [...locations].sort((a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
      ),
    [locations],
  );
  // Only show the picker when there are 2+ locations to pick from.
  const showLocationPicker = sortedLocations.length > 1;
  const singleLocationId = sortedLocations.length === 1 ? sortedLocations[0].id : null;

  // Auto-assign the only location to all groups when there's exactly one.
  useEffect(() => {
    if (!singleLocationId) return;
    setGroups((prev) =>
      prev.map((group) =>
        group.location === singleLocationId ? group : { ...group, location: singleLocationId },
      ),
    );
  }, [singleLocationId]);

  const getItemOptionsForLocation = useCallback(
    (locationId: string): AutocompleteOption[] =>
      rows
        .filter((row) => {
          if (!locationId.trim()) return false;
          return row.locationId === locationId;
        })
        .filter((row) => String(row.values.itemName ?? "").trim().length > 0)
        .slice()
        .sort((a, b) => getItemDisplayName(a).localeCompare(getItemDisplayName(b)))
        .map((row) => ({
          id: row.id,
          name: getItemDisplayName(row),
          quantity: Number(row.values.quantity ?? 0),
          expirationDate: toDateInputValue(row.values.expirationDate),
        })),
    [rows],
  );

  useEffect(() => {
    setGroups((prev) =>
      prev.map((group) => {
        const validIds = new Set(getItemOptionsForLocation(group.location).map((item) => item.id));
        const nextEntries = group.entries.map((entry) => {
          if (!entry.itemId || validIds.has(entry.itemId)) return entry;
          return { ...entry, itemId: "", itemSearch: "", notes: "", notesOpen: false, error: "" };
        });
        return { ...group, entries: nextEntries };
      }),
    );
  }, [getItemOptionsForLocation]);

  const clearErrors = () => {
    setFormError("");
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        locationError: "",
        entries: g.entries.map((e) => ({ ...e, error: "" })),
      })),
    );
  };

  const updateGroup = (groupId: string, patch: Partial<UsageGroup>) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return { ...group };
        const next = { ...group, ...patch };
        // When the location changes, clear entries whose items don't exist in the new location
        if ("location" in patch && patch.location !== group.location) {
          const validIds = new Set(
            getItemOptionsForLocation(patch.location ?? "").map((o) => o.id),
          );
          next.entries = next.entries.map((entry) => {
            if (!entry.itemId || validIds.has(entry.itemId)) return entry;
            return { ...entry, itemId: "", itemSearch: "", quantityUsed: "0", notes: "", notesOpen: false, error: "" };
          });
        }
        return next;
      }),
    );
  };

  const updateEntry = (groupId: string, entryId: string, patch: Partial<UsageEntry>) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          entries: group.entries.map((entry) =>
            entry.id === entryId ? { ...entry, ...patch } : entry,
          ),
        };
      }),
    );
  };

  const onSelectItem = (groupId: string, entryId: string, itemId: string) => {
    const options = getItemOptionsForLocation(groups.find((group) => group.id === groupId)?.location ?? "");
    const selectedOption = options.find((item) => item.id === itemId);
    updateEntry(groupId, entryId, {
      itemId,
      itemSearch: selectedOption?.name ?? "",
      error: "",
    });
  };

  const onItemSearchChange = (groupId: string, entryId: string, value: string) => {
    updateEntry(groupId, entryId, {
      itemSearch: value,
      itemId: "",
      error: "",
    });
  };

  const addLine = (groupId: string) => {
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId
          ? { ...group, entries: [...group.entries, createUsageEntry()] }
          : group,
      ),
    );
  };

  const removeLine = (groupId: string, entryId: string) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return group;
        if (group.entries.length <= 1) return group;
        return { ...group, entries: group.entries.filter((entry) => entry.id !== entryId) };
      }),
    );
  };

  const addLocationSection = () => {
    setGroups((prev) => [...prev, createUsageGroup()]);
  };

  const removeLocationSection = (groupId: string) => {
    setGroups((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((group) => group.id !== groupId);
    });
  };

  const onSubmit = async () => {
    if (submitting) return;
    clearErrors();
    const normalized: InventoryUsageEntryInput[] = [];
    let hasError = false;

    const nextGroups = groups.map((group) => {
      let locationError = "";

      if (showLocationPicker && !group.location.trim()) {
        locationError = "Select a location";
        hasError = true;
      }

      const nextEntries = group.entries.map((entry) => {
        const itemId = entry.itemId.trim();
        const quantityUsed = Number(entry.quantityUsed);
        const notes = entry.notes.trim();
        const isEmpty =
          !itemId &&
          (entry.quantityUsed.trim() === "" || Number(entry.quantityUsed) === 0) &&
          notes === "";
        if (isEmpty) return entry;

        let error = "";
        if (!itemId) {
          error = "Select an item";
          hasError = true;
        } else if (!Number.isFinite(quantityUsed) || quantityUsed < 0) {
          error = "Enter a valid quantity";
          hasError = true;
        } else if (quantityUsed === 0 && !notes) {
          error = "Enter quantity used";
          hasError = true;
        } else {
          const row = rowById.get(itemId);
          if (!row) {
            error = "Item not found";
            hasError = true;
          } else {
            const available = Number(row.values.quantity ?? 0);
            if (!Number.isFinite(available) || quantityUsed > available) {
              error = `Exceeds available (${available})`;
              hasError = true;
            } else {
              normalized.push({
                itemId,
                quantityUsed,
                notes: notes || undefined,
              });
            }
          }
        }
        return { ...entry, error };
      });

      return { ...group, locationError, entries: nextEntries };
    });

    setGroups(nextGroups);

    if (hasError) return;

    if (normalized.length === 0) {
      setFormError("Add at least one item to submit.");
      return;
    }

    const submittedLines = normalized.map((entry) => {
      const row = rowById.get(entry.itemId);
      const name = row ? getItemDisplayName(row) : entry.itemId;
      return `${name} -${entry.quantityUsed}`;
    });

    setSubmitting(true);
    try {
      await submitInventoryUsage(normalized);
      setGroups([createUsageGroup()]);
      const itemList = submittedLines.join(", ");
      toast.success(
        canEditInventory
          ? `Logged: ${itemList} — quantities updated. Undo from the Activity feed if needed.`
          : `Logged: ${itemList} — quantities updated.`,
      );
      // Re-fetch inventory so the in-form quantities reflect the new totals.
      void refreshInventoryRows({ silent: true });
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to submit usage");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <section className="app-content">
        <LoadingState variant="card" message={loadingMessage} />
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
      <div className="app-card usage-card">
        <header className="usage-header">
          <h2 className="usage-title">Log Usage</h2>
          <p className="usage-instructions">
            {showLocationPicker && <>Select a <strong>location</strong>, then </>}
            Search for an item, enter the quantity used, and hit <strong>Submit Usage</strong>.
            {" "}Need to log more? Tap <strong>+ Add Item</strong> to add another line.
            {" "}Submitting decrements inventory immediately
            {canEditInventory ? (
              <> — if you make a mistake, the event has an
                <strong> Undo</strong> button in the Activity feed.</>
            ) : (
              <>. Ask an editor or admin if you need to reverse a submission.</>
            )}
          </p>
        </header>

        {formError && (
          <p className="field-error" role="alert">{formError}</p>
        )}

        <div className="usage-form-list">
          {groups.map((group, groupIndex) => {
            const itemOptions = getItemOptionsForLocation(group.location);
            return (
              <section className="usage-form-section" key={group.id}>
                {showLocationPicker && (
                  <div className="usage-location-wrap">
                    <div className="usage-location-field">
                      <label className="field-label" htmlFor={`usage-location-select-${group.id}`}>
                        Location
                      </label>
                      <select
                        id={`usage-location-select-${group.id}`}
                        className={`usage-location-select${group.locationError ? " field--error" : ""}`}
                        value={group.location}
                        onChange={(event) => updateGroup(group.id, { location: event.target.value, locationError: "" })}
                        disabled={submitting}
                        aria-invalid={!!group.locationError || undefined}
                        aria-describedby={group.locationError ? `usage-location-error-${group.id}` : undefined}
                      >
                        <option value="">Select location...</option>
                        {sortedLocations.map((loc) => (
                          <option key={loc.id} value={loc.id}>
                            {loc.name}
                          </option>
                        ))}
                      </select>
                      {group.locationError && (
                        <p id={`usage-location-error-${group.id}`} className="field-error">{group.locationError}</p>
                      )}
                    </div>
                    {groups.length > 1 && (
                      <button
                        type="button"
                        className="usage-remove-section-btn"
                        onClick={() => removeLocationSection(group.id)}
                        disabled={submitting}
                        aria-label="Remove this location section"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}

                <div className="usage-entries">
                  {group.entries.map((entry) => {
                    const selectedItem = itemOptions.find((o) => o.id === entry.itemId);
                    const maxQty = selectedItem?.quantity ?? 9999;
                    return (
                      <div className={`usage-entry${entry.error ? " usage-entry--error" : ""}`} key={entry.id}>
                        <div className="usage-entry-main">
                          <div className="usage-entry-item">
                            <label className="field-label" htmlFor={`usage-item-${group.id}-${entry.id}`}>Item</label>
                            <ItemAutocomplete
                              inputId={`usage-item-${group.id}-${entry.id}`}
                              options={itemOptions}
                              value={entry.itemSearch}
                              selectedId={entry.itemId}
                              onSelect={(id) => onSelectItem(group.id, entry.id, id)}
                              onChange={(v) => onItemSearchChange(group.id, entry.id, v)}
                              onClear={() =>
                                updateEntry(group.id, entry.id, {
                                  itemId: "",
                                  itemSearch: "",
                                  error: "",
                                })
                              }
                              disabled={submitting || (showLocationPicker ? !group.location : false)}
                              placeholder="Search items..."
                              ariaInvalid={!!entry.error}
                              ariaDescribedBy={entry.error ? `usage-entry-error-${group.id}-${entry.id}` : undefined}
                            />
                          </div>
                          <div className="usage-entry-qty">
                            <label className="field-label" htmlFor={`usage-qty-${group.id}-${entry.id}`}>Qty Used</label>
                            <QtyStepper
                              inputId={`usage-qty-${group.id}-${entry.id}`}
                              value={entry.quantityUsed}
                              max={maxQty}
                              onChange={(v) => updateEntry(group.id, entry.id, { quantityUsed: v, error: "" })}
                              disabled={submitting}
                              ariaInvalid={!!entry.error}
                              ariaDescribedBy={entry.error ? `usage-entry-error-${group.id}-${entry.id}` : undefined}
                            />
                          </div>
                          {group.entries.length > 1 && (
                            <button
                              type="button"
                              className="usage-remove-line-btn"
                              onClick={() => removeLine(group.id, entry.id)}
                              disabled={submitting}
                              aria-label="Remove line"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>

                        {(
                          <div className="usage-entry-notes">
                            {!entry.notesOpen && entry.notes.trim().length === 0 ? (
                              <button
                                type="button"
                                className="usage-add-note-btn"
                                onClick={() => updateEntry(group.id, entry.id, { notesOpen: true })}
                                disabled={submitting}
                              >
                                <Plus size={14} /> Add note
                              </button>
                            ) : (
                              <div className="usage-note-input-wrap">
                                <input
                                  type="text"
                                  className="usage-note-input"
                                  value={entry.notes}
                                  onChange={(event) =>
                                    updateEntry(group.id, entry.id, { notes: event.target.value, notesOpen: true })
                                  }
                                  onBlur={() => {
                                    setTimeout(() => {
                                      setGroups((prev) =>
                                        prev.map((g) => {
                                          if (g.id !== group.id) return g;
                                          return {
                                            ...g,
                                            entries: g.entries.map((row) => {
                                              if (row.id !== entry.id) return row;
                                              if (row.notes.trim().length > 0) return row;
                                              return { ...row, notesOpen: false };
                                            }),
                                          };
                                        }),
                                      );
                                    }, 0);
                                  }}
                                  disabled={submitting}
                                  placeholder="Job, room, reason..."
                                  autoFocus
                                />
                                {entry.notes.trim().length > 0 && (
                                  <button
                                    type="button"
                                    className="usage-note-clear"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() =>
                                      updateEntry(group.id, entry.id, { notes: "", notesOpen: false })
                                    }
                                    disabled={submitting}
                                    aria-label="Clear note"
                                  >
                                    <X size={14} />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {entry.error && (
                          <p id={`usage-entry-error-${group.id}-${entry.id}`} className="field-error">{entry.error}</p>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="usage-add-line-btn"
                  onClick={() => addLine(group.id)}
                  disabled={submitting}
                >
                  <Plus size={14} /> Add Item
                </button>

                {showLocationPicker && groupIndex < groups.length - 1 && <hr className="usage-section-divider" />}
              </section>
            );
          })}
        </div>

        <div className="usage-submit-area">
          {showLocationPicker && (
            <button
              type="button"
              className="button button-secondary usage-add-location-btn"
              onClick={addLocationSection}
              disabled={submitting}
            >
              <Plus size={14} /> Add Location
            </button>
          )}
          <button
            type="button"
            className="button button-primary usage-submit-btn"
            onClick={() => void onSubmit()}
            disabled={submitting}
          >
            {submitting ? "Submitting..." : "Submit Usage"}
          </button>
        </div>
      </div>
    </section>
  );
}
