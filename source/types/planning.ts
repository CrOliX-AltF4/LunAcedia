/**
 * The planning: calendar events and tasks held as objects to manage over the whole horizon —
 * not as notifications. The box keeps the flow to sort; the planning keeps what Master organises.
 *
 * Wire contract: served by GET /api/planning; an optional hub relays it as is, without a copy of these types.
 * Facts only, as at the source: no interpretation, no LLM output.
 */

export interface PlanningEvent {
    /** "calendarId/eventId" — the sourceId calendar actions take. */
    id: string;
    calendarId: string;
    title: string;
    /** ISO date-time for a timed event, ISO date (YYYY-MM-DD) for an all-day one. */
    start: string;
    end: string;
    allDay: boolean;
    location?: string;
    description?: string;
    /** An occurrence of a recurring series (Google unfolds them). */
    recurring: boolean;
    url?: string;
    /** When the source last changed it (ms). */
    updatedAt: number;
}

export type PlanningTaskStatus = "open" | "completed";

export interface PlanningTask {
    /** "listId/taskId" — the sourceId task actions take. */
    id: string;
    listId: string;
    listTitle: string;
    title: string;
    notes?: string;
    /** A date (YYYY-MM-DD): Google Tasks keeps no time of day. */
    due?: string;
    status: PlanningTaskStatus;
    /** When it was completed (ms) — completed tasks are kept for a while, then dropped. */
    completedAt?: number;
    updatedAt: number;
}

/** Two timed events that overlap. The ways out are not here: they live on the conflict's box item (its `meta`). */
export interface PlanningConflict {
    /** Stable for the pair, whatever their order. */
    id: string;
    eventIds: [string, string];
    /** The overlap itself (ISO). */
    from: string;
    to: string;
}

export interface PlanningSnapshot {
    events: PlanningEvent[];
    tasks: PlanningTask[];
    conflicts: PlanningConflict[];
    /** Last successful read of each source (ms), null when never read. */
    syncedAt: { calendar: number | null; tasks: number | null };
    /** False while a configured source has never been read in full: what is shown may be missing objects. */
    complete: boolean;
}
