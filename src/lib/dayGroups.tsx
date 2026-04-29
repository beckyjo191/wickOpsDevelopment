import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/** Collapsible day section. Today's section opens by default; older days
 *  collapse — when collapsed (and as subtle context when open) the header
 *  shows a caller-supplied summary (e.g. "3 changes · 1 user" for audit,
 *  "5 orders" for closed orders). The shared CSS lives under
 *  `.audit-flat-day-*` since the audit log was the first user. */
export function DaySection({
  label,
  summary,
  defaultOpen,
  children,
}: {
  label: string;
  summary: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button
        type="button"
        className="audit-flat-day-divider audit-flat-day-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="audit-flat-day-chevron" aria-hidden="true">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="audit-flat-day-label">{label}</span>
        <span className="audit-flat-day-summary">{summary}</span>
      </button>
      {open ? children : null}
    </>
  );
}
