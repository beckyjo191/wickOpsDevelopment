import { Loader2 } from "lucide-react";

export type LoadingStateProps = {
  /** Visual treatment.
   *  - `inline`     — small spinner only, for in-card "loading more" / "fetching" states.
   *  - `card`       — spinner + message, sits inside a card.
   *  - `fullscreen` — covers the viewport, used for app boot. */
  variant?: "inline" | "card" | "fullscreen";
  /** Optional message rendered next to the spinner. Required for the `card` and
   *  `fullscreen` variants if you want any text; ignored for `inline`. */
  message?: string;
  /** Override the spinner size. Defaults to 22 (xl token) for inline/card,
   *  unused for fullscreen which uses the CSS spinner. */
  iconSize?: number;
  /** Extra class name appended to the wrapping element. Useful for the
   *  card variant when a page needs a specific surface modifier (e.g.
   *  `app-card--inventory`). */
  className?: string;
};

/**
 * Single loading-state primitive used wherever the app is fetching or
 * submitting. Replaces the previous mix of `.orders-loading`,
 * `.audit-loading`, ad-hoc `<Loader2>` blocks, and the full-screen
 * spinner-with-line treatment.
 *
 * Existing CSS hooks (`.app-loading-card`, `.app-spinner`,
 * `.app-loading-fullscreen`, `.spin`) are reused — this component just
 * centralizes the markup so all loading states have the same shape.
 */
export function LoadingState({
  variant = "inline",
  message,
  iconSize = 22,
  className,
}: LoadingStateProps) {
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");

  if (variant === "fullscreen") {
    return (
      <div
        className={join("app-loading-fullscreen", className)}
        role="status"
        aria-live="polite"
      >
        <span className="app-spinner" aria-hidden="true" />
        {message ? <span>{message}</span> : null}
      </div>
    );
  }

  if (variant === "card") {
    return (
      <div
        className={join("app-card app-loading-card", className)}
        role="status"
        aria-live="polite"
      >
        <span className="app-spinner" aria-hidden="true" />
        {message ? <span>{message}</span> : null}
      </div>
    );
  }

  // inline
  return (
    <div className={join("loading-inline", className)} role="status" aria-live="polite">
      <Loader2 size={iconSize} className="spin" aria-hidden="true" />
      {message ? <span className="loading-inline-text">{message}</span> : null}
    </div>
  );
}
