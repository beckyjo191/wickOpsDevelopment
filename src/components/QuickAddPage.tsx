import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  saveInventoryItems,
  type InventoryColumn,
  type InventoryRow,
} from "../lib/inventoryApi";

/* ── Types ─────────────────────────────────────────────────────────────── */

type RestockEntry = {
  id: string;
  itemId: string;
  itemSearch: string;
  quantityToAdd: string;
  expirationDate: string;
  needsExpiration: boolean;
  error: string;
};

type RestockGroup = {
  id: string;
  location: string;
  locationError: string;
  entries: RestockEntry[];
};

type AutocompleteOption = {
  id: string;
  name: string;
  quantity: number;
};

/* ── Helpers ───────────────────────────────────────────────────────────── */

const DEFAULT_PROVISIONING_RETRY_MS = 2000;
import { pickLoadingLine } from "../lib/loadingLines";

const normalizeLooseKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const getItemDisplayName = (row: InventoryRow): string => {
  const name = String(row.values.itemName ?? "").trim();
  return name || `Item ${row.id.slice(0, 8)}`;
};

const createRestockEntry = (): RestockEntry => ({
  id: crypto.randomUUID(),
  itemId: "",
  itemSearch: "",
  quantityToAdd: "",
  expirationDate: "",
  needsExpiration: false,
  error: "",
});

const createRestockGroup = (location = ""): RestockGroup => ({
  id: crypto.randomUUID(),
  location,
  locationError: "",
  entries: [createRestockEntry()],
});

/* ── Autocomplete (no expiration display) ──────────────────────────────── */

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
          Current stock: {options.find((o) => o.id === selectedId)?.quantity ?? "—"}
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
              <span className="usage-autocomplete-option-meta">Qty {opt.quantity}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Quantity Stepper (no max cap) ─────────────────────────────────────── */

