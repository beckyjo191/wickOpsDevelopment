import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  submitInventoryUsage,
  type InventoryColumn,
  type InventoryRow,
  type InventoryUsageEntryInput,
} from "../lib/inventoryApi";
import type { UsageFormPreferences } from "../lib/usageFormPreferences";

type UsageEntry = {
  id: string;
  itemId: string;
  itemSearch: string;
  quantityUsed: string;
  notes: string;
  notesOpen: boolean;
};

type UsageGroup = {
  id: string;
  location: string;
  entries: UsageEntry[];
};

const DEFAULT_PROVISIONING_RETRY_MS = 2000;
const LOADING_LINES = [
  "Gathering usage form parts...",
  "Counting what can be used...",
  "Lining up item bins...",
];
const PROVISIONING_LINES = [
  "Preparing inventory storage...",
  "Waiting for rows to report in...",
  "Syncing quantity gears...",
];

const pickRandom = (items: string[]): string =>
  items[Math.floor(Math.random() * items.length)] ?? "Loading usage form...";

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
});

const createUsageGroup = (location = ""): UsageGroup => ({
  id: crypto.randomUUID(),
  location,
  entries: [createUsageEntry()],
});

const getItemDisplayName = (row: InventoryRow): string => {
  const name = String(row.values.itemName ?? "").trim();
  return name || `Item ${row.id.slice(0, 8)}`;
};

type InventoryUsagePageProps = {
  usageFormPreferences: UsageFormPreferences;
};

