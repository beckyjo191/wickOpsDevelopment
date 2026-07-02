// ── Item detail modal (1g.4) ────────────────────────────────────────────────
// Per-item vendor pricing manager. Replaces the prior pattern of stuffing
// vendor / unitCost / packSize / packCost / reorderLink into the inventory
// row itself — those fields are vendor-specific (Costco's box of 100 vs
// BoundTree's box of 50 for the same item) and don't belong on a single
// row.
//
// State model: the bootstrap-loaded `vendorPricingMap` is the source of
// truth in memory. Save calls go through `upsertItemVendorPricing`, which
// handles optimistic locking via `expectedLastUpdatedAt`. On conflict (409),
// we re-render with the server's current row so the user sees what changed.
// On success we update the in-memory map directly — no bootstrap roundtrip.

import { useEffect, useMemo, useState } from "react";
import { History, Plus, Trash2, X } from "lucide-react";
import {
  upsertItemVendorPricing,
  deleteItemVendorPricing,
  isVendorPricingConflictError,
  type ItemVendorPricingEntry,
} from "../../lib/inventoryApi";
import { formatCurrency, parseCurrency } from "../../lib/currency";
import { dimensionForUnit } from "../../lib/uom";
import { VendorSelect } from "../ReorderTab";
import { useToast } from "../shared/Toast";

interface ItemDetailModalProps {
  itemId: string;
  itemName: string;
  /** Vendor pricing rows for this item (already filtered by parent). */
  pricing: ItemVendorPricingEntry[];
  availableVendors: string[];
  /** 1h.6: org's curated unit list (Settings → Units of measurement). When
   *  non-empty, the per-vendor unit dropdown limits options to these.
   *  Empty array → show the full KNOWN_UNITS master list. */
  allowedUnits?: string[];
  /** Org-wide UoM gate. Currently ignored by the form — unit-of-measure
   *  capture is hidden everywhere during the EMS warm-market push. Kept
   *  in the prop list so callers don't need to change shape. */
  tracksUnits?: boolean;
  onClose: () => void;
  /** Update the parent's in-memory map. The parent owns the Map<itemId,
   *  Map<vendorLower, entry>>; this callback patches a single entry. */
  onPricingUpserted: (entry: ItemVendorPricingEntry) => void;
  /** Remove a pricing row from the parent's in-memory map. */
  onPricingDeleted: (id: string) => void;
  /** Open the full item history in the Activity tab (deep-link from the
   *  embedded History view). When omitted, the "See full activity" link is
   *  hidden — the embedded cost-over-time view still works on its own. */
  onOpenActivityHistory?: (itemId: string, itemName: string) => void;
  /** Adds a new vendor to the org's registered list. Wired to VendorSelect's
   *  inline "+ Add" affordance so users can record a new vendor without
   *  bouncing to Settings first. */
  onAddVendor?: (name: string) => Promise<void>;
}

/** Row-edit draft state. The form holds string-typed values (so the user can
 *  clear an input) and parses on save.
 *
 *  1h.7: dual-axis pack contents.
 *   - `packCount` — number of items in one pack (10 apples, 100 gauze).
 *   - `packAmount` + `packAmountUnit` — weight/volume in one pack (5 lb,
 *     16 fl oz). Unit MUST be a weight or volume unit; count units belong
 *     on `packCount`.
 *  The form uses a Single/Pack mode toggle to disclose progressively:
 *   - Single mode → just Amount + Unit + Cost (5 lb of flour for $4.99).
 *   - Pack mode   → Pack + Amount + Unit + Cost (10-ct, 5-lb bag of
 *     apples for $4.99).
 *  Either, both, or neither may be set. Saving a row with neither still
 *  works — it records cost only ($X for one pack of unspecified shape). */
type Draft = {
  vendor: string;
  /** Form-only UX mode. Drives which fields render and how `packCount`
   *  serializes. Not persisted on the row directly — the presence of
   *  `packCount` in the saved row IS the mode marker on read. */
  mode: "single" | "pack";
  packCount: string;
  packAmount: string;
  packAmountUnit: string;
  packCost: string;
  reorderUrl: string;
  /** Optimistic-lock token. Empty string for new (not-yet-persisted) rows. */
  expectedLastUpdatedAt: string;
  /** The inventory ROW this entry is stored on. Because pricing is aggregated
   *  across lots for display, the edited entry may live on a different lot than
   *  the one the modal opened — edits must target its own row so the optimistic
   *  lock matches and we update in place instead of forking a new entry.
   *  Empty for new entries (they're created on the opened row). */
  sourceItemId: string;
};

