import type { AcediaEvent } from "../types/acedia_event.js";
import type { PlanningEvent } from "../types/planning.js";
import type { EventStore } from "../store/event_store.js";
import type { ItemLifecycle } from "../hub/item_lifecycle.js";
import { detectPlanningConflicts } from "./planning_conflicts.js";
import { computeFreeSlots } from "../connectors/calendar/free_slots.js";

/** How far ahead an overlap becomes a conflict in the box. */
export const CONFLICT_HORIZON_DAYS = 14;
/** At most this many ways out, per conflict. */
export const MAX_SOLUTIONS = 3;
/** A solution stays within the day's waking hours. */
const DAY_FROM_HOUR = 8;
const DAY_TO_HOUR = 21;
const QUARTER_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** A way out of a conflict: the event to move, and where to. */
export interface ConflictSolution {
    eventId: string;
    start: string;
    end: string;
}

const clock = (ts: number): string =>
    new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/**
 * The conflicts of the coming days, as box items: every overlap of two timed events within the horizon,
 * with up to MAX_SOLUTIONS free slots of the same day and the same length for the later of the two — computed, never
 * guessed by a model. A solution is chosen by Master in the box (a gesture), never carried out on its own.
 */
export function conflictItems(
    events: PlanningEvent[],
    now: number,
    horizonDays = CONFLICT_HORIZON_DAYS,
): AcediaEvent[] {
    const horizon = now + horizonDays * DAY_MS;
    const timed = events.filter((e) => !e.allDay);
    const byId = new Map(timed.map((e) => [e.id, e]));
    const items: AcediaEvent[] = [];
    for (const c of detectPlanningConflicts(timed)) {
        const from = Date.parse(c.from);
        if (from < now || from >= horizon) continue;
        const [x, y] = c.eventIds.map((id) => byId.get(id)!) as [PlanningEvent, PlanningEvent];
        // The one that starts later moves (same start: the second in id order — stable from one pass to the next).
        const [stays, moves] = Date.parse(x.start) <= Date.parse(y.start) ? [x, y] : [y, x];
        const solutions = solutionsFor(moves, timed, now);
        items.push({
            type: "planning.conflict",
            ts: from,
            source: "calendar",
            title: `Conflit — ${stays.title} et ${moves.title}`,
            body: `${clock(from)}–${clock(Date.parse(c.to))} : « ${moves.title} » chevauche « ${stays.title} ».`,
            // Within a day, it needs an answer now; further ahead, it can wait for the next look at the box.
            priority: from - now < DAY_MS ? "urgent" : "normal",
            dedupeKey: c.id,
            read: false,
            meta: { conflict: true, eventIds: c.eventIds, moving: moves.id, solutions },
        });
    }
    return items;
}

function solutionsFor(
    moves: PlanningEvent,
    timed: PlanningEvent[],
    now: number,
): ConflictSolution[] {
    const start = Date.parse(moves.start);
    const length = Date.parse(moves.end) - start;
    const day = new Date(start);
    const dayFrom = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        DAY_FROM_HOUR,
    ).getTime();
    const dayTo = new Date(day.getFullYear(), day.getMonth(), day.getDate(), DAY_TO_HOUR).getTime();
    const busy = timed
        .filter((e) => e.id !== moves.id)
        .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) }));
    const candidates: number[] = [];
    for (const slot of computeFreeSlots(busy, Math.max(dayFrom, now), dayTo, length)) {
        // On the quarter hour, inside the slot.
        const first = Math.ceil(slot.start / QUARTER_MS) * QUARTER_MS;
        if (first + length <= slot.end) candidates.push(first);
    }
    return candidates
        .sort((a, b) => Math.abs(a - start) - Math.abs(b - start))
        .slice(0, MAX_SOLUTIONS)
        .sort((a, b) => a - b)
        .map((s) => ({
            eventId: moves.id,
            start: new Date(s).toISOString(),
            end: new Date(s + length).toISOString(),
        }));
}

/**
 * The box follows the conflicts: a new one is collected, a changed one refreshed (its solutions too), one that is
 * gone — moved, deleted, past — leaves through the box's own path.
 */
export function syncConflicts(
    life: Pick<ItemLifecycle, "collected" | "refreshed" | "changed">,
    store: Pick<EventStore, "has" | "query" | "isGone">,
    items: AcediaEvent[],
): void {
    const keys = new Set(items.map((i) => i.dedupeKey));
    for (const item of items) {
        // A conflict Master left as it is stays left while it lasts.
        if (store.isGone(item.dedupeKey)) continue;
        if (store.has(item.dedupeKey)) life.refreshed(item);
        else life.collected(item, "conflict");
    }
    const { events } = store.query({ limit: 1000 });
    for (const held of events as AcediaEvent[]) {
        if (held.type === "planning.conflict" && !keys.has(held.dedupeKey)) {
            life.changed(held.dedupeKey, "removed", "settled");
        }
    }
}
