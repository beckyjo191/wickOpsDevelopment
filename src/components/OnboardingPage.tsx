import { useState } from "react";
import { applyIndustryTemplate } from "../lib/inventoryApi";
import { Flame, Wrench, Zap, Wind, UtensilsCrossed, Stethoscope, Monitor, Package, type LucideIcon } from "lucide-react";

type TemplateColumn = { label: string; type: string };
type IndustryTemplate = { id: string; name: string; description: string; columns: TemplateColumn[] };

const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    id: "fire_ems",
    name: "Fire / EMS",
    description: "Equipment, PPE, and apparatus inventory for fire and EMS departments.",
    columns: [
      { label: "Location", type: "text" },
      { label: "Vehicle/Unit", type: "text" },
      { label: "Serial Number", type: "text" },
      { label: "Last Inspected", type: "date" },
      { label: "Condition", type: "text" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "plumbing",
    name: "Plumbing",
    description: "Parts, fittings, and supplies for plumbing contractors.",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Size/Spec", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Location", type: "text" },
      { label: "Unit Cost", type: "number" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "electrical",
    name: "Electrical",
    description: "Electrical components and supplies for electricians and contractors.",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Voltage/Amperage", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Location", type: "text" },
      { label: "Unit Cost", type: "number" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "hvac",
    name: "HVAC",
    description: "Parts and equipment for HVAC technicians.",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Size/Spec", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Location", type: "text" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "restaurant",
    name: "Restaurant / Food Service",
    description: "Ingredients, supplies, and equipment for food service operations.",
    columns: [
      { label: "Category", type: "text" },
      { label: "Unit", type: "text" },
      { label: "Supplier", type: "text" },
      { label: "Storage Location", type: "text" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "medical",
    name: "Medical / Healthcare",
    description: "Medical supplies and equipment tracking for clinics and healthcare providers.",
    columns: [
      { label: "Category", type: "text" },
      { label: "Lot Number", type: "text" },
      { label: "Storage Location", type: "text" },
      { label: "Controlled", type: "boolean" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "it_tech",
    name: "IT / Technology",
    description: "Hardware, software licenses, and tech asset tracking.",
    columns: [
      { label: "Asset Tag", type: "text" },
      { label: "Serial Number", type: "text" },
      { label: "Assigned To", type: "text" },
      { label: "Location", type: "text" },
      { label: "Purchase Date", type: "date" },
      { label: "Notes", type: "text" },
    ],
  },
  {
    id: "general",
    name: "General / Office",
    description: "General purpose inventory for offices and small businesses.",
    columns: [
      { label: "Category", type: "text" },
      { label: "Location", type: "text" },
      { label: "Notes", type: "text" },
    ],
  },
];

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  fire_ems: Flame,
  plumbing: Wrench,
  electrical: Zap,
  hvac: Wind,
  restaurant: UtensilsCrossed,
  medical: Stethoscope,
  it_tech: Monitor,
  general: Package,
};

interface OnboardingPageProps {
  orgName: string;
  onComplete: () => void;
}

export function OnboardingPage({ orgName, onComplete }: OnboardingPageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [doNotShowAgain, setDoNotShowAgain] = useState(false);

  const selected = INDUSTRY_TEMPLATES.find((t) => t.id === selectedId) ?? null;

  const handleApply = async (templateId: string | null) => {
    setApplying(true);
    setError("");
    try {
      await applyIndustryTemplate(templateId ?? "skip");
      onComplete();
    } catch (err: any) {
      if (templateId === null) {
        // Skip was chosen — proceed even if the API call failed.
        onComplete();
        return;
      }
      setError(err?.message ?? "Something went wrong. Please try again.");
      setApplying(false);
    }
  };

  return (
    <section className="onboarding-overlay">
      <div className="onboarding-card">
        <header className="onboarding-header">
          <h2 className="onboarding-title">Welcome to WickOps</h2>
          <p className="onboarding-subtitle">
            {orgName ? `Let's set up ${orgName}.` : "Let's set up your organization."}
            {" "}Choose your industry to pre-populate relevant inventory columns, or skip to start from scratch.
          </p>
        </header>

        <div className="onboarding-body">
          <div className="onboarding-grid">
            {INDUSTRY_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`onboarding-template-card${selectedId === template.id ? " onboarding-template-card-selected" : ""}`}
                onClick={() => setSelectedId((prev) => prev === template.id ? null : template.id)}
                disabled={applying}
              >
                <span className="onboarding-template-icon" aria-hidden="true">
                  {(() => { const Icon = TEMPLATE_ICONS[template.id]; return Icon ? <Icon size={22} strokeWidth={1.5} /> : null; })()}
                </span>
                <span className="onboarding-template-name">{template.name}</span>
                <span className="onboarding-template-desc">{template.description}</span>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="onboarding-preview">
              <p className="onboarding-preview-title">
                Columns that will be added for <strong>{selected.name}</strong>:
              </p>
              <ul className="onboarding-preview-columns">
                <li className="onboarding-preview-column onboarding-preview-column-core">Item Name</li>
                <li className="onboarding-preview-column onboarding-preview-column-core">Quantity</li>
                <li className="onboarding-preview-column onboarding-preview-column-core">Min Quantity</li>
                <li className="onboarding-preview-column onboarding-preview-column-core">Expiration Date</li>
                {selected.columns.map((col) => (
                  <li key={col.label} className="onboarding-preview-column">
                    {col.label}
                    <span className="onboarding-preview-column-type">{col.type}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {error ? <p className="onboarding-error">{error}</p> : null}

        <footer className="onboarding-footer">
          <button
            type="button"
            className="button button-primary"
            disabled={applying || !selectedId}
            onClick={() => void handleApply(selectedId)}
          >
            {applying ? "Setting up…" : "Apply & Get Started"}
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={applying}
            onClick={() => {
              if (doNotShowAgain) {
                void handleApply(null);
              } else {
                onComplete();
              }
            }}
          >
            Skip for now
          </button>
          <label className="onboarding-do-not-show">
            <input
              type="checkbox"
              checked={doNotShowAgain}
              onChange={(e) => setDoNotShowAgain(e.target.checked)}
              disabled={applying}
            />
            Don't show this again
          </label>
        </footer>
      </div>
    </section>
  );
}
