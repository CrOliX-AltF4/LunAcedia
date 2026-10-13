import { describe, it, expect } from "vitest";
import { reminderEvent, BOX_PLANNING_TYPES } from "../../source/planning/reminder_delivery.js";
import { PlanningStore } from "../../source/planning/planning_store.js";
import type { DueReminder } from "../../source/planning/reminder_rules.js";

const AT = Date.parse("2026-10-20T11:30:00Z");

describe("reminderEvent — a reminder as a box item", () => {
    it("carries the event's ids, so open still shows the event", () => {
        const planning = new PlanningStore();
        planning.replaceEvents(
            [
                {
                    id: "primary/ev1",
                    calendarId: "primary",
                    title: "Dentiste",
                    start: "2026-10-20T14:30:00+02:00",
                    end: "2026-10-20T15:30:00+02:00",
                    allDay: false,
                    recurring: false,
                    url: "https://calendar.google.com/ev1",
                    updatedAt: 1,
                },
            ],
            AT,
        );
        const r: DueReminder = {
            key: "rem-event_soon-primary/ev1-1",
            rule: "event_soon",
            objectKind: "event",
            objectId: "primary/ev1",
            at: AT,
            title: "À 14:30 — Dentiste",
            body: "Lyon",
            priority: "urgent",
        };
        expect(reminderEvent(r, planning)).toEqual({
            type: "planning.reminder",
            ts: AT,
            source: "calendar",
            title: "À 14:30 — Dentiste",
            body: "Lyon",
            url: "https://calendar.google.com/ev1",
            priority: "urgent",
            dedupeKey: "rem-event_soon-primary/ev1-1",
            read: false,
            meta: {
                reminder: true,
                rule: "event_soon",
                objectKind: "event",
                objectId: "primary/ev1",
                at: AT,
                calendarId: "primary",
                eventId: "ev1",
            },
        });
    });

    it("carries the task's ids, so done still completes the task", () => {
        const r: DueReminder = {
            key: "rem-task_day-list-a/t1-2026-10-20",
            rule: "task_day",
            objectKind: "task",
            objectId: "list-a/t1",
            at: AT,
            title: "À faire aujourd'hui — Dossier",
            priority: "normal",
        };
        const e = reminderEvent(r, new PlanningStore());
        expect(e.source).toBe("tasks");
        expect(e.meta).toMatchObject({ listId: "list-a", taskId: "t1" });
    });

    it("names what leaves the box: events, conflicts and tasks as notifications", () => {
        expect([...BOX_PLANNING_TYPES].sort()).toEqual([
            "calendar.conflict",
            "calendar.upcoming",
            "tasks.due",
        ]);
    });
});