export function InventoryUsagePage({ usageFormPreferences }: InventoryUsagePageProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loadingMessage, setLoadingMessage] = useState(() => pickRandom(LOADING_LINES));
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [groups, setGroups] = useState<UsageGroup[]>([createUsageGroup()]);

  const refreshInventoryRows = useCallback(
    async (opts?: { initial?: boolean; silent?: boolean }) => {
      const initial = !!opts?.initial;
      const silent = !!opts?.silent;
      if (initial) {
        setLoading(true);
        setLoadError("");
        setLoadingMessage(pickRandom(LOADING_LINES));
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
              setLoadingMessage(pickRandom(PROVISIONING_LINES));
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

  const notesKey = useMemo(() => {
    const fromColumns = columns.find((column) => {
      const keyLoose = normalizeLooseKey(String(column.key ?? ""));
      const labelLoose = normalizeLooseKey(String(column.label ?? ""));
      return keyLoose === "notes" || keyLoose === "note" || labelLoose === "notes" || labelLoose === "note";
    });
    if (fromColumns) return fromColumns.key;

    const rowKeys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row.values ?? {})) {
        rowKeys.add(key);
      }
    }
    for (const key of rowKeys) {
      const loose = normalizeLooseKey(key);
      if (loose === "notes" || loose === "note") return key;
    }
    return null;
  }, [columns, rows]);

  const isUsageColumnEnabled = useCallback(
    (columnKey: string | null): boolean => {
      if (!columnKey) return false;
      if (usageFormPreferences.mode === "all") return true;
      const normalized = normalizeLooseKey(columnKey);
      return usageFormPreferences.enabledColumnKeys.includes(normalized);
    },
    [usageFormPreferences.enabledColumnKeys, usageFormPreferences.mode],
  );

  const effectiveLocationKey = isUsageColumnEnabled(locationKey) ? locationKey : null;
  const effectiveNotesKey = isUsageColumnEnabled(notesKey) ? notesKey : null;

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

  const getItemOptionsForLocation = useCallback(
    (location: string) =>
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
          return { ...entry, itemId: "", itemSearch: "", notes: "", notesOpen: false };
        });
        return { ...group, entries: nextEntries };
      }),
    );
  }, [getItemOptionsForLocation]);

  const updateGroup = (groupId: string, patch: Partial<UsageGroup>) => {
    setGroups((prev) => prev.map((group) => (group.id === groupId ? { ...group, ...patch } : group)));
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

  const buildItemLabel = (item: { name: string; quantity: number; expirationDate: string }): string => {
    const exp = item.expirationDate ? ` | exp ${item.expirationDate}` : "";
    return `${item.name}${exp} (${item.quantity})`;
  };

  const onSelectItem = (groupId: string, entryId: string, itemId: string) => {
    const options = getItemOptionsForLocation(groups.find((group) => group.id === groupId)?.location ?? "");
    const selectedOption = options.find((item) => item.id === itemId);
    updateEntry(groupId, entryId, {
      itemId,
      itemSearch: selectedOption ? buildItemLabel(selectedOption) : "",
    });
  };

  const onItemSearchChange = (groupId: string, entryId: string, value: string) => {
    const location = groups.find((group) => group.id === groupId)?.location ?? "";
    const options = getItemOptionsForLocation(location);
    const exact = options.find((option) => buildItemLabel(option) === value);
    if (exact) {
      onSelectItem(groupId, entryId, exact.id);
      return;
    }
    updateEntry(groupId, entryId, {
      itemSearch: value,
      itemId: "",
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
    const normalized: InventoryUsageEntryInput[] = [];

    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      const groupLabel = effectiveLocationKey ? `Location section ${g + 1}` : `Section ${g + 1}`;
      if (effectiveLocationKey && !group.location.trim()) {
        alert(`${groupLabel}: select a location.`);
        return;
      }

      for (let i = 0; i < group.entries.length; i += 1) {
        const entry = group.entries[i];
        const itemId = entry.itemId.trim();
        const quantityUsed = Number(entry.quantityUsed);
        const notes = entry.notes.trim();
        const isEmpty =
          !itemId &&
          entry.quantityUsed.trim() === "" &&
          notes === "";
        if (isEmpty) continue;
        if (!itemId) {
          alert(`${groupLabel}, line ${i + 1}: select an item.`);
          return;
        }
        if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
          alert("Used quantity must be greater than 0.");
          return;
        }

        const row = rowById.get(itemId);
        if (!row) {
          alert(`${groupLabel}, line ${i + 1}: selected item was not found.`);
          return;
        }

        const available = Number(row.values.quantity ?? 0);
        if (!Number.isFinite(available) || quantityUsed > available) {
          alert(`${groupLabel}, line ${i + 1}: usage exceeds available quantity (${available}).`);
          return;
        }

        normalized.push({
          itemId,
          quantityUsed,
          notes: effectiveNotesKey ? notes : undefined,
          location: effectiveLocationKey ? group.location : undefined,
        });
      }
    }

    if (normalized.length === 0) {
      alert("Add at least one usage entry.");
      return;
    }

    setSubmitting(true);
    setFeedback("");
    try {
      const result = await submitInventoryUsage(normalized);
      await refreshInventoryRows({ silent: true });
      setGroups([createUsageGroup()]);
      setFeedback(
        result.updatedCount === 1
          ? "Usage submitted for 1 item."
          : `Usage submitted for ${result.updatedCount} items.`,
      );
    } catch (err: any) {
      alert(err?.message ?? "Failed to submit usage");
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

  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Inventory Usage Submission</h2>
          </div>
        </header>

        <div className="usage-form-list">
          {groups.map((group, groupIndex) => {
            const itemOptions = getItemOptionsForLocation(group.location);
            return (
              <section className="usage-form-section" key={group.id}>
                {effectiveLocationKey ? (
                  <div className="usage-location-wrap">
                    <label className="usage-location-label" htmlFor={`usage-location-select-${group.id}`}>
                      Location
                    </label>
                    <select
                      id={`usage-location-select-${group.id}`}
                      className="usage-location-select"
                      value={group.location}
                      onChange={(event) => updateGroup(group.id, { location: event.target.value })}
                      disabled={submitting}
                    >
                      <option value="">Select location...</option>
                      {locationValues.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    {groups.length > 1 ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() => removeLocationSection(group.id)}
                        disabled={submitting}
                      >
                        Remove Location
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {group.entries.map((entry) => {
                  return (
                    <div className="usage-form-row" key={entry.id}>
                      <label>
                        <span>Item</span>
                        <div className="usage-item-search-wrap">
                          <input
                            type="text"
                            className="usage-item-search-input"
                            list={`usage-item-list-${group.id}-${entry.id}`}
                            value={entry.itemSearch}
                            onChange={(event) => onItemSearchChange(group.id, entry.id, event.target.value)}
                            disabled={submitting || (effectiveLocationKey ? !group.location : false)}
                            placeholder="Search item..."
                          />
                          {entry.itemSearch ? (
                            <button
                              type="button"
                              className="usage-item-search-clear"
                              onClick={() =>
                                updateEntry(group.id, entry.id, {
                                  itemId: "",
                                  itemSearch: "",
                                })
                              }
                              disabled={submitting}
                              aria-label="Clear item search"
                              title="Clear item search"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                        <datalist id={`usage-item-list-${group.id}-${entry.id}`}>
                          {itemOptions.map((item) => (
                            <option key={item.id} value={buildItemLabel(item)} />
                          ))}
                        </datalist>
                      </label>
                      <label>
                        <span>Used Qty</span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={entry.quantityUsed}
                          onChange={(event) => updateEntry(group.id, entry.id, { quantityUsed: event.target.value })}
                          disabled={submitting}
                          placeholder="0"
                        />
                      </label>
                      {effectiveNotesKey ? (
                        <label>
                          <span>Notes (optional)</span>
                          {!entry.notesOpen && entry.notes.trim().length === 0 ? (
                            <button
                              type="button"
                              className="inventory-date-add usage-note-add"
                              onClick={() => updateEntry(group.id, entry.id, { notesOpen: true })}
                              disabled={submitting}
                            >
                              Add note
                            </button>
                          ) : (
                            <div className="inventory-date-edit-wrap usage-note-edit-wrap">
                              <input
                                type="text"
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
                              />
                              {entry.notes.trim().length > 0 ? (
                                <button
                                  type="button"
                                  className="inventory-date-clear"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() =>
                                    updateEntry(group.id, entry.id, { notes: "", notesOpen: false })
                                  }
                                  disabled={submitting}
                                  aria-label="Clear note"
                                  title="Clear note"
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          )}
                        </label>
                      ) : null}
                      <div className="usage-form-meta">
                        {group.entries.length > 1 ? (
                          <button
                            type="button"
                            className="button button-ghost"
                            onClick={() => removeLine(group.id, entry.id)}
                            disabled={submitting}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}

                <div className="usage-section-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => addLine(group.id)}
                    disabled={submitting}
                  >
                    Add Line
                  </button>
                </div>

                {effectiveLocationKey && groupIndex < groups.length - 1 ? <hr className="usage-section-divider" /> : null}
              </section>
            );
          })}
        </div>

        <div className="usage-actions">
          {effectiveLocationKey ? (
            <button type="button" className="button button-secondary" onClick={addLocationSection} disabled={submitting}>
              Add Location
            </button>
          ) : null}
          <button type="button" className="button button-primary" onClick={() => void onSubmit()} disabled={submitting}>
            {submitting ? "Submitting..." : "Submit Usage"}
          </button>
        </div>
        {feedback ? <p className="usage-feedback">{feedback}</p> : null}
      </div>
    </section>
  );
}