const blankDraft = (): Draft => ({
  vendor: "",
  // Default to Single — most flour-style purchases (just buying weight)
  // don't need a pack count. Users opt into Pack when the item actually
  // comes packaged with countable units.
  mode: "single",
  packCount: "",
  packAmount: "",
  packAmountUnit: "",
  packCost: "",
  reorderUrl: "",
  expectedLastUpdatedAt: "",
  sourceItemId: "",
});

const draftFromEntry = (entry: ItemVendorPricingEntry): Draft => {
  // Legacy → new migration on read: rows from before 1h.7 store a count
  // pack as `packSize` instead of `packCount`. Surface either in the
  // count field so the form shows existing data.
  const countValue = entry.packCount ?? entry.packSize;
  // Mode inference: rows with a count axis are Pack-mode; rows with only
  // a bulk amount (or neither) are Single-mode. New rows from the i modal
  // pick mode explicitly via the toggle.
  const mode: "single" | "pack" = countValue !== undefined ? "pack" : "single";
  return {
    vendor: entry.vendor,
    mode,
    packCount: countValue !== undefined ? String(countValue) : "",
    packAmount: entry.packAmount !== undefined ? String(entry.packAmount) : "",
    packAmountUnit: entry.packAmountUnit ?? "",
    packCost: entry.packCost !== undefined ? formatCurrency(entry.packCost) : "",
    reorderUrl: entry.reorderUrl ?? "",
    expectedLastUpdatedAt: entry.lastUpdatedAt,
    sourceItemId: entry.itemId,
  };
};

/** Build the price-per-unit summary text for one (item, vendor) row.
 *
 *  Combines whichever axes the row carries:
 *    - packCount only:       "$0.50/ct · pack of 10 for $5.00"
 *    - packAmount only:      "$0.998/lb · 5 lb pack for $4.99"
 *    - both:                 "$0.499/ct · $0.998/lb · 5 lb / 10 ct for $4.99"
 *    - cost only:            "$5.00/pack" (rare; user recorded total only)
 *    - legacy unitCost only: "$0.50/unit" — fallback for pre-1h.7 rows.
 *  Returns an empty fragment when the row carries no priced fields. */
const renderPricingSummary = (entry: ItemVendorPricingEntry): string => {
  const cost = entry.packCost;
  // Prefer the new dual-axis fields; fall back to legacy packSize when
  // packCount is missing so old rows keep displaying their pack count.
  const count = entry.packCount ?? entry.packSize;
  const amount = entry.packAmount;
  const amountUnit = entry.packAmountUnit;
  const label = entry.packLabel || "pack";

  const parts: string[] = [];

  if (cost !== undefined && count !== undefined && count > 0) {
    parts.push(`${formatCurrency(cost / count)}/ct`);
  }
  if (cost !== undefined && amount !== undefined && amount > 0 && amountUnit) {
    parts.push(`${formatCurrency(cost / amount)}/${amountUnit}`);
  }

  // Compose the "what's in the pack" descriptor. Both axes → "5 lb / 10 ct";
  // count only → "10 ct"; amount only → "5 lb"; neither → just "pack".
  const packDescriptor = (() => {
    const bits: string[] = [];
    if (amount !== undefined && amountUnit) bits.push(`${amount} ${amountUnit}`);
    if (count !== undefined) bits.push(`${count} ct`);
    return bits.length > 0 ? bits.join(" / ") : null;
  })();

  if (cost !== undefined) {
    if (packDescriptor) {
      parts.push(`${packDescriptor} for ${formatCurrency(cost)}`);
    } else {
      parts.push(`${formatCurrency(cost)}/${label}`);
    }
  } else if (packDescriptor) {
    // No cost recorded — still surface the pack shape so users can see
    // what they entered.
    parts.push(packDescriptor);
  }

  // Legacy fallback: pre-1h.7 rows that only have unitCost. Keep them
  // readable so users can find them and re-save into the new shape.
  if (parts.length === 0 && entry.unitCost !== undefined) {
    parts.push(`${formatCurrency(entry.unitCost)}/unit`);
  }

  return parts.join(" · ");
};

