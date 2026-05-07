import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { LoadingState } from "./shared/LoadingState";
import { QtyStepper } from "./shared/QtyStepper";
import {
  isInventoryProvisioningError,
  loadInventoryBootstrap,
  type InventoryLocation,
  submitInventoryUsage,
  type InventoryColumn,
  type InventoryRow,
  type InventoryUsageEntryInput,
} from "../lib/inventoryApi";

/** Compact time labels for the recent-submissions list. Today shows the
 *  clock; other dates show month/day. Identical pattern the original
 *  pending-queue panel used so the visual rhythm stays familiar. */
function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type UsageEntry = {
  id: string;
  itemId: string;
  itemSearch: string;
  quantityUsed: string;
  notes: string;
  notesOpen: boolean;
  /** "single" decrements quantity by quantityUsed; "pack" decrements by
   *  quantityUsed × packSize. Only meaningful when the picked item has
   *  packSize > 0; the toggle UI hides itself for non-pack items so single
   *  is implicit. Default "single" — the most common case ("used 1 pad"). */
  usageMode: "single" | "pack";
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
  // Default to 1 — the most common case is "I used one of this item." The
  // QtyStepper input is select-on-focus so users can replace the value with a
  // single keystroke when the qty is something else. Beats starting at 0
  // which forces an extra keystroke for every line in the typical workflow.
  quantityUsed: "1",
  notes: "",
  notesOpen: false,
  usageMode: "single",
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
  // The dropdown is rendered into a portal at document.body so it escapes
  // any clipping ancestor — notably the bounded `.usage-entries` scroll
  // inset, which would otherwise crop the dropdown's bottom rows. We track
  // viewport-relative coords + an "open upward" flag and apply them via
  // inline styles on the rendered list.
  const [coords, setCoords] = useState<
    | { top: number; left: number; width: number; upward: boolean }
    | null
  >(null);
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
      const target = e.target as Node;
      // The dropdown lives in a portal so it isn't a DOM child of wrapRef.
      // Treat clicks inside either the input wrap OR the portaled list as
      // "inside" — otherwise selecting an option would close the dropdown
      // before the click handler fires.
      if (wrapRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
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

  // Compute viewport coords for the portaled dropdown. Re-runs on open +
  // window scroll/resize (capture-phase scroll so it catches scrolling inside
  // the bounded `.usage-entries` inset, not just the document). Flips upward
  // when there's not enough free space below the input.
  useEffect(() => {
    if (!open) return;
    const DROPDOWN_MAX_HEIGHT = 240;
    const recompute = () => {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const upward = spaceBelow < DROPDOWN_MAX_HEIGHT && spaceAbove > spaceBelow;
      setCoords({
        top: upward ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        upward,
      });
    };
    recompute();
    // Capture-phase scroll listener catches scroll events on any ancestor
    // (the `.usage-entries` inset, the page itself, etc.) — keeps the portal
    // glued to the input no matter where the user scrolls.
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

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
      {showDropdown && coords && createPortal(
        <ul
          className={`usage-autocomplete-list${coords.upward ? " usage-autocomplete-list--up" : ""}`}
          ref={listRef}
          role="listbox"
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            width: coords.width,
            // Translate up by 100% so the dropdown's bottom edge sits at the
            // computed `top` — that's the input's top minus 4px when upward.
            transform: coords.upward ? "translateY(-100%)" : "none",
            // Override the default absolute-position offsets so the inline
            // top/left win regardless of CSS source order.
            right: "auto",
            bottom: "auto",
          }}
        >
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
        </ul>,
        document.body,
      )}
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");
  // Error-only banner. Successful submissions don't need a banner because
  // the Recent Usage panel below the form already shows what landed and
  // persists across reloads — a transient success banner just repeats the
  // same info less reliably. Errors still need a conspicuous surface.
  const [feedback, setFeedback] = useState<{ type: "error"; message: string } | null>(null);
  // History of recent submissions — capped at 10, persisted to localStorage
  // so a reload doesn't wipe context when a coworker walks up to verify
  // something just got logged. Audit feed remains the canonical record;
  // this is a quick-glance affordance.
  type RecentUsageSubmission = {
    id: string;
    submittedAt: string;
    entries: Array<{ itemName: string; quantityUsed: number }>;
  };
  const RECENT_USAGE_STORAGE_KEY = "wickops.recentUsageSubmissions";
  const [recentSubmissions, setRecentSubmissions] = useState<RecentUsageSubmission[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_USAGE_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Defensive shape check — malformed entries from an older schema get
      // dropped silently rather than crashing the form.
      return parsed.filter(
        (s): s is RecentUsageSubmission =>
          s
          && typeof s.id === "string"
          && typeof s.submittedAt === "string"
          && Array.isArray(s.entries),
      );
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        RECENT_USAGE_STORAGE_KEY,
        JSON.stringify(recentSubmissions),
      );
    } catch {
      // Storage may be unavailable (private mode, full disk) — fall back to
      // memory-only and don't crash the form.
    }
  }, [recentSubmissions]);
  // Per-section refs for the scrollable entries inset. Used by addLine to
  // scroll the freshly-added entry into view at the bottom of the inset, so
  // the user sees the new card right next to the Add Item button.
  const entriesRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
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
          return { ...entry, itemId: "", itemSearch: "", notes: "", notesOpen: false, usageMode: "single" as const, error: "" };
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
            return { ...entry, itemId: "", itemSearch: "", quantityUsed: "1", notes: "", notesOpen: false, usageMode: "single" as const, error: "" };
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
    // Append the new entry; the entries list is now a bounded scrollable
    // inset so the Submit Usage / Add Location row at the bottom stays
    // anchored. After state flushes we scroll the inset to the bottom so
    // the freshly-added entry is visible right next to the Add Item button.
    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId
          ? { ...group, entries: [...group.entries, createUsageEntry()] }
          : group,
      ),
    );
    requestAnimationFrame(() => {
      const el = entriesRefs.current.get(groupId);
      if (el) el.scrollTop = el.scrollHeight;
    });
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
        const quantityUsedRaw = Number(entry.quantityUsed);
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
        } else if (!Number.isFinite(quantityUsedRaw) || quantityUsedRaw < 0) {
          error = "Enter a valid quantity";
          hasError = true;
        } else if (quantityUsedRaw === 0 && !notes) {
          error = "Enter quantity used";
          hasError = true;
        } else {
          const row = rowById.get(itemId);
          if (!row) {
            error = "Item not found";
            hasError = true;
          } else {
            // Pack mode (1f.8): user typed pack count, but inventory tracks
            // primary units — multiply through. packSize must be > 0 for
            // pack mode; if it's not, the toggle wouldn't have been shown
            // and we treat the value as single.
            const packSize = Number(row.values.packSize);
            const isPackMode = entry.usageMode === "pack" && Number.isFinite(packSize) && packSize > 0;
            const quantityUsed = isPackMode ? quantityUsedRaw * packSize : quantityUsedRaw;
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

    setSubmitting(true);
    setFeedback(null);
    try {
      await submitInventoryUsage(normalized);
      setGroups([createUsageGroup()]);
      // Capture the submission for the recent-usage panel below the form.
      // Snapshot the resolved item names + quantities so the row reads cleanly
      // regardless of subsequent inventory edits.
      const snapshotEntries = normalized.map((entry) => {
        const row = rowById.get(entry.itemId);
        const name = row ? getItemDisplayName(row) : entry.itemId;
        return { itemName: name, quantityUsed: entry.quantityUsed };
      });
      setRecentSubmissions((prev) => [
        {
          id: crypto.randomUUID(),
          submittedAt: new Date().toISOString(),
          entries: snapshotEntries,
        },
        ...prev,
      ].slice(0, 10));
      // Re-fetch inventory so the in-form quantities reflect the new totals.
      void refreshInventoryRows({ silent: true });
    } catch (err: any) {
      setFeedback({ type: "error", message: err?.message ?? "Failed to submit usage" });
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

        {feedback && (
          <div className={`usage-banner usage-banner--${feedback.type}`} role="alert">
            <span className="usage-banner-icon">!</span>
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

                {/* Entries are a bounded scrollable inset. Submit Usage and
                    Add Location stay anchored at the bottom of the form
                    regardless of how many lines the user has logged — the
                    list scrolls inside its own pane instead of pushing the
                    page taller. addLine scrolls this pane to its bottom on
                    add so the new entry lands next to the Add Item button. */}
                <div
                  className="usage-entries"
                  ref={(el) => { entriesRefs.current.set(group.id, el); }}
                >
                  {group.entries.map((entry) => {
                    const selectedItem = itemOptions.find((o) => o.id === entry.itemId);
                    const selectedRow = entry.itemId ? rowById.get(entry.itemId) : undefined;
                    // Pack-as-secondary-unit (1f.8): when the item has a
                    // packSize > 0, offer a Single|Pack toggle so the user
                    // can log "1 box (=100 pads)" or "1 bag (=4 lb)" without
                    // doing the math themselves.
                    const packSize = selectedRow ? Number(selectedRow.values.packSize) : 0;
                    const hasPackMode = Number.isFinite(packSize) && packSize > 0;
                    const itemUnit = selectedRow
                      ? String(selectedRow.values.unit ?? "").trim() || "ct"
                      : "ct";
                    const isPackMode = hasPackMode && entry.usageMode === "pack";
                    const baseMaxQty = selectedItem?.quantity ?? 9999;
                    const effectiveMaxQty = isPackMode
                      ? Math.floor(baseMaxQty / Math.max(1, packSize))
                      : baseMaxQty;
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
                                  usageMode: "single",
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
                            <label className="field-label" htmlFor={`usage-qty-${group.id}-${entry.id}`}>
                              {/* Pack-mode label reads "Packs Used (pack of 100 ct)"
                               *  — clean regardless of what `itemUnit` happens to
                               *  hold. Log Usage doesn't have a vendor context, so
                               *  we use a generic "pack" label (vendor-specific
                               *  pack labels live on order/receive flows). */}
                              {isPackMode
                                ? `Packs Used (pack of ${packSize} ${itemUnit})`
                                : `Used (${itemUnit})`}
                            </label>
                            {hasPackMode ? (
                              <div className="reorder-price-mode usage-entry-mode" role="tablist" aria-label="Usage mode">
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={!isPackMode}
                                  className={`reorder-price-mode-btn${!isPackMode ? " active" : ""}`}
                                  onClick={() => updateEntry(group.id, entry.id, { usageMode: "single", error: "" })}
                                  disabled={submitting}
                                >
                                  Single
                                </button>
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={isPackMode}
                                  className={`reorder-price-mode-btn${isPackMode ? " active" : ""}`}
                                  onClick={() => updateEntry(group.id, entry.id, { usageMode: "pack", error: "" })}
                                  disabled={submitting}
                                >
                                  Pack
                                </button>
                              </div>
                            ) : null}
                            <QtyStepper
                              inputId={`usage-qty-${group.id}-${entry.id}`}
                              value={entry.quantityUsed}
                              max={effectiveMaxQty}
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

        {recentSubmissions.length > 0 && (
          <div className="usage-activity">
            <h3 className="usage-activity-title">Recent Usage</h3>
            <ul className="usage-activity-list">
              {recentSubmissions.map((sub) => {
                // Full label is always available via the title attr for
                // hover-to-see-everything. Visible label simplifies once the
                // line gets long: shows the first two items + a "+N more"
                // count so a 12-item submission doesn't sprawl across the
                // whole panel.
                const fullLabel = sub.entries
                  .map((e) => `${e.itemName} -${e.quantityUsed}`)
                  .join(", ");
                const PREVIEW_LIMIT = 2;
                const isTrimmed = sub.entries.length > PREVIEW_LIMIT + 1;
                const visibleLabel = isTrimmed
                  ? `${sub.entries
                      .slice(0, PREVIEW_LIMIT)
                      .map((e) => `${e.itemName} -${e.quantityUsed}`)
                      .join(", ")}, +${sub.entries.length - PREVIEW_LIMIT} more`
                  : fullLabel;
                return (
                  <li key={sub.id} className="usage-activity-row">
                    <span
                      className="usage-activity-items"
                      title={isTrimmed ? fullLabel : undefined}
                    >
                      {visibleLabel}
                    </span>
                    <span className="usage-activity-when">{formatActivityTime(sub.submittedAt)}</span>
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
