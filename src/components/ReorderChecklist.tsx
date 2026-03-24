import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";

type ChecklistItem = {
  rowId: string;
  name: string;
  link: string;
  status: string;
  quantity: number;
  minQuantity: number;
};

type ChecklistData = {
  domain: string;
  items: ChecklistItem[];
};

export function ReorderChecklist() {
  const [checkedItems, setCheckedItems] = useState<Set<number>>(new Set());

  const data = useMemo<ChecklistData | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const domainKey = params.get("reorder-checklist");
      if (!domainKey) return null;
      // Read from sessionStorage (set by ReorderTab before opening this popup)
      const stored = sessionStorage.getItem(`wickops-reorder-${domainKey}`);
      if (stored) return JSON.parse(stored) as ChecklistData;
      // Fallback: try parsing the param as JSON directly (legacy/test URLs)
      try {
        return JSON.parse(decodeURIComponent(domainKey)) as ChecklistData;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (data) {
      document.title = `Reorder — ${data.domain}`;
    }
  }, [data]);

  if (!data) {
    return (
      <div className="checklist-wrap">
        <p className="checklist-error">No checklist data found.</p>
      </div>
    );
  }

  const allChecked = checkedItems.size === data.items.length;

  const toggleItem = (index: number) => {
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleItemClick = (link: string, index: number) => {
    // Auto-check the item
    setCheckedItems((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
    // Reuse the same vendor tab instead of opening new tabs each time
    const vendorTabName = `wickops-vendor-${data.domain}`;
    window.open(link, vendorTabName);
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
          {checkedItems.size}/{data.items.length} items checked off
        </p>
        <p className="checklist-instructions">
          Click an item to open it on {data.domain}. Items are checked off as you go.
        </p>
        <div className="checklist-progress">
          <div
            className="checklist-progress-fill"
            style={{ width: `${data.items.length > 0 ? (checkedItems.size / data.items.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="checklist-items">
        {data.items.map((item, index) => {
          const isChecked = checkedItems.has(index);
          return (
            <div
              key={index}
              className={`checklist-item${isChecked ? " checked" : ""}`}
            >
              <button
                type="button"
                className={`checklist-checkbox${isChecked ? " checked" : ""}`}
                onClick={() => toggleItem(index)}
                aria-label={isChecked ? `Uncheck ${item.name}` : `Check ${item.name}`}
              >
                {isChecked && <Check size={14} />}
              </button>
              <div className="checklist-item-info">
                <button
                  type="button"
                  className="checklist-item-name"
                  onClick={() => handleItemClick(item.link, index)}
                  title={`Open ${item.name} on ${data.domain}`}
                >
                  {item.name}
                  <ExternalLink size={12} />
                </button>
                <span className="checklist-item-detail">{item.status}</span>
              </div>
            </div>
          );
        })}
      </div>

      {checkedItems.size > 0 && (
        <div className="checklist-done-banner">
          <p>{allChecked ? "All items checked off!" : `${checkedItems.size} item${checkedItems.size !== 1 ? "s" : ""} checked`}</p>
          <button
            type="button"
            className="button button-primary button-sm"
            onClick={() => {
              const checkedRowIds = data.items
                .filter((_, i) => checkedItems.has(i))
                .map((item) => item.rowId);
              // Broadcast to main app to stamp orderedAt
              const channel = new BroadcastChannel("wickops-reorder");
              channel.postMessage({
                type: "mark-ordered",
                rowIds: checkedRowIds,
                domain: data.domain,
              });
              channel.close();
              window.close();
            }}
          >
            Mark as Ordered
          </button>
        </div>
      )}
    </div>
  );
}