export function ItemDetailModal({
  itemId,
  itemName,
  pricing,
  availableVendors,
  allowedUnits,
  tracksUnits,
  onClose,
  onPricingUpserted,
  onPricingDeleted,
  onAddVendor,
  onOpenActivityHistory,
}: ItemDetailModalProps) {
  const toast = useToast();
  /** Either the id of the row currently being edited, or "new" for the
   *  add-form, or null when no editor is open. */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [saving, setSaving] = useState(false);

  // Esc closes the modal — fast escape hatch when nothing's being edited.
  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onClose]);

  // Vendor names already used on this item — filtered from the picker so the
  // user doesn't accidentally create two rows for "Costco" with different
  // casing. The vendorLower comparison is what the server enforces anyway.
  const usedVendorLowers = useMemo(
    () => new Set(pricing.map((p) => p.vendorLower)),
    [pricing],
  );
  const availableForAdd = useMemo(
    () => availableVendors.filter((v) => !usedVendorLowers.has(v.trim().toLowerCase())),
    [availableVendors, usedVendorLowers],
  );

  const startEdit = (entry: ItemVendorPricingEntry) => {
    setDraft(draftFromEntry(entry));
    setEditing(entry.id);
  };

  const startAdd = () => {
    setDraft(blankDraft());
    setEditing("new");
  };

  const cancelEdit = () => {
    setDraft(blankDraft());
    setEditing(null);
  };

  const handleSave = async () => {
    const vendor = draft.vendor.trim();
    if (!vendor) { toast.error("Pick a vendor."); return; }

    const parseOptional = (raw: string, label: string): number | undefined | "error" => {
      if (!raw.trim()) return undefined;
      const n = parseCurrency(raw);
      if (!Number.isFinite(n) || n < 0) {
        toast.error(`${label} must be a non-negative number.`);
        return "error";
      }
      return n;
    };
    const packCost = parseOptional(draft.packCost, "Pack cost");
    if (packCost === "error") return;

    // 1h.7: route the form's Amount + Unit fields onto the right
    // schema axis depending on mode + unit dimension.
    //
    // Pack mode:
    //   - Pack(s)        → packCount       (always count of items)
    //   - Amount + Unit  → packAmount + packAmountUnit (weight/volume
    //                       only — Pack mode dropdown is filtered)
    //
    // Single mode (no Pack(s) field):
    //   - Amount + Unit, where Unit is a count unit (ct/dozen) →
    //                       packCount (e.g. "3 catheters at $5/each")
    //   - Amount + Unit, where Unit is weight/volume →
    //                       packAmount + packAmountUnit (e.g. "5 lb
    //                       flour for $4.99")
    const amountUnitRaw = draft.packAmountUnit.trim().toLowerCase();
    const amountUnitDim = amountUnitRaw ? dimensionForUnit(amountUnitRaw) : null;

    let packCount: number | undefined;
    let packAmount: number | undefined;
    let packAmountUnit: string | undefined;

    if (draft.mode === "pack") {
      if (draft.packCount.trim()) {
        const n = Number(draft.packCount);
        if (!Number.isFinite(n) || n <= 0) { toast.error("Pack must be > 0."); return; }
        packCount = n;
      }
      if (draft.packAmount.trim()) {
        const n = Number(draft.packAmount);
        if (!Number.isFinite(n) || n <= 0) { toast.error("Amount per pack must be > 0."); return; }
        packAmount = n;
      }
      // Unit-of-measure capture is hidden from the form for now (EMS warm
      // market). Preserve any legacy unit on draft so editing an item that
      // already has one doesn't silently strip the value.
      packAmountUnit = amountUnitRaw || undefined;
    } else {
      // Single mode
      if (draft.packAmount.trim()) {
        const n = Number(draft.packAmount);
        if (!Number.isFinite(n) || n <= 0) { toast.error("Amount must be > 0."); return; }
        if (!amountUnitRaw) {
          toast.error("Pick a unit for the amount.");
          return;
        }
        if (amountUnitDim === "count") {
          // "3 catheters" — store on the count axis.
          packCount = n;
        } else {
          // "5 lb of flour" — weight/volume axis.
          packAmount = n;
          packAmountUnit = amountUnitRaw;
        }
      }
    }

    setSaving(true);
    try {
      // Edits target the entry's own lot row (draft.sourceItemId); new entries
      // are created on the row the modal opened (itemId).
      const targetItemId = draft.sourceItemId || itemId;
      const entry = await upsertItemVendorPricing({
        itemId: targetItemId,
        vendor,
        ...(packCount !== undefined ? { packCount } : {}),
        ...(packAmount !== undefined ? { packAmount } : {}),
        ...(packAmountUnit ? { packAmountUnit } : {}),
        ...(packCost !== undefined ? { packCost } : {}),
        ...(draft.reorderUrl.trim() ? { reorderUrl: draft.reorderUrl.trim() } : {}),
        ...(draft.expectedLastUpdatedAt
          ? { expectedLastUpdatedAt: draft.expectedLastUpdatedAt }
          : {}),
      });
      onPricingUpserted(entry);
      cancelEdit();
    } catch (err) {
      if (isVendorPricingConflictError(err) && err.current) {
        // Someone else saved this row first — patch the parent map with
        // their version and switch the editor to it so the user can review
        // the diff and re-apply their change on top.
        onPricingUpserted(err.current);
        setDraft(draftFromEntry(err.current));
        toast.error("Another user updated this pricing. Latest values loaded — review and save again.");
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to save pricing.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (entry: ItemVendorPricingEntry) => {
    if (!confirm(`Delete ${entry.vendor} pricing for ${itemName}?`)) return;
    setSaving(true);
    try {
      // `pricing` holds every lot's raw entries; a vendor may have one per lot.
      // Delete them all so removing a vendor sticks across the logical item
      // (otherwise a sibling lot's entry would resurface on the next render).
      const targets = pricing.filter((p) => p.vendorLower === entry.vendorLower);
      for (const t of (targets.length > 0 ? targets : [entry])) {
        await deleteItemVendorPricing(t.id);
        onPricingDeleted(t.id);
      }
      if (editing === entry.id) cancelEdit();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete pricing.");
    } finally {
      setSaving(false);
    }
  };

  // `pricing` is the raw union across all lots of this logical item, so a
  // vendor can appear more than once. Collapse to the freshest entry per vendor
  // for display (mirrors the read-time aggregation used everywhere else).
  const sortedPricing = useMemo(() => {
    const freshest = new Map<string, ItemVendorPricingEntry>();
    for (const p of pricing) {
      const cur = freshest.get(p.vendorLower);
      if (!cur || String(p.lastUpdatedAt) > String(cur.lastUpdatedAt)) freshest.set(p.vendorLower, p);
    }
    return [...freshest.values()].sort((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" }));
  }, [pricing]);

  // 1h.7: detect mixed-unit pricing across vendors. If two vendors sell
  // this item in non-comparable units — Costco in `lb` and the corner
  // store in `ct` only, with no shared count axis — best-price comparison
  // is moot. We don't restrict; we just surface a soft note so the user
  // knows why "cheapest" can't be picked. Sharing a count axis (both
  // record packCount) IS comparable on $/ct even if their bulk units
  // differ, so we treat that as fine.
  const mixedUnitWarning = useMemo(() => {
    // Compare the one-per-vendor display rows (sortedPricing), not the raw lot
    // union — otherwise two lots of the same vendor could read as "mixed."
    if (sortedPricing.length < 2) return null;
    const amountUnits = new Set(
      sortedPricing.map((p) => (p.packAmountUnit ?? "").trim()).filter((u) => u.length > 0),
    );
    const allHaveCount = sortedPricing.every((p) => p.packCount !== undefined || p.packSize !== undefined);
    // If every vendor has a count axis, $/ct is comparable across them
    // → no warning needed (different bulk units don't matter).
    if (allHaveCount) return null;
    // Otherwise: more than one bulk unit, OR a mix of count-only and
    // bulk-only vendors → flag.
    if (amountUnits.size > 1) {
      return `This item is priced in different units across vendors (${Array.from(amountUnits).join(", ")}). Best-price comparison won't pick a winner.`;
    }
    const someCount = sortedPricing.some((p) => p.packCount !== undefined || p.packSize !== undefined);
    const someAmount = sortedPricing.some((p) => p.packAmount !== undefined);
    if (someCount && someAmount) {
      return "This item has count-based and bulk-based vendors. Each price is shown per its own unit; they're not directly comparable.";
    }
    return null;
  }, [sortedPricing]);

  return (
    <div
      className="item-detail-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget && !editing) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`Vendor pricing for ${itemName}`}
    >
      <div className="item-detail-modal">
        <header className="item-detail-modal-header">
          <div>
            <h2 className="item-detail-modal-title">{itemName}</h2>
            <p className="item-detail-modal-subtitle">Vendor pricing</p>
          </div>
          <div className="item-detail-modal-header-actions">
            {/* History opens the full item history (Activity → Cost over time)
             *  rather than an embedded popover — one canonical history surface,
             *  and this is the easy way into it. */}
            {onOpenActivityHistory ? (
              <button
                type="button"
                className="button button-sm button-ghost item-detail-modal-history-btn"
                onClick={() => onOpenActivityHistory(itemId, itemName)}
                disabled={!!editing}
                title="View this item's full history"
              >
                <History size={14} /> History
              </button>
            ) : null}
            <button
              type="button"
              className="item-detail-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="item-detail-modal-body">
          {/* 1h.7: soft mixed-unit notice. Doesn't block anything — just
           *  tells the user why best-price comparison can't pick a winner
           *  when their vendors aren't priced in comparable units. */}
          {mixedUnitWarning ? (
            <p className="item-detail-modal-warning" role="status">
              {mixedUnitWarning}
            </p>
          ) : null}
          {sortedPricing.length === 0 && editing !== "new" ? (
            <p className="item-detail-modal-empty">
              No vendor pricing yet. Add one to start tracking what you pay where.
            </p>
          ) : (
            <ul className="item-detail-modal-list">
              {sortedPricing.map((entry) => (
                <li key={entry.id} className="item-detail-modal-row">
                  {editing === entry.id ? (
                    <PricingForm
                      draft={draft}
                      setDraft={setDraft}
                      vendorLocked={true}
                      allowedUnits={allowedUnits}
                      tracksUnits={tracksUnits ?? false}
                      saving={saving}
                      onSave={handleSave}
                      onCancel={cancelEdit}
                    />
                  ) : (
                    <div className="item-detail-row-summary">
                      <div className="item-detail-row-info">
                        <strong className="item-detail-row-vendor">{entry.vendor}</strong>
                        <span className="item-detail-row-pricing">
                          {renderPricingSummary(entry)}
                        </span>
                        {entry.reorderUrl ? (
                          <a
                            href={entry.reorderUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="item-detail-row-link"
                          >
                            Open product page →
                          </a>
                        ) : null}
                      </div>
                      <div className="item-detail-row-actions">
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          onClick={() => startEdit(entry)}
                          disabled={saving}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="button button-ghost button-sm item-detail-row-delete"
                          onClick={() => void handleDelete(entry)}
                          disabled={saving}
                          aria-label={`Delete ${entry.vendor} pricing`}
                          title={`Delete ${entry.vendor} pricing`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {editing === "new" ? (
            <div className="item-detail-modal-add-form">
              <PricingForm
                draft={draft}
                setDraft={setDraft}
                vendorLocked={false}
                vendorOptions={availableForAdd}
                allowedUnits={allowedUnits}
                tracksUnits={tracksUnits ?? false}
                onAddVendor={onAddVendor}
                saving={saving}
                onSave={handleSave}
                onCancel={cancelEdit}
              />
            </div>
          ) : (
            <button
              type="button"
              className="button button-secondary button-sm item-detail-modal-add-btn"
              onClick={startAdd}
              disabled={saving}
            >
              <Plus size={14} /> Add vendor pricing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline form for adding or editing one (item, vendor) pricing entry. The
 *  vendor field is a typeahead on add (same picker as New Order — pick an
 *  existing vendor or type a new one inline) and a locked label on edit
 *  (the vendor is part of the row's identity — changing it would mean
 *  delete + create). */
function PricingForm({
  draft,
  setDraft,
  vendorLocked,
  vendorOptions,
  allowedUnits,
  tracksUnits,
  onAddVendor,
  saving,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  vendorLocked: boolean;
  vendorOptions?: string[];
  /** Curated unit list from Settings → Units of measurement. The
   *  packAmount unit dropdown intersects this with weight+volume only
   *  (count units like ct/dozen belong on packCount instead). */
  allowedUnits?: string[];
  /** Currently ignored by the form — see prop docs above. */
  tracksUnits: boolean;
  onAddVendor?: (name: string) => Promise<void>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  // Reorder URL is optional — hide behind a "+ Add reorder URL" disclosure
  // until needed. Auto-revealed when editing a row that already has one.
  const [showUrl, setShowUrl] = useState<boolean>(Boolean(draft.reorderUrl.trim()));
  // Unit-of-measure capture is hidden for now (EMS warm market). The
  // `tracksUnits` / `allowedUnits` props stay in the API for callers, but
  // the form ignores them so every org sees the same simplified shape.
  void allowedUnits;
  void tracksUnits;

  return (
    <div className="item-detail-pricing-form">
      <div className="item-detail-pricing-grid">
        <label className="item-detail-pricing-field item-detail-pricing-field--wide">
          <span className="field-label">Vendor</span>
          {vendorLocked ? (
            <strong className="item-detail-pricing-vendor-locked">{draft.vendor}</strong>
          ) : (
            <VendorSelect
              value={draft.vendor}
              availableVendors={vendorOptions ?? []}
              onChange={(v) => update({ vendor: v })}
              onAddVendor={onAddVendor}
              disabled={saving}
              ariaLabel="Vendor"
              placeholder="Choose or type to add new"
            />
          )}
        </label>

        {/* 1h.7: Single|Pack mode toggle. Single = "I bought weight or
         *  volume directly" (5 lb of flour). Pack = "this comes in a
         *  pack with countable items" (10 apples in a 5-lb bag, 100
         *  gauze in a box). Single mode hides the Pack field; Pack
         *  mode reveals it. The Amount + Unit fields appear in both —
         *  they're optional in Pack mode (count-only packs like gauze). */}
        <div className="item-detail-pricing-field item-detail-pricing-field--wide">
          <span className="field-label">Type</span>
          <div className="reorder-price-mode" role="tablist" aria-label="Pricing type">
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === "single"}
              className={`reorder-price-mode-btn${draft.mode === "single" ? " active" : ""}`}
              onClick={() => update({ mode: "single", packCount: "" })}
              disabled={saving}
            >
              Single
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={draft.mode === "pack"}
              className={`reorder-price-mode-btn${draft.mode === "pack" ? " active" : ""}`}
              onClick={() => update({ mode: "pack" })}
              disabled={saving}
            >
              Pack
            </button>
          </div>
        </div>

        {/* Pack mode shows Pack(s) + Amount per pack side-by-side. EMS warm
         *  market doesn't need a unit of measure on the inner amount, so
         *  "Amount per pack" is a plain count (e.g. "10 syringes per box").
         *  Single mode shows only the Cost field below. */}
        {draft.mode === "pack" ? (
          <>
            <label className="item-detail-pricing-field">
              <span className="field-label">Pack(s)</span>
              <input
                className="field"
                type="number"
                min="0"
                step="any"
                placeholder="1"
                value={draft.packCount}
                onChange={(e) => update({ packCount: e.target.value })}
                disabled={saving}
                aria-label="Number of packs"
              />
            </label>

            <label className="item-detail-pricing-field">
              <span className="field-label">Amount per pack</span>
              <input
                className="field"
                type="number"
                min="0"
                step="any"
                placeholder="10"
                value={draft.packAmount}
                onChange={(e) => update({ packAmount: e.target.value })}
                disabled={saving}
                aria-label="Number of items in one pack"
              />
            </label>
          </>
        ) : null}

        <label className="item-detail-pricing-field">
          <span className="field-label">
            {draft.mode === "pack" ? "Pack cost" : "Cost"}
          </span>
          <input
            className="field"
            type="text"
            inputMode="decimal"
            placeholder="$0.00"
            value={draft.packCost}
            onChange={(e) => update({ packCost: e.target.value })}
            disabled={saving}
          />
        </label>

        {/* Reorder URL is optional — hide behind a disclosure until needed. */}
        {!showUrl ? (
          <div className="item-detail-pricing-field item-detail-pricing-field--wide item-detail-pricing-add-row">
            <button
              type="button"
              className="button button-ghost button-sm item-detail-pricing-add-btn"
              onClick={() => setShowUrl(true)}
              disabled={saving}
            >
              <Plus size={14} /> Add reorder URL
            </button>
          </div>
        ) : null}

        {showUrl ? (
          <label className="item-detail-pricing-field item-detail-pricing-field--wide">
            <span className="field-label">Reorder URL</span>
            <input
              className="field"
              type="text"
              placeholder="https://..."
              value={draft.reorderUrl}
              onChange={(e) => update({ reorderUrl: e.target.value })}
              disabled={saving}
              autoFocus
            />
          </label>
        ) : null}
      </div>
      <div className="item-detail-pricing-actions">
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary button-sm"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
