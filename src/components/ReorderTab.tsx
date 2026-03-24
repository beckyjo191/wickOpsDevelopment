import { useMemo, useState } from "react";
import type { InventoryColumn, InventoryRow } from "../lib/inventoryApi";
import { ShoppingCart, ExternalLink, Link2Off, Package } from "lucide-react";

interface ReorderTabProps {
  rows: InventoryRow[];
  columns: InventoryColumn[];
}

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

const openReorderChecklist = (vendorGroup: VendorGroup) => {
  const data = {
    domain: vendorGroup.domain,
    items: vendorGroup.items.map((item) => ({
      name: item.itemName,
      link: item.reorderLink,
      status: item.statusLabel,
      quantity: item.quantity,
      minQuantity: item.minQuantity,
    })),
  };
  const encoded = encodeURIComponent(JSON.stringify(data));
  const checklistUrl = `${window.location.origin}/?reorder-checklist=${encoded}`;
  window.open(
    checklistUrl,
    `wickops-checklist-${vendorGroup.domain}`,
    "width=400,height=620,scrollbars=yes,resizable=yes",
  );
};

const handleReorderVendor = (group: VendorGroup) => {
  // Open the first item's link in a named tab (checklist reuses this same tab)
  const vendorTabName = `wickops-vendor-${group.domain}`;
  window.open(group.items[0].reorderLink, vendorTabName);
  // Open the checklist popup
  openReorderChecklist(group);
};

export function ReorderTab({ rows, columns }: ReorderTabProps) {
  const [reorderedVendors, setReorderedVendors] = useState<Set<string>>(new Set());

  const { vendorGroups, noLinkItems } = useMemo(() => {
    const reorderItems: ReorderItem[] = [];
    const noLink: ReorderItem[] = [];

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
        ? `Expired ${Math.abs(daysUntil!)}d ago`
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

      if (reorderLink) {
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

    return { vendorGroups: groups, noLinkItems: noLink };
  }, [rows]);

  const totalReorderItems = vendorGroups.reduce((sum, g) => sum + g.items.length, 0);

  const handleReorderAll = () => {
    for (const group of vendorGroups) {
      handleReorderVendor(group);
    }
  };

  if (totalReorderItems === 0 && noLinkItems.length === 0) {
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
                handleReorderVendor(group);
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
            Add a reorder link to these items so they appear in vendor groups.
          </p>
          <div className="reorder-item-list">
            {noLinkItems.map((item) => (
              <div key={item.row.id} className="reorder-item-row">
                <span className="reorder-item-name">{item.itemName}</span>
                <span className={`reorder-item-status reorder-status-${item.status}`}>
                  {item.statusLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
