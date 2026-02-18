import { useEffect, useMemo, useState } from "react";
import {
  loadInventoryBootstrap,
  saveInventoryItems,
  type InventoryColumn,
  type InventoryRow,
} from "../lib/inventoryApi";

type InventoryFilter = "all" | "expired" | "exp30" | "exp60" | "lowStock";

interface InventoryPageProps {
  canEditInventory: boolean;
}

const NUMBER_COLUMN_KEYS = new Set(["quantity", "minQuantity"]);

const createBlankInventoryRow = (
  columns: InventoryColumn[],
  position: number,
): InventoryRow => {
  const values: Record<string, string | number | boolean | null> = {};
  for (const column of columns) {
    values[column.key] = column.type === "number" ? 0 : "";
  }
  return {
    id: crypto.randomUUID(),
    position,
    values,
  };
};

export function InventoryPage({ canEditInventory }: InventoryPageProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeFilter, setActiveFilter] = useState<InventoryFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [locationFilter, setLocationFilter] = useState("All Locations");
  const [columns, setColumns] = useState<InventoryColumn[]>([]);
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loadError, setLoadError] = useState<string>("");
  const canEditTable = canEditInventory && activeFilter !== "lowStock";

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError("");

      try {
        const bootstrap = await loadInventoryBootstrap();
        const resolvedColumns = [...bootstrap.columns].sort(
          (a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0),
        );
        const persistedRows = bootstrap.items;

        if (cancelled) return;
        setColumns(resolvedColumns);
        setRows(
          persistedRows.length > 0
            ? persistedRows
            : [createBlankInventoryRow(resolvedColumns, 0)],
        );
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err?.message ?? "Failed to load inventory");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleColumns = useMemo(
    () =>
      [...columns]
        .filter((column) => column.isVisible)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [columns],
  );

  const locationColumn = useMemo(
    () => visibleColumns.find((column) => column.key === "location"),
    [visibleColumns],
  );

  const getDaysUntilExpiration = (value: string | number | boolean | null | undefined) => {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;

    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.floor((targetStart - todayStart) / (1000 * 60 * 60 * 24));
  };

  const locationOptions = useMemo(() => {
    if (!locationColumn) return ["All Locations"];
    const options = Array.from(
      new Set(
        rows
          .map((row) => String(row.values[locationColumn.key] ?? "").trim())
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return ["All Locations", ...options];
  }, [rows, locationColumn]);

  const effectiveLocationFilter = locationOptions.includes(locationFilter)
    ? locationFilter
    : "All Locations";

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const quantity = Number(row.values.quantity ?? 0);
        const minQuantity = Number(row.values.minQuantity ?? 0);
        const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
        const rowLocation = String(row.values.location ?? "").trim();

        let passesTab = true;
        if (activeFilter === "lowStock") passesTab = quantity <= minQuantity;
        if (activeFilter === "expired") passesTab = daysUntil !== null && daysUntil < 0;
        if (activeFilter === "exp30") passesTab = daysUntil !== null && daysUntil >= 0 && daysUntil <= 30;
        if (activeFilter === "exp60") passesTab = daysUntil !== null && daysUntil >= 0 && daysUntil <= 60;
        if (!passesTab) return false;

        if (locationColumn && effectiveLocationFilter !== "All Locations" && rowLocation !== effectiveLocationFilter) {
          return false;
        }

        if (!normalizedSearch) return true;
        return visibleColumns.some((column) =>
          String(row.values[column.key] ?? "")
            .toLowerCase()
            .includes(normalizedSearch),
        );
      });
  }, [
    rows,
    activeFilter,
    visibleColumns,
    searchTerm,
    locationColumn,
    effectiveLocationFilter,
  ]);

  const onAddRow = () => {
    if (!canEditTable) return;
    setRows((prev) => [...prev, createBlankInventoryRow(visibleColumns, prev.length)]);
  };

  const onRemoveRow = (rowIndex: number) => {
    if (!canEditTable) return;
    setRows((prev) => {
      if (prev.length <= 1) return [createBlankInventoryRow(visibleColumns, 0)];
      return prev.filter((_, index) => index !== rowIndex);
    });
  };

  const onCellChange = (rowIndex: number, columnKey: string, value: string) => {
    if (!canEditTable) return;
    setRows((prev) =>
      prev.map((row, index) => {
        if (index !== rowIndex) return row;
        if (NUMBER_COLUMN_KEYS.has(columnKey)) {
          const parsed = Number(value);
          return {
            ...row,
            values: {
              ...row.values,
              [columnKey]: Number.isFinite(parsed) ? parsed : 0,
            },
          };
        }
        return {
          ...row,
          values: {
            ...row.values,
            [columnKey]: value,
          },
        };
      }),
    );
  };

  const onSave = async () => {
    if (!canEditTable) return;
    setSaving(true);
    try {
      await saveInventoryItems(rows.map((row, index) => ({ ...row, position: index })));
    } catch (err: any) {
      alert(err?.message ?? "Failed to save inventory");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory">Loading inventory...</div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="app-content">
        <div className="app-card app-card--inventory">{loadError}</div>
      </section>
    );
  }

  return (
    <section className="app-content">
      <div className="app-card app-card--inventory">
        <header className="app-header">
          <div>
            <h2 className="app-title">Inventory</h2>
          </div>
          <div className="app-actions">
            {canEditInventory ? (
              <>
                <button className="button button-secondary" onClick={onAddRow} disabled={!canEditTable}>
                  Add Row
                </button>
                <button className="button button-primary" onClick={onSave} disabled={saving || !canEditTable}>
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div className="inventory-filter-bar">
          <div className="inventory-tabs" role="tablist" aria-label="Inventory filters">
            <button
              className={`inventory-tab-btn${activeFilter === "all" ? " active" : ""}`}
              onClick={() => setActiveFilter("all")}
              role="tab"
              aria-selected={activeFilter === "all"}
            >
              All Items
            </button>
            <button
              className={`inventory-tab-btn${activeFilter === "expired" ? " active" : ""}`}
              onClick={() => setActiveFilter("expired")}
              role="tab"
              aria-selected={activeFilter === "expired"}
            >
              Expired
            </button>
            <button
              className={`inventory-tab-btn${activeFilter === "exp30" ? " active" : ""}`}
              onClick={() => setActiveFilter("exp30")}
              role="tab"
              aria-selected={activeFilter === "exp30"}
            >
              Expiring Within 30 Days
            </button>
            <button
              className={`inventory-tab-btn${activeFilter === "exp60" ? " active" : ""}`}
              onClick={() => setActiveFilter("exp60")}
              role="tab"
              aria-selected={activeFilter === "exp60"}
            >
              Expiring Within 60 Days
            </button>
            <button
              className={`inventory-tab-btn${activeFilter === "lowStock" ? " active" : ""}`}
              onClick={() => setActiveFilter("lowStock")}
              role="tab"
              aria-selected={activeFilter === "lowStock"}
            >
              Low Stock
            </button>
          </div>
          <input
            className="inventory-search-input"
            placeholder="Search inventory..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </div>

        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                {visibleColumns.map((column) =>
                  column.key === "location" ? (
                    <th key={column.id}>
                      <details className="inventory-location-menu">
                        <summary className="inventory-location-trigger">{column.label}</summary>
                        <div className="inventory-location-panel">
                          {locationOptions.map((option) => (
                            <button
                              key={option}
                              className={`inventory-location-item${effectiveLocationFilter === option ? " active" : ""}`}
                              onClick={(event) => {
                                setLocationFilter(option);
                                const details = event.currentTarget.closest("details");
                                details?.removeAttribute("open");
                              }}
                              type="button"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </details>
                    </th>
                  ) : (
                    <th key={column.id}>{column.label}</th>
                  ),
                )}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ row, index: rowIndex }) => (
                <tr key={row.id}>
                  {visibleColumns.map((column) => (
                    <td key={`${row.id}-${column.id}`}>
                      <input
                        type={column.type === "number" ? "number" : "text"}
                        value={String(row.values[column.key] ?? "")}
                        onChange={(event) => onCellChange(rowIndex, column.key, event.target.value)}
                        disabled={!canEditTable}
                      />
                    </td>
                  ))}
                  <td className="inventory-actions-cell">
                    {canEditTable && rows.length > 1 ? (
                      <button
                        className="inventory-row-action"
                        onClick={() => onRemoveRow(rowIndex)}
                        aria-label={`Remove row ${rowIndex + 1}`}
                      >
                        -
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
