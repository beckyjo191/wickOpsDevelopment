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
import { Plus, Trash2, X } from "lucide-react";
import {
  upsertItemVendorPricing,
  deleteItemVendorPricing,
  isVendorPricingConflictError,
  type ItemVendorPricingEntry,
} from "../../lib/inventoryApi";
import { formatCurrency, parseCurrency } from "../../lib/currency";
import { KNOWN_UNITS, dimensionForUnit } from "../../lib/uom";
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
  /** 1h.7: org-wide gate. When false (EMS-style default), the form
   *  hides Amount/Unit fields entirely — the user just sees Vendor,
   *  Type, [Pack(s)], Cost. When true, Amount + Unit become available
   *  behind the "+ Add unit" disclosure for weight/volume capture. */
  tracksUnits?: boolean;
  onClose: () => void;
  /** Update the parent's in-memory map. The parent owns the Map<itemId,
   *  Map<vendorLower, entry>>; this callback patches a single entry. */
  onPricingUpserted: (entry: ItemVendorPricingEntry) => void;
  /** Remove a pricing row from the parent's in-memory map. */
  onPricingDeleted: (id: string) => void;
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
  };
};

/** Filter KNOWN_UNITS down to weight + volume units only (no count units).
 *  Used by the `packAmountUnit` dropdown — count units belong on packCount,
 *  not the bulk-amount axis. */
