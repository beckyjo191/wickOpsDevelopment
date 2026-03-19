import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isInventoryProvisioningError,
  listPendingSubmissions,
  loadInventoryBootstrap,
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
import { pickUsageLine, pickProvisioningLine } from "../lib/loadingLines";

const formatActivityTime = (isoString: string): string => {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
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

const normalizeLooseKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

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
  quantityUsed: "",
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
  options,
  value,
  selectedId,
  onSelect,
  onChange,
  onClear,
  disabled,
  placeholder,
}: {
  options: AutocompleteOption[];
  value: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (value: string) => void;
  onClear: () => void;
  disabled: boolean;
  placeholder: string;
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
            ×
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

/* ── Quantity Stepper ──────────────────────────────────────────────────── */

function QtyStepper({
  value,
  max,
  onChange,
  disabled,
}: {
  value: string;
  max: number;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const num = Number(value) || 0;
  return (
    <div className="usage-qty-stepper">
      <button
        type="button"
        className="usage-qty-btn"
        onClick={() => onChange(String(Math.max(0, num - 1)))}
        disabled={disabled || num <= 0}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <input
        type="number"
        className="usage-qty-input"
        inputMode="numeric"
        min={0}
        max={max}
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="0"
      />
      <button
        type="button"
        className="usage-qty-btn"
        onClick={() => onChange(String(num + 1))}
        disabled={disabled || num >= max}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────────── */

export function InventoryUsagePage({ selectedLocation }: { selectedLocation?: string | null }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(() => pickUsageLine());
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [groups, setGroups] = useState<UsageGroup[]>([createUsageGroup(selectedLocation ?? "")]);
  const [recentSubmissions, setRecentSubmissions] = useState<import("../lib/inventoryApi").PendingSubmission[]>([]);
  const [formError, setFormError] = useState("");

  const refreshInventoryRows = useCallback(
    async (opts?: { initial?: boolean; silent?: boolean }) => {
      const initial = !!opts?.initial;
      const silent = !!opts?.silent;
      if (initial) {
        setLoading(true);
        setLoadError("");
        setLoadingMessage(pickUsageLine());
      }

      while (true) {
        try {
          const bootstrap = await loadInventoryBootstrap();
          setColumns(bootstrap.columns ?? []);
          setRows(bootstrap.items);
          if (initial) setLoading(false);
          return;
        } catch (err: any) {
          if (isInventoryProvisioningError(err)) {
            if (initial) {
              setLoadingMessage(pickProvisioningLine());
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

  const refreshSubmissions = useCallback(() => {
    listPendingSubmissions()
      .then((subs) => setRecentSubmissions(subs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshSubmissions();
  }, [refreshSubmissions]);

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

  const locationKey = useMemo(() => {
    const fromColumns = columns.find((column) => {
      const keyLoose = normalizeLooseKey(String(column.key ?? ""));
      const labelLoose = normalizeLooseKey(String(column.label ?? ""));
      return keyLoose === "location" || labelLoose === "location";
    });
    if (fromColumns) return fromColumns.key;

    const rowKeys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row.values ?? {})) {
        rowKeys.add(key);
      }
    }
    for (const key of rowKeys) {
      if (normalizeLooseKey(key) === "location") return key;
    }
    return null;
  }, [columns, rows]);

  const effectiveLocationKey = locationKey;

  const locationValues = useMemo(() => {
    if (!effectiveLocationKey) return [] as string[];
    return Array.from(
      new Set(
        rows
          .map((row) => String(row.values[effectiveLocationKey] ?? "").trim())
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [effectiveLocationKey, rows]);

  // Only show the location picker when there are 2+ distinct locations
  const showLocationPicker = effectiveLocationKey !== null && locationValues.length > 1;
  const singleLocation = effectiveLocationKey !== null && locationValues.length === 1 ? locationValues[0] : null;

  // Auto-assign the single location to all groups when there's exactly one
  useEffect(() => {
    if (!singleLocation) return;
    setGroups((prev) =>
      prev.map((group) =>
        group.location === singleLocation ? group : { ...group, location: singleLocation },
      ),
    );
  }, [singleLocation]);

  const getItemOptionsForLocation = useCallback(
    (location: string): AutocompleteOption[] =>
      rows
        .filter((row) => {
          if (!effectiveLocationKey) return true;
          if (!location.trim()) return false;
          return String(row.values[effectiveLocationKey] ?? "").trim() === location;
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
    [rows, effectiveLocationKey],
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
            return { ...entry, itemId: "", itemSearch: "", quantityUsed: "", notes: "", notesOpen: false, error: "" };
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
        const isEmpty = !itemId && entry.quantityUsed.trim() === "" && notes === "";
        if (isEmpty) return entry;

        let error = "";
        if (!itemId) {
          error = "Select an item";
          hasError = true;
        } else if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
          error = "Enter a quantity greater than 0";
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
                location: effectiveLocationKey ? group.location : undefined,
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
      return `${name} ×${entry.quantityUsed}`;
    });

    setSubmitting(true);
    setFeedback(null);
    try {
      await submitInventoryUsage(normalized);
      setGroups([createUsageGroup()]);
      const itemList = submittedLines.join(", ");
      setFeedback({ type: "success", message: `Submitted: ${itemList} — pending approval.` });
      refreshSubmissions();
    } catch (err: any) {
      setFeedback({ type: "error", message: err?.message ?? "Failed to submit usage" });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <section className="app-content">
        <div className="app-card app-loading-card">
          <span className="app-spinner" aria-hidden="true" />
          <span>{loadingMessage}</span>
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

  const recentActivity = recentSubmissions
    .filter((s) => s.status !== "rejected")
    .slice(0, 1);

  return (
    <section className="app-content">
      <div className="app-card usage-card">
        <header className="usage-header">
          <h2 className="usage-title">Log Usage</h2>
        </header>

        {feedback && (
          <div className={`usage-banner usage-banner--${feedback.type}`} role="status">
            <span className="usage-banner-icon">{feedback.type === "success" ? "✓" : "!"}</span>
            <span className="usage-banner-text">{feedback.message}</span>
            <button
              type="button"
              className="usage-banner-dismiss"
              onClick={() => setFeedback(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {formError && (
          <div className="usage-inline-error usage-form-error" role="alert">{formError}</div>
        )}

        <div className="usage-form-list">
          {groups.map((group, groupIndex) => {
            const itemOptions = getItemOptionsForLocation(group.location);
            return (
              <section className="usage-form-section" key={group.id}>
                {showLocationPicker && (
                  <div className="usage-location-wrap">
                    <div className="usage-location-field">
                      <label className="usage-field-label" htmlFor={`usage-location-select-${group.id}`}>
                        Location
                      </label>
                      <select
                        id={`usage-location-select-${group.id}`}
                        className={`usage-location-select${group.locationError ? " usage-input--error" : ""}`}
                        value={group.location}
                        onChange={(event) => updateGroup(group.id, { location: event.target.value, locationError: "" })}
                        disabled={submitting}
                      >
                        <option value="">Select location...</option>
                        {locationValues.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      {group.locationError && (
                        <span className="usage-inline-error">{group.locationError}</span>
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
                        ×
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
                            <label className="usage-field-label">Item</label>
                            <ItemAutocomplete
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
                            />
                          </div>
                          <div className="usage-entry-qty">
                            <label className="usage-field-label">Qty Used</label>
                            <QtyStepper
                              value={entry.quantityUsed}
                              max={maxQty}
                              onChange={(v) => updateEntry(group.id, entry.id, { quantityUsed: v, error: "" })}
                              disabled={submitting}
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
                              ×
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
                                + Add note
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
                                    ×
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {entry.error && (
                          <span className="usage-inline-error">{entry.error}</span>
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
                  + Add Item
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
              + Add Location
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

        {recentActivity.length > 0 && (
          <div className="usage-activity">
            <h3 className="usage-activity-title">Recent Checkouts</h3>
            <ul className="usage-activity-list">
              {recentActivity.map((sub) => {
                let entries: import("../lib/inventoryApi").PendingEntry[] = [];
                try { entries = JSON.parse(sub.entriesJson); } catch { entries = []; }
                const label = entries.map((e) => `${e.itemName} ×${e.quantityUsed}`).join(", ");
                const when = formatActivityTime(sub.submittedAt);
                return (
                  <li key={sub.id} className="usage-activity-row">
                    <span className="usage-activity-who">{sub.submittedByName || sub.submittedByEmail}</span>
                    <span className="usage-activity-items">{label}</span>
                    <span className="usage-activity-when">{when}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
