import type { PlanningConflict, PlanningEvent } from "../types/planning.js";

/**
 * Every pair of timed events that overlap (strictly: back-to-back is not a conflict). All-day events are context,
 * not a time commitment — left out, as the box's conflict check already did. Deterministic, no LLM.
 */
export function detectPlanningConflicts(events: PlanningEvent[]): PlanningConflict[] {
    const timed = events
        .filter((e) => !e.allDay)
        .map((e) => ({ e, start: Date.parse(e.start), end: Date.parse(e.end) }))
        .filter((t) => !isNaN(t.start) && !isNaN(t.end) && t.end > t.start)
        .sort((a, b) => a.start - b.start);

    const conflicts: PlanningConflict[] = [];
    for (let i = 0; i < timed.length; i++) {
        const a = timed[i]!;
        for (let j = i + 1; j < timed.length; j++) {
            const b = timed[j]!;
            // Sorted by start: once b starts after a ends, no later event overlaps a either.
            if (b.start >= a.end) break;
            const pair = [a.e.id, b.e.id].sort() as [string, string];
            conflicts.push({
                id: `conflict-${pair[0]}-${pair[1]}`,
                eventIds: pair,
                from: new Date(Math.max(a.start, b.start)).toISOString(),
                to: new Date(Math.min(a.end, b.end)).toISOString(),
            });
        }
    }
    return conflicts;
}
