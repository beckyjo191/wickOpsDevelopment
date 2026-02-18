import { useEffect, useState } from "react";
import {
  createInventoryColumn,
  deleteInventoryColumn,
  loadInventoryBootstrap,
  updateInventoryColumnVisibility,
  type InventoryColumn,
} from "../lib/inventoryApi";

interface SettingsPageProps {
  canInviteMore: boolean;
  seatsRemaining: number;
  seatLimit: number;
  seatsUsed: number;
  canManageInventoryColumns: boolean;
  onInviteUsers: () => void;
}

export function SettingsPage({
  canInviteMore,
  seatsRemaining,
  seatLimit,
  seatsUsed,
  canManageInventoryColumns,
  onInviteUsers,
}: SettingsPageProps) {
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);
  const [pendingDeleteColumnId, setPendingDeleteColumnId] = useState<string | null>(null);

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
              <div className="settings-columns-list">
                {loadingColumns ? <div>Loading columns...</div> : null}
                {columns.map((column) => (
                  <div key={column.id} className="settings-column-row">
                    <label className="settings-column-visibility">
                      <input
                        type="checkbox"
                        checked={column.isVisible}
                        onChange={() => onToggleColumnVisibility(column)}
                        disabled={savingColumn}
                      />
                      <span>{column.label}</span>
                    </label>
                    <div className="settings-column-actions">
                      {column.isCore ? (
                        <span className="settings-core-pill">*Required</span>
                      ) : (
                        <div className="settings-delete-wrap">
                          <button
                            className="settings-delete-icon"
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
                              <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v9H7V9Z" />
                            </svg>
                          </button>
                          <span className="settings-delete-tip" role="tooltip">Delete</span>
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
                      )}
                    </div>
                  </div>
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
