import { useCallback, useMemo, useState } from "react";
import type { InventoryRow } from "../lib/inventoryApi";
import { ShoppingCart, ExternalLink, Link2Off, Package, PackageCheck, Undo2, Check, X } from "lucide-react";

interface ReorderTabProps {
  rows: InventoryRow[];
  onEditReorderLink?: (rowId: string) => void;
  onClearOrderedAt?: (rowIds: string[]) => void;
  onMarkOrdered?: (rowIds: string[]) => void;
}

const isMobile = () => window.innerWidth <= 780;

type ReorderItem = {
  row: InventoryRow;
  itemName: string;
  reorderLink: string;
  status: "expired" | "lowStock";
  statusLabel: string;
  quantity: number;
  minQuantity: number;
};

type VendorGroup = {
  domain: string;
  items: ReorderItem[];
};

const normalizeLinkValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const getVendorDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

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

const handleReorderVendor = (group: VendorGroup) => {
  // Store checklist data in sessionStorage so we avoid URL length limits
  // and only need to open ONE window (avoids popup blocker on second window.open)
  const data = {
    domain: group.domain,
    openVendorUrl: group.items[0].reorderLink,
    items: group.items.map((item) => ({
      rowId: item.row.id,
      name: item.itemName,
      link: item.reorderLink,
      status: item.statusLabel,
      quantity: item.quantity,
      minQuantity: item.minQuantity,
    })),
  };
  const storageKey = `wickops-reorder-${group.domain}`;
  sessionStorage.setItem(storageKey, JSON.stringify(data));
  const checklistUrl = `${window.location.origin}/?reorder-checklist=${encodeURIComponent(group.domain)}`;
  window.open(
    checklistUrl,
    `wickops-checklist-${group.domain}`,
    "width=400,height=620,scrollbars=yes,resizable=yes",
  );
};

