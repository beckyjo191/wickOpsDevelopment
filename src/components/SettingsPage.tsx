import { useEffect, useState } from "react";
import {
  createInventoryColumn,
  deleteInventoryColumn,
  loadInventoryBootstrap,
  type InventoryColumn,
} from "../lib/inventoryApi";

interface SettingsPageProps {
  canInviteMore: boolean;
  canManageInventoryColumns: boolean;
  onInviteUsers: () => void;
  onBack: () => void;
}

export function SettingsPage({
  canInviteMore,
  canManageInventoryColumns,
  onInviteUsers,
  onBack,
}: SettingsPageProps) {
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState<InventoryColumn["type"]>("text");
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [savingColumn, setSavingColumn] = useState(false);

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
        type: newColumnType,
      });
      setColumns((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder));
      setNewColumnName("");
      setNewColumnType("text");
    } catch (err: any) {
      alert(err?.message ?? "Failed to add column");
    } finally {
      setSavingColumn(false);
    }
  };

  const onDeleteColumn = async (column: InventoryColumn) => {
    if (!canManageInventoryColumns || column.isCore) return;
    setSavingColumn(true);
    try {
      await deleteInventoryColumn(column.id);
      setColumns((prev) => prev.filter((item) => item.id !== column.id));
    } catch (err: any) {
      alert(err?.message ?? "Failed to remove column");
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
        </header>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="metric-label">Access Model</span>
            <strong className="metric-value">Role-Based</strong>
          </article>
          <article className="metric-card">
            <span className="metric-label">User Roles</span>
            <strong className="metric-value">3 Tiers</strong>
          </article>
          <article className="metric-card">
            <span className="metric-label">Settings Scope</span>
            <strong className="metric-value">Organization</strong>
          </article>
        </div>

        <div className="empty-state spacer-top">
          Configuration sections for profile, modules, billing, and notifications will live here.
        </div>

        <div className="settings-section spacer-top">
          <h3 className="settings-section-title">Inventory Columns</h3>
          {canManageInventoryColumns ? (
            <>
              <p className="settings-section-copy">
                Add or remove custom columns. Core inventory columns for expiration and stock are
                protected.
              </p>
              <div className="settings-columns-add">
                <input
                  className="field"
                  placeholder="Column name"
                  value={newColumnName}
                  onChange={(event) => setNewColumnName(event.target.value)}
                />
                <select
                  className="select"
                  value={newColumnType}
                  onChange={(event) =>
                    setNewColumnType(event.target.value as InventoryColumn["type"])
                  }
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="link">Link</option>
                  <option value="boolean">True/False</option>
                </select>
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
                    <span>
                      {column.label} <em>({column.type})</em>
                    </span>
                    {column.isCore ? (
                      <span className="settings-core-pill">Core</span>
                    ) : (
                      <button
                        className="button button-ghost"
                        onClick={() => onDeleteColumn(column)}
                        disabled={savingColumn}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="settings-section-copy">
              Only administrators can manage inventory columns.
            </p>
          )}
        </div>

        <div className="app-actions">
          {canInviteMore && (
            <button className="button button-primary" onClick={onInviteUsers}>
              Invite More Users
            </button>
          )}
          <button className="button button-secondary" onClick={onBack}>
            Back To Dashboard
          </button>
        </div>
      </div>
    </section>
  );
}
