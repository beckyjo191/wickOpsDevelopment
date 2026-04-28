/** Human-readable label for the calendar day of an ISO timestamp.
 *  "Today" / "Yesterday" for the most recent two days, then "Friday, Apr 24"
 *  for older days. Used as both the bucket key and the rendered header in
 *  date-grouped feeds (audit log, closed orders). */
export function dayGroupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (eventDay.getTime() === today.getTime()) return "Today";
  if (eventDay.getTime() === yesterday.getTime()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