function QtyStepper({
  value,
  onChange,
  disabled,
}: {
  value: string;
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
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        disabled={disabled}
        placeholder="0"
      />
      <button
        type="button"
        className="usage-qty-btn"
        onClick={() => onChange(String(num + 1))}
        disabled={disabled}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

/* ── Main component ────────────────────────────────────────────────────── */

export function QuickAddPage({ selectedLocation }: { selectedLocation?: string | null }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(() => pickLoadingLine());
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [groups, setGroups] = useState<RestockGroup[]>([createRestockGroup(selectedLocation ?? "")]);
  const [formError, setFormError] = useState("");

  /* ── Data loading ── */

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
            setLoadError(err?.message ?? "Failed to load restock form");
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

  /* ── Derived state ── */

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const expirationDateKey = useMemo(() => {
    const fromColumns = columns.find((column) => {
      const keyLoose = normalizeLooseKey(String(column.key ?? ""));
      const labelLoose = normalizeLooseKey(String(column.label ?? ""));
      return keyLoose === "expirationdate" || labelLoose === "expirationdate";
    });
    if (fromColumns) return fromColumns.key;

    const rowKeys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row.values ?? {})) {
        rowKeys.add(key);
      }
    }
    for (const key of rowKeys) {
      if (normalizeLooseKey(key) === "expirationdate") return key;
    }
    return null;
  }, [columns, rows]);

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

  const locationValues = useMemo(() => {
    if (!locationKey) return [] as string[];
    return Array.from(
      new Set(
        rows
          .map((row) => String(row.values[locationKey] ?? "").trim())
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [locationKey, rows]);

  const showLocationPicker = locationKey !== null && locationValues.length > 1;
  const singleLocation = locationKey !== null && locationValues.length === 1 ? locationValues[0] : null;

  useEffect(() => {
    if (!singleLocation) return;
    setGroups((prev) =>
      prev.map((group) =>
        group.location === singleLocation ? group : { ...group, location: singleLocation },
      ),
    );
  }, [singleLocation]);



  const getItemOptionsForLocation = useCallback(
    (location: string): AutocompleteOption[] => {
      const filtered = rows
        .filter((row) => {
          if (!locationKey) return true;
          if (!location.trim()) return false;
          return String(row.values[locationKey] ?? "").trim() === location;
        })
        .filter((row) => String(row.values.itemName ?? "").trim().length > 0);

      // Deduplicate by name. Aggregate only active (non-retired) qty, but include
      // retired rows so fully-retired items stay discoverable for restocking.
      // Use a non-retired row as rep when one exists; fall back to retired if all are retired.
      const nameMap = new Map<string, { totalQty: number; rep: InventoryRow; hasActive: boolean }>();
      for (const row of filtered) {
        const name = getItemDisplayName(row);
        const isRetired = Boolean(row.values.retiredAt);
        const qty = isRetired ? 0 : Number(row.values.quantity ?? 0);
        const existing = nameMap.get(name);
        if (!existing) {
          nameMap.set(name, { totalQty: qty, rep: row, hasActive: !isRetired });
        } else {
          existing.totalQty += qty;
          // Prefer a non-retired row as the representative template for new rows
          if (!isRetired && (!existing.hasActive || Number(row.values.quantity ?? 0) < Number(existing.rep.values.quantity ?? 0))) {
            existing.rep = row;
            existing.hasActive = true;
          }
        }
      }

      return Array.from(nameMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { totalQty, rep }]) => ({
          id: rep.id,
          name,
          quantity: totalQty, // active qty only; 0 means all lots retired but item still stocked
        }));
    },
    [rows, locationKey],
  );

  // Clear stale selections when location changes or rows refresh
  useEffect(() => {
    setGroups((prev) =>
      prev.map((group) => {
        const validIds = new Set(getItemOptionsForLocation(group.location).map((item) => item.id));
        const nextEntries = group.entries.map((entry) => {
          if (!entry.itemId || validIds.has(entry.itemId)) return entry;
          return { ...entry, itemId: "", itemSearch: "", needsExpiration: false, expirationDate: "", error: "" };
        });
        return { ...group, entries: nextEntries };
      }),
    );
  }, [getItemOptionsForLocation]);

  /* ── Group / entry helpers ── */

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

  const updateGroup = (groupId: string, patch: Partial<RestockGroup>) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return group;
        const next = { ...group, ...patch };
        if ("location" in patch && patch.location !== group.location) {
          const validIds = new Set(
            getItemOptionsForLocation(patch.location ?? "").map((o) => o.id),
          );
          next.entries = next.entries.map((entry) => {
            if (!entry.itemId || validIds.has(entry.itemId)) return entry;
            return { ...entry, itemId: "", itemSearch: "", quantityToAdd: "", needsExpiration: false, expirationDate: "", error: "" };
          });
        }
        return next;
      }),
    );
  };

  const updateEntry = (groupId: string, entryId: string, patch: Partial<RestockEntry>) => {
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
    const row = rowById.get(itemId);
    const name = row ? getItemDisplayName(row) : "";
    const hasExpiration =
      !!expirationDateKey &&
      !!row &&
      String(row.values[expirationDateKey] ?? "").trim().length > 0;
    updateEntry(groupId, entryId, {
      itemId,
      itemSearch: name,
      needsExpiration: hasExpiration,
      expirationDate: "",
      error: "",
    });
  };

  const onItemSearchChange = (groupId: string, entryId: string, value: string) => {
    updateEntry(groupId, entryId, {
      itemSearch: value,
      itemId: "",
      needsExpiration: false,
      expirationDate: "",
      error: "",
    });
  };

  const addLine = (groupId: string) => {
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId
          ? { ...group, entries: [...group.entries, createRestockEntry()] }
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
    setGroups((prev) => [...prev, createRestockGroup()]);
  };

  const removeLocationSection = (groupId: string) => {
    setGroups((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((group) => group.id !== groupId);
    });
  };

  /* ── Submit ── */

  const onSubmit = async () => {
    if (submitting) return;
    clearErrors();

    // Refresh to get latest quantities before saving
    await refreshInventoryRows({ silent: true });

    let hasError = false;

    type ValidEntry = {
      itemId: string;
      quantityToAdd: number;
      expirationDate: string;
      needsExpiration: boolean;
    };
    const validEntries: ValidEntry[] = [];

    const nextGroups = groups.map((group) => {
      let locationError = "";

      if (showLocationPicker && !group.location.trim()) {
        locationError = "Select a location";
        hasError = true;
      }

      const nextEntries = group.entries.map((entry) => {
        const itemId = entry.itemId.trim();
        const quantityToAdd = Number(entry.quantityToAdd);
        const isEmpty = !itemId && entry.quantityToAdd.trim() === "";
        if (isEmpty) return entry;

        let error = "";
        if (!itemId) {
          error = "Select an item";
          hasError = true;
        } else if (!Number.isFinite(quantityToAdd) || quantityToAdd <= 0) {
          error = "Enter a quantity greater than 0";
          hasError = true;
        } else if (entry.needsExpiration && !entry.expirationDate) {
          error = "Enter an expiration date";
          hasError = true;
        } else {
          const row = rowById.get(itemId);
          if (!row) {
            error = "Item not found";
            hasError = true;
          } else {
            validEntries.push({
              itemId,
              quantityToAdd,
              expirationDate: entry.expirationDate,
              needsExpiration: entry.needsExpiration,
            });
          }
        }
        return { ...entry, error };
      });

      return { ...group, locationError, entries: nextEntries };
    });

    setGroups(nextGroups);
    if (hasError) return;

    if (validEntries.length === 0) {
      setFormError("Add at least one item to restock.");
      return;
    }

    // Merge duplicate non-expiration entries for the same item
    const mergedMap = new Map<string, ValidEntry>();
    const expirationEntries: ValidEntry[] = [];

    for (const entry of validEntries) {
      if (entry.needsExpiration) {
        expirationEntries.push(entry);
      } else {
        const existing = mergedMap.get(entry.itemId);
        if (existing) {
          existing.quantityToAdd += entry.quantityToAdd;
        } else {
          mergedMap.set(entry.itemId, { ...entry });
        }
      }
    }

    // Build rows to save
    const rowsToSave: InventoryRow[] = [];
    const maxPosition = rows.length > 0 ? Math.max(...rows.map((r) => r.position)) : 0;
    let newRowOffset = 0;

    // Non-expiration: increment existing row quantity
    for (const entry of mergedMap.values()) {
      const originalRow = rowById.get(entry.itemId);
      if (!originalRow) continue;
      const currentQty = Number(originalRow.values.quantity ?? 0);
      rowsToSave.push({
        ...originalRow,
        values: {
          ...originalRow.values,
          quantity: currentQty + entry.quantityToAdd,
        },
      });
    }

    // Expiration: always create a new row for each incoming batch
    for (const entry of expirationEntries) {
      const originalRow = rowById.get(entry.itemId);
      if (!originalRow) continue;
      newRowOffset++;
      rowsToSave.push({
        id: crypto.randomUUID(),
        position: maxPosition + newRowOffset,
        values: {
          ...originalRow.values,
          quantity: entry.quantityToAdd,
          ...(expirationDateKey ? { [expirationDateKey]: entry.expirationDate } : {}),
          orderedAt: null,
          retiredAt: null,
          retiredQty: null,
        },
      });
    }

    const restockedNames = new Set(
      validEntries
        .map((e) => String(rowById.get(e.itemId)?.values.itemName ?? "").trim())
        .filter(Boolean),
    );

    // Build summary for feedback
    const summaryLines = validEntries.map((entry) => {
      const row = rowById.get(entry.itemId);
      const name = row ? getItemDisplayName(row) : entry.itemId;
      return `${name} +${entry.quantityToAdd}`;
    });

    setSubmitting(true);
    setFeedback(null);
    try {
      await saveInventoryItems(rowsToSave, []);
      // After saving, fetch fresh data and clear orderedAt on any row whose
      // item name matches something we just restocked (name match only)
      try {
        const fresh = await loadInventoryBootstrap();
        const savedIds = new Set(rowsToSave.map((r) => r.id));
        const toUnorder = fresh.items.filter(
          (r) =>
            r.values.orderedAt &&
            !savedIds.has(r.id) &&
            restockedNames.has(String(r.values.itemName ?? "").trim()),
        );
        if (toUnorder.length > 0) {
          await saveInventoryItems(
            toUnorder.map((r) => ({ ...r, values: { ...r.values, orderedAt: null } })),
            [],
          );
        }
      } catch {
        // Non-critical — ordered list will clear on next refresh
      }
      setGroups([createRestockGroup(singleLocation ?? "")]);
      setFeedback({ type: "success", message: `Restocked: ${summaryLines.join(", ")}` });
      void refreshInventoryRows({ silent: true });
    } catch (err: any) {
      setFeedback({ type: "error", message: err?.message ?? "Failed to save restock" });
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Render ── */

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

  return (
    <section className="app-content">
      <div className="app-card usage-card quickadd-form">
        <header className="usage-header">
          <h2 className="usage-title">Quick Add / Restock</h2>
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
                      <label className="usage-field-label" htmlFor={`quickadd-location-select-${group.id}`}>
                        Location
                      </label>
                      <select
                        id={`quickadd-location-select-${group.id}`}
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
                  {group.entries.map((entry) => (
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
                                needsExpiration: false,
                                expirationDate: "",
                                error: "",
                              })
                            }
                            disabled={submitting || (showLocationPicker ? !group.location : false)}
                            placeholder="Search items..."
                          />
                        </div>
                        <div className="usage-entry-qty">
                          <label className="usage-field-label">Qty to Add</label>
                          <QtyStepper
                            value={entry.quantityToAdd}
                            onChange={(v) => updateEntry(group.id, entry.id, { quantityToAdd: v, error: "" })}
                            disabled={submitting}
                          />
                        </div>
                        {entry.needsExpiration && (
                          <div className="quickadd-entry-expiration">
                            <label className="usage-field-label">Expiration Date</label>
                            <input
                              type="date"
                              className="quickadd-date-input"
                              value={entry.expirationDate}
                              onChange={(e) =>
                                updateEntry(group.id, entry.id, { expirationDate: e.target.value, error: "" })
                              }
                              disabled={submitting}
                            />
                          </div>
                        )}
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

                      {entry.error && (
                        <span className="usage-inline-error">{entry.error}</span>
                      )}
                    </div>
                  ))}
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
            {submitting ? "Saving..." : "Save Restock"}
          </button>
        </div>
      </div>
    </section>
  );
}
