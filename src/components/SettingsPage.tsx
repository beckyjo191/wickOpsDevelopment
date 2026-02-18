import { useEffect, useState } from "react";
import {
  createInventoryColumn,
  deleteInventoryColumn,
  loadInventoryBootstrap,
  updateInventoryColumnLabel,
  updateInventoryColumnVisibility,
  type InventoryColumn,
} from "../lib/inventoryApi";
import type { ThemePreference } from "../lib/themePreference";

interface SettingsPageProps {
  canInviteMore: boolean;
  seatsRemaining: number;
  seatLimit: number;
  seatsUsed: number;
  canManageInventoryColumns: boolean;
  themePreference: ThemePreference;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onInviteUsers: () => void;
}

export function SettingsPage({
  canInviteMore,
  seatsRemaining,
  seatLimit,
  seatsUsed,
  canManageInventoryColumns,
  themePreference,
  onThemePreferenceChange,
  onInviteUsers,
}: SettingsPageProps) {
  const nonEditableKeys = new Set(["itemName", "quantity", "minQuantity", "expirationDate"]);
  const isLockedColumn = (column: InventoryColumn): boolean =>
    column.isCore || column.isRequired || nonEditableKeys.has(column.key);
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);
  const [pendingDeleteColumnId, setPendingDeleteColumnId] = useState<string | null>(null);
  const [selectedDeleteColumnIds, setSelectedDeleteColumnIds] = useState<Set<string>>(new Set());
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");

  useEffect(() => {
    if (!canManageInventoryColumns) return;
    let cancelled = false;

    const loadColumns = async () => {
      setLoadingColumns(true);
      try {
        const bootstrap = await loadInventoryBootstrap();
        if (!cancelled) {
          setColumns(
            [...bootstrap.columns].sort(
              (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
            ),
          );
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoadingColumns(false);
      }
    };

    loadColumns();
    return () => {
      cancelled = true;
    };
  }, [canManageInventoryColumns]);

  useEffect(() => {
    setSelectedDeleteColumnIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(
        columns.filter((column) => !isLockedColumn(column)).map((column) => column.id),
      );
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [columns]);

  const onAddColumn = async () => {
    if (!canManageInventoryColumns || !newColumnName.trim()) return;
    setSavingColumn(true);
    try {
      const created = await createInventoryColumn({
        label: newColumnName.trim(),
      });
      setColumns((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setNewColumnName("");
    } catch (err: any) {
      alert(err?.message ?? "Failed to add column");
    } finally {
      setSavingColumn(false);
    }
  };

  const onDeleteColumn = async (columnId: string) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      await deleteInventoryColumn(columnId);
      setColumns((prev) => prev.filter((item) => item.id !== columnId));
      setPendingDeleteColumnId(null);
    } catch (err: any) {
      alert(err?.message ?? "Failed to remove column");
    } finally {
      setSavingColumn(false);
    }
  };

  const onToggleDeleteSelectColumn = (column: InventoryColumn) => {
    if (isLockedColumn(column)) return;
    setSelectedDeleteColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(column.id)) {
        next.delete(column.id);
      } else {
        next.add(column.id);
      }
      return next;
    });
  };

  const onDeleteSelectedColumns = async () => {
    if (!canManageInventoryColumns || selectedDeleteColumnIds.size === 0) return;
    const count = selectedDeleteColumnIds.size;
    const confirmed = window.confirm(
      `Delete ${count} selected ${count === 1 ? "column" : "columns"}?`,
    );
    if (!confirmed) return;

    setSavingColumn(true);
    try {
      const ids = Array.from(selectedDeleteColumnIds);
      for (const columnId of ids) {
        await deleteInventoryColumn(columnId);
      }
      setColumns((prev) => prev.filter((item) => !selectedDeleteColumnIds.has(item.id)));
      setSelectedDeleteColumnIds(new Set());
      setPendingDeleteColumnId(null);
    } catch (err: any) {
      alert(err?.message ?? "Failed to remove selected columns");
    } finally {
      setSavingColumn(false);
    }
  };

  const onToggleColumnVisibility = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns) return;
    setSavingColumn(true);
    try {
      await updateInventoryColumnVisibility(column.id, !column.isVisible);
      setColumns((prev) =>
        prev.map((item) =>
          item.id === column.id ? { ...item, isVisible: !item.isVisible } : item,
        ),
      );
    } catch (err: any) {
      alert(err?.message ?? "Failed to update column visibility");
    } finally {
      setSavingColumn(false);
    }
  };

  const onStartEditColumn = (column: InventoryColumn) => {
    setEditingColumnId(column.id);
    setEditingLabel(column.label);
  };

  const onCancelEditColumn = () => {
    setEditingColumnId(null);
    setEditingLabel("");
  };

  const onSaveEditColumn = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns) return;
    const nextLabel = editingLabel.trim();
    if (!nextLabel) return;
    if (nextLabel === column.label) {
      onCancelEditColumn();
      return;
    }
    setSavingColumn(true);
    try {
      await updateInventoryColumnLabel(column.id, nextLabel);
      setColumns((prev) =>
        prev.map((item) => (item.id === column.id ? { ...item, label: nextLabel } : item)),
      );
      onCancelEditColumn();
    } catch (err: any) {
      alert(err?.message ?? "Failed to update column label");
    } finally {
      setSavingColumn(false);
    }
  };

  return (
    <section className="app-content">
      <div className="app-card">
        <header className="app-header">
          <div>
            <h2 className="app-title">Organization Settings</h2>
            <p className="app-subtitle">Manage account profile, modules, and team access settings.</p>
          </div>
          <div className="app-actions">
            <button
              className="button button-primary"
              onClick={onInviteUsers}
              disabled={!canInviteMore}
            >
              Invite More Users
            </button>
          </div>
        </header>

        <div className="status-panel">
          {canInviteMore
            ? `You have ${seatsRemaining} invite${seatsRemaining === 1 ? "" : "s"} remaining (${seatsUsed}/${seatLimit} seats used).`
            : `No invite seats remaining (${seatsUsed}/${seatLimit} seats used).`}
        </div>

        <div className="empty-state spacer-top">
          Configuration sections for profile, modules, billing, and notifications will live here.
        </div>

        <details className="settings-section spacer-top" open>
          <summary className="settings-section-title">Appearance</summary>
          <p className="settings-section-copy">
            Choose how WickOps should look on this device.
          </p>
          <div className="settings-theme-options" role="radiogroup" aria-label="Theme preference">
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="system"
                checked={themePreference === "system"}
                onChange={() => onThemePreferenceChange("system")}
              />
              <span>System</span>
            </label>
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="light"
                checked={themePreference === "light"}
                onChange={() => onThemePreferenceChange("light")}
              />
              <span>Light</span>
            </label>
            <label className="settings-theme-option">
              <input
                type="radio"
                name="theme-preference"
                value="dark"
                checked={themePreference === "dark"}
                onChange={() => onThemePreferenceChange("dark")}
              />
              <span>Dark</span>
            </label>
          </div>
        </details>

        <details className="settings-section spacer-top">
          <summary className="settings-section-title">Inventory Columns</summary>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Add or remove custom columns. *Required columns cannot be removed, but can be shown
                or hidden.
              </p>
              <div className="settings-columns-add">
                <input
                  className="field"
                  placeholder="Column name"
                  value={newColumnName}
                  onChange={(event) => setNewColumnName(event.target.value)}
                />
                <button
                  className="button button-secondary"
                  onClick={onAddColumn}
                  disabled={savingColumn || !newColumnName.trim()}
                >
                  Add Column
                </button>
              </div>
              <div className="settings-columns-batch-actions">
                <button
                  className="button button-ghost"
                  onClick={() => void onDeleteSelectedColumns()}
                  disabled={savingColumn || selectedDeleteColumnIds.size === 0}
                  type="button"
                >
                  Delete Selected ({selectedDeleteColumnIds.size})
                </button>
              </div>
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading columns...</div> : null}
                {columns.map((column) => (
                  (() => {
                    const isLocked = isLockedColumn(column);
                    return (
                  <div key={column.id} className="settings-column-row">
                    <div className="settings-column-visibility">
                      <input
                        type="checkbox"
                        checked={column.isVisible}
                        onChange={() => onToggleColumnVisibility(column)}
                        disabled={savingColumn}
                      />
                      {editingColumnId === column.id ? (
                        <span className="settings-column-edit">
                          <input
                            className="field settings-column-edit-input"
                            value={editingLabel}
                            onChange={(event) => setEditingLabel(event.target.value)}
                            disabled={savingColumn}
                          />
                          <button
                            className="button button-secondary settings-inline-action"
                            onClick={() => void onSaveEditColumn(column)}
                            disabled={savingColumn || !editingLabel.trim()}
                            type="button"
                          >
                            Save
                          </button>
                          <button
                            className="button button-ghost settings-inline-action"
                            onClick={onCancelEditColumn}
                            type="button"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span>{column.label}</span>
                      )}
                    </div>
                    <div className="settings-column-actions">
                      {!isLocked ? (
                        <label className="settings-column-select">
                          <input
                            type="checkbox"
                            checked={selectedDeleteColumnIds.has(column.id)}
                            onChange={() => onToggleDeleteSelectColumn(column)}
                            disabled={savingColumn}
                          />
                          <span>Select</span>
                        </label>
                      ) : null}
                      {isLocked ? (
                        <span className="settings-core-pill">*Required</span>
                      ) : (
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() => onStartEditColumn(column)}
                            disabled={savingColumn}
                            aria-label="Edit column"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M4 16.75V20h3.25l9.58-9.58-3.25-3.25L4 16.75Zm12.62-10.87 1.5-1.5a1 1 0 0 1 1.42 0l1.58 1.58a1 1 0 0 1 0 1.42l-1.5 1.5-3-3Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Edit</span>
                        </div>
                      )}
                      {!isLocked ? (
                        <div className="settings-action-wrap">
                          <button
                            className="settings-action-icon"
                            onClick={() =>
                              setPendingDeleteColumnId((prev) =>
                                prev === column.id ? null : column.id,
                              )
                            }
                            disabled={savingColumn}
                            aria-label="Delete column"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-1 6h2v9H8V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9Z" />
                            </svg>
                          </button>
                          <span className="settings-action-tip" role="tooltip">Delete</span>
                          {pendingDeleteColumnId === column.id ? (
                            <div className="settings-delete-confirm" role="dialog" aria-label="Confirm delete">
                              <p>Are you sure?</p>
                              <div className="settings-delete-confirm-actions">
                                <button
                                  className="button button-secondary settings-inline-action"
                                  onClick={() => setPendingDeleteColumnId(null)}
                                  type="button"
                                >
                                  Cancel
                                </button>
                                <button
                                  className="button button-ghost settings-inline-action"
                                  onClick={() => void onDeleteColumn(column.id)}
                                  disabled={savingColumn}
                                  type="button"
                                >
                                  OK
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                    );
                  })()
                ))}
              </div>
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage inventory columns.
            </p>
          )}
        </details>
      </div>
    </section>
  );
}
