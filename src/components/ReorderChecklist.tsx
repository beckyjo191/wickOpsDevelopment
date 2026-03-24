import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";

type ChecklistItem = {
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
      const raw = params.get("reorder-checklist");
      if (!raw) return null;
      return JSON.parse(decodeURIComponent(raw)) as ChecklistData;
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

      {allChecked && data.items.length > 0 && (
        <div className="checklist-done-banner">
          All items checked off!
        </div>
      )}
    </div>
  );
}
