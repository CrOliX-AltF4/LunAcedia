import { describe, it, expect } from "vitest";
import { conflictItems, syncConflicts } from "../../source/planning/conflict_watch.js";
import { EventStore } from "../../source/store/event_store.js";
import type { PlanningEvent } from "../../source/types/planning.js";
import { recordingLifecycle } from "../hub/recording_lifecycle.js";

// an overlap of the coming days becomes a box item, with up to 3 ways out of the same day and length.

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
function event(
    id: string,
    title: string,
    start: number,
    end: number,
    extra: Partial<PlanningEvent> = {},
): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        allDay: false,
        recurring: false,
        updatedAt: 1,
        ...extra,
    };
}

describe("conflictItems", () => {
    const now = at(19, 8);
    // Monday the 20th: a dentist 10:00–11:00, a call 10:30–11:30 (moves), a lunch 12:00–14:00.
    const day = [
        event("dentist", "Dentiste", at(20, 10), at(20, 11)),
        event("call", "Appel Léa", at(20, 10, 30), at(20, 11, 30)),
        event("lunch", "Déjeuner", at(20, 12), at(20, 14)),
    ];

    it("makes a box item of an overlap, moving the later event to free slots of that day, of its length", () => {
        const [item, ...rest] = conflictItems(day, now);
        expect(rest).toHaveLength(0);
        expect(item).toMatchObject({
            type: "planning.conflict",
            source: "calendar",
            priority: "normal",
            title: "Conflit — Dentiste et Appel Léa",
            meta: { conflict: true, moving: "primary/call" },
        });
        const solutions = item!.meta!["solutions"] as {
            eventId: string;
            start: string;
            end: string;
        }[];
        expect(solutions.length).toBeGreaterThan(0);
        expect(solutions.length).toBeLessThanOrEqual(3);
        for (const s of solutions) {
            const start = Date.parse(s.start);
            const end = Date.parse(s.end);
            expect(end - start).toBe(60 * 60_000);
            expect(new Date(start).getMinutes() % 15).toBe(0);
            expect(start).toBeGreaterThanOrEqual(at(20, 8));
            expect(end).toBeLessThanOrEqual(at(20, 21));
            // Never onto the dentist or the lunch.
            expect(end <= at(20, 10) || start >= at(20, 11)).toBe(true);
            expect(end <= at(20, 12) || start >= at(20, 14)).toBe(true);
        }
        // Nearest first in the choice, shown in time order.
        expect(solutions.map((s) => s.start)).toEqual([...solutions.map((s) => s.start)].sort());
    });

    it("urgent within a day; nothing for an all-day event, a past overlap or one beyond the horizon", () => {
        expect(conflictItems(day, at(20, 9))[0]!.priority).toBe("urgent");
        const allDay = [event("off", "Congé", at(20, 0), at(21, 0), { allDay: true }), day[0]!];
        expect(conflictItems(allDay, now)).toEqual([]);
        expect(conflictItems(day, at(21, 8))).toEqual([]);
        expect(conflictItems(day, at(1, 8))).toEqual([]);
    });
});

describe("syncConflicts", () => {
    it("collects a new conflict, refreshes a held one, and takes down one that is gone", () => {
        const store = new EventStore();
        const { life, sent, emitted } = recordingLifecycle(store);
        const now = new Date(2026, 9, 19, 8).getTime();
        const events = [
            event(
                "a",
                "A",
                new Date(2026, 9, 20, 10).getTime(),
                new Date(2026, 9, 20, 11).getTime(),
            ),
            event(
                "b",
                "B",
                new Date(2026, 9, 20, 10, 30).getTime(),
                new Date(2026, 9, 20, 11, 30).getTime(),
            ),
        ];
        const items = conflictItems(events, now);
        syncConflicts(life, store, items);
        expect(sent.map((e) => e.type)).toEqual(["planning.conflict"]);

        syncConflicts(life, store, items);
        expect(sent).toHaveLength(1); // held: refreshed, not news again

        syncConflicts(life, store, []);
        expect(store.has(items[0]!.dedupeKey)).toBe(false);
        expect(emitted.at(-1)).toMatchObject({ op: "removed", key: items[0]!.dedupeKey });
    });
});
