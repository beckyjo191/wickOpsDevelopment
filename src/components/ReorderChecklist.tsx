import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Plus, X } from "lucide-react";

type ChecklistItem = {
  rowId: string;
  name: string;
  link: string;
  status: string;
  stockLabel?: string;
  stockLow?: boolean;
  statusType?: "expired" | "lowStock";
  quantity: number;
  minQuantity: number;
  suggestedQty: number;
  expirationDate?: string;
};

type ChecklistData = {
  domain: string;
  items: ChecklistItem[];
};

type LineState = {
  rowId: string;
  name: string;
  link: string;
  checked: boolean;
  qty: string;
  unitCost: string;
};

type RawLine = {
  id: string;
  name: string;
  qty: string;
  unitCost: string;
};

export function ReorderChecklist() {
  const data = useMemo<ChecklistData | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const domainKey = params.get("reorder-checklist");
      if (!domainKey) return null;
      const stored = sessionStorage.getItem(`wickops-reorder-${domainKey}`);
      if (stored) return JSON.parse(stored) as ChecklistData;
      try {
        return JSON.parse(decodeURIComponent(domainKey)) as ChecklistData;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }, []);

  const [lines, setLines] = useState<LineState[]>([]);
  const [rawLines, setRawLines] = useState<RawLine[]>([]);

  useEffect(() => {
    if (data) {
      document.title = `Order — ${data.domain}`;
      setLines(
        data.items.map((item) => ({
          rowId: item.rowId,
          name: item.name,
          link: item.link,
          checked: false,
          qty: String(item.suggestedQty ?? Math.max(1, item.minQuantity - item.quantity || 1)),
          unitCost: "",
        })),
      );
    }
  }, [data]);

  if (!data) {
    return (
      <div className="checklist-wrap">
        <p className="checklist-error">No checklist data found.</p>
      </div>
    );
  }

  const checkedCount = lines.filter((l) => l.checked).length + rawLines.filter((r) => r.name.trim() && Number(r.qty) > 0).length;

  const toggleLine = (rowId: string) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: !l.checked } : l)));

  const updateLine = (rowId: string, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, ...patch } : l)));

  const updateRaw = (id: string, patch: Partial<RawLine>) =>
    setRawLines((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleItemClick = (link: string, rowId: string) => {
    setLines((prev) => prev.map((l) => (l.rowId === rowId ? { ...l, checked: true } : l)));
    const vendorTabName = `wickops-vendor-${data.domain}`;
    if (window.opener && !window.opener.closed) {
      window.opener.open(link, vendorTabName);
    } else {
      window.open(link, vendorTabName);
    }
  };

  const handlePlaceOrder = () => {
    const inventoryItems = lines
      .filter((l) => l.checked)
      .map((l) => ({
        rowId: l.rowId,
        name: l.name,
        qty: Math.max(1, Number(l.qty) || 1),
        ...(l.unitCost.trim() ? { unitCost: Number(l.unitCost) } : {}),
      }));

    const freeformItems = rawLines
      .filter((r) => r.name.trim() && Number(r.qty) > 0)
      .map((r) => ({
        rowId: null as string | null,
        name: r.name.trim(),
        qty: Number(r.qty),
        ...(r.unitCost.trim() ? { unitCost: Number(r.unitCost) } : {}),
      }));

    const orderItems = [...inventoryItems, ...freeformItems];
    const checkedRowIds = lines.filter((l) => l.checked).map((l) => l.rowId);

    const channel = new BroadcastChannel("wickops-reorder");
    channel.postMessage({
      type: "mark-ordered",
      rowIds: checkedRowIds,
      domain: data.domain,
      orderItems,
    });
    channel.close();
    window.close();
  };

  return (
    <div className="checklist-wrap">
      <div className="checklist-header">
        <div className="checklist-header-top">
          <h2 className="checklist-title">{data.domain}</h2>
          <button
            type="button"
            className="checklist-close-btn"
            onClick={() => window.close()}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p className="checklist-subtitle">
          {lines.filter((l) => l.checked).length}/{lines.length} items checked
        </p>
        <p className="checklist-instructions">
          Click an item name to open it on {data.domain}. Set qty and price, then place your order.
        </p>
        <div className="checklist-progress">
          <div
            className="checklist-progress-fill"
            style={{
              width: `${lines.length > 0 ? (lines.filter((l) => l.checked).length / lines.length) * 100 : 0}%`,
            }}
          />
        </div>
      </div>

      <div className="checklist-items">
        <div className="checklist-items-header">
          <span />
          <span>Item</span>
          <span>Qty</span>
          <span>Unit Cost</span>
        </div>

        {lines.map((line) => (
          <div key={line.rowId} className={`checklist-item checklist-item--form${line.checked ? " checked" : ""}`}>
            <button
              type="button"
              className={`checklist-checkbox${line.checked ? " checked" : ""}`}
              onClick={() => toggleLine(line.rowId)}
              aria-label={line.checked ? `Uncheck ${line.name}` : `Check ${line.name}`}
            >
              {line.checked && <Check size={14} />}
            </button>

            <div className="checklist-item-info">
              <button
                type="button"
                className="checklist-item-name"
                onClick={() => handleItemClick(line.link, line.rowId)}
                title={`Open ${line.name} on ${data.domain}`}
              >
                {line.name}
                <ExternalLink size={12} />
              </button>
              {(() => {
                const item = data.items.find((i) => i.rowId === line.rowId);
                if (!item) return null;
                const hasMin = Number.isFinite(item.minQuantity) && item.minQuantity > 0;
                return (
                  <span className="checklist-item-detail">
                    {item.statusType === "expired" ? (
                      <>
                        {item.expirationDate && (
                          <span className="reorder-item-status reorder-status-expired">
                            Exp: {new Date(item.expirationDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </span>
                        )}
                        <span className="reorder-item-status reorder-status-stock">
                          {hasMin ? `${item.quantity}/${item.minQuantity}` : `On hand: ${item.quantity}`}
                        </span>
                      </>
                    ) : (
                      <span className="reorder-item-status reorder-status-lowStock">
                        Low: {item.quantity}/{item.minQuantity}
                      </span>
                    )}
                  </span>
                );
              })()}
            </div>

            <input
              className="field checklist-qty-field"
              type="number"
              min="1"
              placeholder="Qty"
              value={line.qty}
              onChange={(e) => updateLine(line.rowId, { qty: e.target.value })}
              onClick={() => !line.checked && toggleLine(line.rowId)}
            />

            <input
              className="field checklist-cost-field"
              type="number"
              min="0"
              step="0.01"
              placeholder="$0.00"
              value={line.unitCost}
              onChange={(e) => updateLine(line.rowId, { unitCost: e.target.value })}
              onClick={() => !line.checked && toggleLine(line.rowId)}
            />
          </div>
        ))}

        {rawLines.map((raw) => (
          <div key={raw.id} className="checklist-item checklist-item--form checklist-item--raw">
            <div className="checklist-raw-dot" />
            <input
              className="field checklist-raw-name-field"
              placeholder="Item name"
              value={raw.name}
              onChange={(e) => updateRaw(raw.id, { name: e.target.value })}
            />
            <input
              className="field checklist-qty-field"
              type="number"
              min="1"
              placeholder="Qty"
              value={raw.qty}
              onChange={(e) => updateRaw(raw.id, { qty: e.target.value })}
            />
            <input
              className="field checklist-cost-field"
              type="number"
              min="0"
              step="0.01"
              placeholder="$0.00"
              value={raw.unitCost}
              onChange={(e) => updateRaw(raw.id, { unitCost: e.target.value })}
            />
            <button
              type="button"
              className="checklist-raw-remove"
              onClick={() => setRawLines((prev) => prev.filter((r) => r.id !== raw.id))}
              aria-label="Remove"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="checklist-add-raw-btn"
        onClick={() =>
          setRawLines((prev) => [...prev, { id: crypto.randomUUID(), name: "", qty: "1", unitCost: "" }])
        }
      >
        <Plus size={13} /> Add item not listed
      </button>

      {checkedCount > 0 && (
        <div className="checklist-done-banner">
          <div className="checklist-done-banner-row">
            <span className="checklist-done-banner-count">
              {checkedCount} item{checkedCount !== 1 ? "s" : ""} selected
            </span>
            <button
              type="button"
              className="button button-primary button-sm"
              onClick={handlePlaceOrder}
            >
              Mark as Ordered
            </button>
          </div>
          <p className="checklist-done-banner-hint">
            Unchecked items will stay in your reorder list.
          </p>
        </div>
      )}
    </div>
  );
}
