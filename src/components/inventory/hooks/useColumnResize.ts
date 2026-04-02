import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { InventoryColumn } from "../inventoryTypes";
import { COLUMN_WIDTHS_STORAGE_KEY_PREFIX } from "../inventoryTypes";

export function useColumnResize(organizationId: string) {
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizeStateRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const getColumnMinWidth = (column: InventoryColumn): number => {
    if (column.key === "itemName") return 280;
    if (column.key === "notes") return 360;
    if (column.type === "text") return Math.max(column.label.length * 11 + 36, 220);
    return Math.max(column.label.length * 10 + 28, 120);
  };

  const getAppliedColumnWidth = (column: InventoryColumn): number =>
    Math.max(columnWidths[column.key] ?? getColumnMinWidth(column), getColumnMinWidth(column));

  const onResizeMouseDown = (event: ReactMouseEvent<HTMLSpanElement>, column: InventoryColumn) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      key: column.key,
      startX: event.clientX,
      startWidth: getAppliedColumnWidth(column),
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const current = resizeStateRef.current;
      if (!current) return;
      const deltaX = moveEvent.clientX - current.startX;
      const nextWidth = Math.max(getColumnMinWidth(column), current.startWidth + deltaX);
      setColumnWidths((prev) => ({
        ...prev,
        [current.key]: nextWidth,
      }));
    };

    const onMouseUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  // Load column widths from localStorage
  useEffect(() => {
    if (!organizationId) return;
    try {
      const raw = window.localStorage.getItem(`${COLUMN_WIDTHS_STORAGE_KEY_PREFIX}${organizationId}`);
      if (!raw) {
        setColumnWidths({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, number>;
      const valid: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          valid[key] = value;
        }
      }
      setColumnWidths(valid);
    } catch {
      setColumnWidths({});
    }
  }, [organizationId]);

  // Save column widths to localStorage
  useEffect(() => {
    if (!organizationId) return;
    try {
      window.localStorage.setItem(
        `${COLUMN_WIDTHS_STORAGE_KEY_PREFIX}${organizationId}`,
        JSON.stringify(columnWidths),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [organizationId, columnWidths]);

  return { columnWidths, setColumnWidths, getColumnMinWidth, getAppliedColumnWidth, onResizeMouseDown };
}
