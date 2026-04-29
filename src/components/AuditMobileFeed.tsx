import { Clock, RotateCcw, User } from "lucide-react";
import type { AuditEvent } from "../lib/inventoryApi";
import { DaySection } from "../lib/dayGroups";
import {
  aggregateActivityRows,
  UNDO_TOOLTIPS,
  type UndoableEvent,
} from "./AuditLogPage";

/**
 * Mobile (≤780px) card view for the Activity feed. Each event renders as a
 * stacked card so timestamps, item names, action descriptions, and undo
 * affordances each get their own row instead of competing for a single line.
 * Day collapsibility, accent-color border bar, and Undo semantics mirror
 * the desktop `FlatActivityFeed`.
 */
export function AuditMobileFeed({
  events,
  onViewItemHistory,
  onUndoEvent,
  undoingEventId,
}: {
  events: AuditEvent[];
  onViewItemHistory: (itemId: string, name: string) => void;
  onUndoEvent?: (undoable: UndoableEvent) => void;
  undoingEventId?: string | null;
}) {
  const days = aggregateActivityRows(events);
  return (
    <div className="audit-mobile-feed">
      {days.map((day) => {
        const rowCount = day.rows.length;
        const userCount = day.users.size;
        const summary =
          `${rowCount} change${rowCount !== 1 ? "s" : ""}` +
          (userCount > 0 ? ` · ${userCount} user${userCount !== 1 ? "s" : ""}` : "");
        return (
          <DaySection
            key={day.label}
            label={day.label}
            summary={summary}
            defaultOpen={day.label === "Today" || day.label === "Yesterday"}
          >
            {day.rows.map((row) => {
              const time = new Date(row.timestamp).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              });
              const navigable = !!row.itemId && row.itemName !== "—";
              const showUndo = !!onUndoEvent && !!row.undoableEvent;
              const isUndoing =
                showUndo && undoingEventId === row.undoableEvent?.eventId;
              return (
                <article
                  key={row.key}
                  className="audit-mobile-card"
                  style={{ ["--row-accent" as string]: row.accentColor }}
                >
                  <header className="audit-mobile-card-header">
                    <span className="audit-mobile-card-time">
                      <Clock size={12} aria-hidden="true" />
                      {time}
                    </span>
                    <span className="audit-mobile-card-user">
                      <User size={12} aria-hidden="true" />
                      {row.user}
                    </span>
                  </header>
                  <button
                    type="button"
                    className="audit-mobile-card-body"
                    onClick={() =>
                      navigable && onViewItemHistory(row.itemId!, row.itemName)
                    }
                    disabled={!navigable}
                    title={
                      row.titleAttr ??
                      (navigable ? `View history for ${row.itemName}` : undefined)
                    }
                  >
                    <span className="audit-mobile-card-itemname">
                      {row.itemName}
                    </span>
                    <span className="audit-mobile-card-summary">{row.summary}</span>
                  </button>
                  {showUndo && (
                    <div className="audit-mobile-card-footer">
                      <button
                        type="button"
                        className="audit-mobile-card-undo"
                        onClick={() => onUndoEvent?.(row.undoableEvent!)}
                        disabled={isUndoing}
                        title={UNDO_TOOLTIPS[row.undoableEvent!.kind]}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        {isUndoing ? "Undoing…" : "Undo"}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </DaySection>
        );
      })}
    </div>
  );
}
