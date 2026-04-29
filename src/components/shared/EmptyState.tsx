import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type EmptyStateProps = {
  /** Lucide icon component (e.g. `Package`, `Clock`, `PackageCheck`).
   *  Rendered at hero size with the lighter `strokeWidth={1.5}` treatment. */
  icon?: LucideIcon;
  /** Icon size in px. Defaults to 32 — matches the hero token in App.css.
   *  Use 48 for full-page "nothing here at all" states. */
  iconSize?: number;
  /** Headline text — short noun phrase. */
  title: string;
  /** Optional one-line hint underneath the title. */
  hint?: ReactNode;
  /** Optional CTA buttons / links rendered below the hint. */
  children?: ReactNode;
};

/**
 * Centered empty-state card. Replaces the previous mix of `.orders-empty`,
 * `.reorder-empty`, `.audit-empty-state`, and friends with a single
 * consistent shape: hero icon → title → optional hint → optional CTA.
 *
 * Visual hierarchy:
 *   icon (32px, strokeWidth 1.5, muted)
 *   title (slightly larger than body)
 *   hint  (one line, secondary color)
 *   children (CTA buttons, links, etc.)
 */
export function EmptyState({
  icon: Icon,
  iconSize = 32,
  title,
  hint,
  children,
}: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      {Icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon size={iconSize} strokeWidth={1.5} />
        </span>
      ) : null}
      <h3 className="empty-state-title">{title}</h3>
      {hint ? <p className="empty-state-hint">{hint}</p> : null}
      {children ? <div className="empty-state-actions">{children}</div> : null}
    </div>
  );
}
