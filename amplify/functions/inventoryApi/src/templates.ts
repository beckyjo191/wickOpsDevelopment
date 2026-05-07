// ── Shared: templates.ts ────────────────────────────────────────────────────
// Industry onboarding templates.

import type { IndustryTemplate } from "./types";

export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    id: "fire_ems",
    name: "Fire / EMS",
    description: "Track SCBA, turnout gear, medical supplies, and apparatus equipment",
    columns: [
      { label: "Vehicle / Unit", type: "text" },
      { label: "Serial Number", type: "text" },
      { label: "Last Inspected", type: "date" },
      { label: "Condition", type: "text" },
      { label: "Notes", type: "text" },
    ],
    // Count-only — EMS supplies are tracked individually or by case.
    allowedUnits: ["ct", "dozen"],
  },
  {
    id: "plumbing",
    name: "Plumbing",
    description: "Manage pipe fittings, valves, tools, and parts inventory",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Size / Spec", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Unit Cost", type: "number" },
      { label: "Notes", type: "text" },
    ],
    // Count + length-style (note: ft/in not in KNOWN_UNITS yet — fall back
    // to count for now; expand the master list in a follow-up if needed).
    allowedUnits: ["ct", "dozen"],
  },
  {
    id: "electrical",
    name: "Electrical",
    description: "Track wire, conduit, breakers, panels, and electrical components",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Voltage / Amperage", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Unit Cost", type: "number" },
      { label: "Notes", type: "text" },
    ],
    allowedUnits: ["ct", "dozen"],
  },
  {
    id: "hvac",
    name: "HVAC",
    description: "Monitor filters, refrigerant, coils, and service components",
    columns: [
      { label: "Part Number", type: "text" },
      { label: "Size / Spec", type: "text" },
      { label: "Manufacturer", type: "text" },
      { label: "Notes", type: "text" },
    ],
    allowedUnits: ["ct", "dozen"],
  },
  {
    id: "restaurant",
    name: "Restaurant / Food Service",
    description: "Manage ingredients, smallwares, and kitchen supplies",
    columns: [
      { label: "Category", type: "text" },
      { label: "Unit", type: "text" },
      { label: "Supplier", type: "text" },
      { label: "Notes", type: "text" },
    ],
    // Full mix — kitchens deal in count, weight, and volume.
    allowedUnits: ["ct", "dozen", "oz", "lb", "g", "kg", "fl oz", "cup", "pt", "qt", "gal", "ml", "l"],
  },
  {
    id: "medical",
    name: "Medical / Healthcare",
    description: "Track medications, PPE, and medical supplies with lot and location control",
    columns: [
      { label: "Category", type: "text" },
      { label: "Lot Number", type: "text" },
      { label: "Controlled", type: "boolean" },
      { label: "Notes", type: "text" },
    ],
    // Count + medication volumes (dosing in ml is common).
    allowedUnits: ["ct", "dozen", "ml", "fl oz"],
  },
  {
    id: "it_tech",
    name: "IT / Technology",
    description: "Manage hardware, peripherals, licenses, and tech equipment",
    columns: [
      { label: "Asset Tag", type: "text" },
      { label: "Serial Number", type: "text" },
      { label: "Assigned To", type: "text" },
      { label: "Purchase Date", type: "date" },
      { label: "Notes", type: "text" },
    ],
    allowedUnits: ["ct", "dozen"],
  },
  {
    id: "general",
    name: "General / Office",
    description: "A flexible setup for general supplies and equipment",
    columns: [
      { label: "Category", type: "text" },
      { label: "Notes", type: "text" },
    ],
    // No restriction — general orgs probably need access to everything.
    // Omitting `allowedUnits` falls back to the master KNOWN_UNITS list.
  },
];