export function ReorderTab({ rows, onEditReorderLink, onClearOrderedAt, onMarkOrdered }: ReorderTabProps) {
  const [reorderedVendors, setReorderedVendors] = useState<Set<string>>(new Set());
  const [mobileChecklist, setMobileChecklist] = useState<{ group: VendorGroup; checkedItems: Set<number> } | null>(null);

  const { vendorGroups, noLinkItems, orderedItems } = useMemo(() => {
    const reorderItems: ReorderItem[] = [];
    const noLink: ReorderItem[] = [];
    const ordered: ReorderItem[] = [];

    for (const row of rows) {
      const quantityRaw = row.values.quantity;
      const minQuantityRaw = row.values.minQuantity;
      const quantity = Number(quantityRaw);
      const minQuantity = Number(minQuantityRaw);
      const hasMin =
        minQuantityRaw !== null &&
        minQuantityRaw !== undefined &&
        String(minQuantityRaw).trim() !== "" &&
        Number.isFinite(minQuantity);
      const isLowStock = hasMin && Number.isFinite(quantity) && quantity < minQuantity;
      const daysUntil = getDaysUntilExpiration(row.values.expirationDate);
      const isExpired = daysUntil !== null && daysUntil < 0;

      if (!isExpired && !isLowStock) continue;

      const rawLink = String(row.values.reorderLink ?? "").trim();
      const reorderLink = normalizeLinkValue(rawLink);
      const itemName = String(row.values.itemName ?? "").trim() || "Unnamed Item";

      const status = isExpired ? "expired" : "lowStock";
      const statusLabel = isExpired
        ? `Expired ${Math.abs(daysUntil!)}d ago · ${quantity} in stock`
        : `Low: ${quantity}/${minQuantity}`;

      const item: ReorderItem = {
        row,
        itemName,
        reorderLink,
        status,
        statusLabel,
        quantity,
        minQuantity,
      };

      // Items with orderedAt go to the ordered section
      if (row.values.orderedAt) {
        ordered.push(item);
      } else if (reorderLink) {
        reorderItems.push(item);
      } else {
        noLink.push(item);
      }
    }

    // Group by vendor domain
    const groupMap = new Map<string, ReorderItem[]>();
    for (const item of reorderItems) {
      const domain = getVendorDomain(item.reorderLink);
      const existing = groupMap.get(domain);
      if (existing) {
        existing.push(item);
      } else {
        groupMap.set(domain, [item]);
      }
    }

    const groups: VendorGroup[] = Array.from(groupMap.entries())
      .map(([domain, items]) => ({ domain, items }))
      .sort((a, b) => b.items.length - a.items.length);

    return { vendorGroups: groups, noLinkItems: noLink, orderedItems: ordered };
  }, [rows]);

  const totalReorderItems = vendorGroups.reduce((sum, g) => sum + g.items.length, 0);

  const handleReorder = useCallback((group: VendorGroup) => {
    if (isMobile()) {
      // On mobile: show inline checklist, open vendor in new tab
      setMobileChecklist({ group, checkedItems: new Set() });
      window.open(group.items[0].reorderLink, "_blank");
    } else {
      handleReorderVendor(group);
    }
  }, []);

  const handleReorderAll = () => {
    for (const group of vendorGroups) {
      handleReorder(group);
    }
  };

  if (totalReorderItems === 0 && noLinkItems.length === 0 && orderedItems.length === 0) {
    return (
      <div className="reorder-empty">
        <Package size={48} strokeWidth={1.5} />
        <h3>Nothing to reorder</h3>
        <p>All items are stocked and up to date.</p>
      </div>
    );
  }

  return (
    <div className="reorder-tab">
      <div className="reorder-header">
        <div className="reorder-header-left">
          <h3 className="reorder-title">
            Reorder
            {totalReorderItems > 0 && (
              <span className="reorder-count-badge">{totalReorderItems}</span>
            )}
          </h3>
          <span className="reorder-subtitle">
            {vendorGroups.length} vendor{vendorGroups.length !== 1 ? "s" : ""}
            {noLinkItems.length > 0 && ` · ${noLinkItems.length} missing link${noLinkItems.length !== 1 ? "s" : ""}`}
          </span>
        </div>
        {vendorGroups.length > 0 && (
          <button
            type="button"
            className="button button-primary"
            onClick={handleReorderAll}
          >
            <ShoppingCart size={16} />
            Reorder All
          </button>
        )}
      </div>

      {vendorGroups.map((group) => (
        <div key={group.domain} className="reorder-vendor-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <h4 className="reorder-vendor-name">{group.domain}</h4>
              <span className="reorder-vendor-count">
                {group.items.length} item{group.items.length !== 1 ? "s" : ""}
              </span>
            </div>
            <button
              type="button"
              className={`button ${reorderedVendors.has(group.domain) ? "button-secondary" : "button-primary"} button-sm`}
              onClick={() => {
                handleReorder(group);
                setReorderedVendors((prev) => new Set(prev).add(group.domain));
              }}
            >
              <ExternalLink size={14} />
              {reorderedVendors.has(group.domain) ? "Reopen" : "Reorder"}
            </button>
          </div>
          <div className="reorder-item-list">
            {group.items.map((item) => (
              <div key={item.row.id} className="reorder-item-row">
                <span className="reorder-item-name">{item.itemName}</span>
                <span className={`reorder-item-status reorder-status-${item.status}`}>
                  {item.statusLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {noLinkItems.length > 0 && (
        <div className="reorder-vendor-card reorder-nolink-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <Link2Off size={18} />
              <h4 className="reorder-vendor-name">No Reorder Link</h4>
              <span className="reorder-vendor-count">
                {noLinkItems.length} item{noLinkItems.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <p className="reorder-nolink-hint">
            Click an item name to jump to its reorder link field.
          </p>
          <div className="reorder-item-list">
            {noLinkItems.map((item) => (
              <div key={item.row.id} className="reorder-item-row">
                {onEditReorderLink ? (
                  <button
                    type="button"
                    className="reorder-item-name reorder-item-name-btn"
                    onClick={() => onEditReorderLink(item.row.id)}
                  >
                    {item.itemName}
                  </button>
                ) : (
                  <span className="reorder-item-name">{item.itemName}</span>
                )}
                <span className={`reorder-item-status reorder-status-${item.status}`}>
                  {item.statusLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mobileChecklist && (
        <div className="reorder-mobile-checklist">
          <div className="reorder-mobile-checklist-header">
            <div>
              <h4 className="reorder-mobile-checklist-title">{mobileChecklist.group.domain}</h4>
              <p className="reorder-mobile-checklist-subtitle">
                {mobileChecklist.checkedItems.size}/{mobileChecklist.group.items.length} items
              </p>
            </div>
            <button
              type="button"
              className="reorder-mobile-checklist-close"
              onClick={() => setMobileChecklist(null)}
              aria-label="Close checklist"
            >
              <X size={18} />
            </button>
          </div>
          <div className="reorder-mobile-checklist-progress">
            <div
              className="reorder-mobile-checklist-progress-fill"
              style={{ width: `${mobileChecklist.group.items.length > 0 ? (mobileChecklist.checkedItems.size / mobileChecklist.group.items.length) * 100 : 0}%` }}
            />
          </div>
          <div className="reorder-mobile-checklist-items">
            {mobileChecklist.group.items.map((item, index) => {
              const isChecked = mobileChecklist.checkedItems.has(index);
              return (
                <div key={item.row.id} className={`reorder-mobile-checklist-item${isChecked ? " checked" : ""}`}>
                  <button
                    type="button"
                    className={`reorder-mobile-checkbox${isChecked ? " checked" : ""}`}
                    onClick={() => {
                      setMobileChecklist((prev) => {
                        if (!prev) return null;
                        const next = new Set(prev.checkedItems);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return { ...prev, checkedItems: next };
                      });
                    }}
                  >
                    {isChecked && <Check size={14} />}
                  </button>
                  <div className="reorder-mobile-checklist-item-info">
                    <a
                      href={item.reorderLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="reorder-mobile-checklist-item-name"
                      onClick={() => {
                        setMobileChecklist((prev) => {
                          if (!prev) return null;
                          const next = new Set(prev.checkedItems);
                          next.add(index);
                          return { ...prev, checkedItems: next };
                        });
                      }}
                    >
                      {item.itemName}
                      <ExternalLink size={12} />
                    </a>
                    <span className="reorder-mobile-checklist-item-detail">{item.statusLabel}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {mobileChecklist.checkedItems.size > 0 && onMarkOrdered && (
            <div className="reorder-mobile-checklist-footer">
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  const checkedRowIds = mobileChecklist.group.items
                    .filter((_, i) => mobileChecklist.checkedItems.has(i))
                    .map((item) => item.row.id);
                  onMarkOrdered(checkedRowIds);
                  setMobileChecklist(null);
                }}
              >
                Mark as Ordered
              </button>
            </div>
          )}
        </div>
      )}

      {orderedItems.length > 0 && (
        <div className="reorder-vendor-card reorder-ordered-card app-card">
          <div className="reorder-vendor-header">
            <div className="reorder-vendor-info">
              <PackageCheck size={18} />
              <h4 className="reorder-vendor-name">Ordered</h4>
              <span className="reorder-vendor-count">
                {orderedItems.length} item{orderedItems.length !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
          <div className="reorder-item-list">
            {orderedItems.map((item) => {
              const orderedAt = String(item.row.values.orderedAt ?? "");
              const daysAgo = orderedAt
                ? Math.floor((Date.now() - new Date(orderedAt).getTime()) / (1000 * 60 * 60 * 24))
                : null;
              return (
                <div key={item.row.id} className="reorder-item-row">
                  <span className="reorder-item-name">{item.itemName}</span>
                  <span className="reorder-item-ordered-info">
                    {daysAgo !== null && daysAgo > 0
                      ? `Ordered ${daysAgo}d ago`
                      : "Ordered today"}
                    {onClearOrderedAt && (
                      <button
                        type="button"
                        className="reorder-undo-btn"
                        title="Move back to reorder list"
                        onClick={() => onClearOrderedAt([item.row.id])}
                      >
                        <Undo2 size={14} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
