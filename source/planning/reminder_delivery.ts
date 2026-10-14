import type { AcediaEvent, AcediaEventType } from "../types/acedia_event.js";
import type { PlanningStore } from "./planning_store.js";
import type { DueReminder } from "./reminder_rules.js";

/**
 * What the box held about events and tasks before the planning: events and tasks leave the box,
 * reminders take their place. Taken out once at start-up, once a parity check showed nothing the box did is lost.
 */
export const BOX_PLANNING_TYPES: ReadonlySet<AcediaEventType> = new Set<AcediaEventType>([
    "calendar.upcoming",
    "calendar.conflict",
    "tasks.due",
]);

function split(objectId: string): [string, string] {
    const slash = objectId.indexOf("/");
    return [objectId.slice(0, slash), objectId.slice(slash + 1)];
}

/**
 * A reminder as a box item. It carries its object's ids under the names the connectors' gestures read, so "open" shows
 * the event or the task and "done" completes the task, as they did for the box items it replaces.
 */
export function reminderEvent(r: DueReminder, planning: PlanningStore): AcediaEvent {
    const [a, b] = split(r.objectId);
    const event = r.objectKind === "event" ? planning.getEvent(r.objectId) : undefined;
    return {
        type: "planning.reminder",
        ts: r.at,
        source: r.objectKind === "event" ? "calendar" : "tasks",
        title: r.title,
        ...(r.body && { body: r.body }),
        ...(event?.url && { url: event.url }),
        priority: r.priority,
        dedupeKey: r.key,
        read: false,
        meta: {
            reminder: true,
            rule: r.rule,
            objectKind: r.objectKind,
            objectId: r.objectId,
            at: r.at,
            ...(r.objectKind === "event"
                ? { calendarId: a, eventId: b }
                : { listId: a, taskId: b }),
        },
    };
}