const WEIGHT_VOLUME_UNITS: string[] = KNOWN_UNITS.filter((u) => {
  const dim = dimensionForUnit(u);
  return dim === "weight" || dim === "volume";
});

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
      packAmountUnit = amountUnitRaw || undefined;
      if (packAmount !== undefined && !packAmountUnit) {
        toast.error("Pick a unit for the amount (lb, oz, fl oz, etc.).");
        return;
      }
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
      const entry = await upsertItemVendorPricing({
        itemId,
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
      await deleteItemVendorPricing(entry.id);
      onPricingDeleted(entry.id);
      if (editing === entry.id) cancelEdit();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete pricing.");
    } finally {
      setSaving(false);
    }
  };

  const sortedPricing = useMemo(
    () => [...pricing].sort((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: "base" })),
    [pricing],
  );

  // 1h.7: detect mixed-unit pricing across vendors. If two vendors sell
  // this item in non-comparable units — Costco in `lb` and the corner
  // store in `ct` only, with no shared count axis — best-price comparison
  // is moot. We don't restrict; we just surface a soft note so the user
  // knows why "cheapest" can't be picked. Sharing a count axis (both
  // record packCount) IS comparable on $/ct even if their bulk units
  // differ, so we treat that as fine.
  const mixedUnitWarning = useMemo(() => {
    if (pricing.length < 2) return null;
    const amountUnits = new Set(
      pricing.map((p) => (p.packAmountUnit ?? "").trim()).filter((u) => u.length > 0),
    );
    const allHaveCount = pricing.every((p) => p.packCount !== undefined || p.packSize !== undefined);
    // If every vendor has a count axis, $/ct is comparable across them
    // → no warning needed (different bulk units don't matter).
    if (allHaveCount) return null;
    // Otherwise: more than one bulk unit, OR a mix of count-only and
    // bulk-only vendors → flag.
    if (amountUnits.size > 1) {
      return `This item is priced in different units across vendors (${Array.from(amountUnits).join(", ")}). Best-price comparison won't pick a winner.`;
    }
    const someCount = pricing.some((p) => p.packCount !== undefined || p.packSize !== undefined);
    const someAmount = pricing.some((p) => p.packAmount !== undefined);
    if (someCount && someAmount) {
      return "This item has count-based and bulk-based vendors. Each price is shown per its own unit; they're not directly comparable.";
    }
    return null;
  }, [pricing]);

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
          <button
            type="button"
            className="item-detail-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
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
  /** 1h.7: org-wide UoM gate. When false, the form hides the Amount /
   *  Unit fields and the "+ Add unit" disclosure entirely — basic
   *  EMS-style flow. When true, the disclosure surfaces and unlocks
   *  the dual-axis Pack form. */
  tracksUnits: boolean;
  onAddVendor?: (name: string) => Promise<void>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  // Progressive disclosure (1h.7): Amount + Unit and Reorder URL hide
  // behind "+ Add" buttons until the user opts in. Keeps the form
  // compact for items that don't track weight/volume or don't have a
  // vendor URL. Auto-revealed on edit when existing data is present —
  // *regardless* of `tracksUnits`, so a row with legacy weight data
  // doesn't go invisible if the org flips the gate off later (the user
  // can still see / clear the value). The "+ Add unit" button is the
  // only disclosure path that's gated by `tracksUnits`.
  const [showAmount, setShowAmount] = useState<boolean>(
    Boolean(draft.packAmount.trim() || draft.packAmountUnit.trim()),
  );
  const [showUrl, setShowUrl] = useState<boolean>(Boolean(draft.reorderUrl.trim()));
  // Unit dropdown options.
  //   - In Pack mode, the Amount-per-pack field is always weight/volume
  //     (count goes on the separate Pack(s) field), so we filter to
  //     weight + volume units only.
  //   - In Single mode, the Amount field can carry any unit — count
  //     ("3 catheters at $5/each"), weight ("5 lb of flour"), or volume
  //     ("16 fl oz of olive oil"). We include the full curated list.
  const baseWvUnits = (() => {
    const curated = (allowedUnits && allowedUnits.length > 0
      ? allowedUnits.filter((u) => {
          const dim = dimensionForUnit(u);
          return dim === "weight" || dim === "volume";
        })
      : WEIGHT_VOLUME_UNITS);
    return curated.length > 0 ? curated : WEIGHT_VOLUME_UNITS;
  })();
  const baseAllUnits = (allowedUnits && allowedUnits.length > 0
    ? allowedUnits
    : KNOWN_UNITS);
  const baseAmountUnits = draft.mode === "pack" ? baseWvUnits : baseAllUnits;
  const amountUnitOptions = draft.packAmountUnit && !baseAmountUnits.includes(draft.packAmountUnit)
    ? [...baseAmountUnits, draft.packAmountUnit]
    : baseAmountUnits;

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

        {draft.mode === "pack" ? (
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
              aria-label="Number of items in one pack"
            />
          </label>
        ) : null}

        {showAmount ? (
          <>
            <label className="item-detail-pricing-field">
              <span className="field-label">
                {draft.mode === "pack" ? "Amount per pack" : "Amount"}
              </span>
              <input
                className="field"
                type="number"
                min="0"
                step="any"
                placeholder="5"
                value={draft.packAmount}
                onChange={(e) => update({ packAmount: e.target.value })}
                disabled={saving}
                aria-label={
                  draft.mode === "pack"
                    ? "Weight or volume in one pack"
                    : "Weight or volume purchased"
                }
              />
            </label>

            <label className="item-detail-pricing-field">
              <span className="field-label">Unit</span>
              <select
                className="field"
                value={draft.packAmountUnit}
                onChange={(e) => update({ packAmountUnit: e.target.value })}
                disabled={saving}
                aria-label="Unit for the amount"
              >
                <option value=""></option>
                {amountUnitOptions.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
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

        {/* Progressive-disclosure buttons. Compact form for items that
         *  don't track UoM or don't have a vendor URL; one click reveals
         *  the corresponding field set. Buttons live in the wide slot so
         *  they stretch across the grid below the priced fields. The
         *  "+ Add unit" button only appears when the org has tracksUnits
         *  on — EMS-style orgs never see it. */}
        <div className="item-detail-pricing-field item-detail-pricing-field--wide item-detail-pricing-add-row">
          {tracksUnits && !showAmount ? (
            <button
              type="button"
              className="button button-ghost button-sm item-detail-pricing-add-btn"
              onClick={() => setShowAmount(true)}
              disabled={saving}
            >
              <Plus size={14} /> Add unit
            </button>
          ) : null}
          {!showUrl ? (
            <button
              type="button"
              className="button button-ghost button-sm item-detail-pricing-add-btn"
              onClick={() => setShowUrl(true)}
              disabled={saving}
            >
              <Plus size={14} /> Add reorder URL
            </button>
          ) : null}
        </div>

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
