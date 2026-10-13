import { describe, it, expect } from "vitest";
import { detectPlanningConflicts } from "../../source/planning/planning_conflicts.js";
import type { PlanningEvent } from "../../source/types/planning.js";

function ev(id: string, start: string, end: string, allDay = false): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title: id,
        start,
        end,
        allDay,
        recurring: false,
        updatedAt: 0,
    };
}

describe("detectPlanningConflicts", () => {
    it("finds two timed events that overlap, with the overlap itself", () => {
        const conflicts = detectPlanningConflicts([
            ev("a", "2026-10-20T10:00:00+02:00", "2026-10-20T11:00:00+02:00"),
            ev("b", "2026-10-20T10:30:00+02:00", "2026-10-20T12:00:00+02:00"),
        ]);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]!.eventIds).toEqual(["primary/a", "primary/b"]);
        expect(new Date(conflicts[0]!.from).getTime()).toBe(
            Date.parse("2026-10-20T10:30:00+02:00"),
        );
        expect(new Date(conflicts[0]!.to).getTime()).toBe(Date.parse("2026-10-20T11:00:00+02:00"));
    });

    it("gives the same id whatever the order of the pair", () => {
        const a = ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z");
        const b = ev("b", "2026-10-20T10:30:00Z", "2026-10-20T12:00:00Z");
        expect(detectPlanningConflicts([a, b])[0]!.id).toBe(detectPlanningConflicts([b, a])[0]!.id);
    });

    it("does not count back-to-back events", () => {
        expect(
            detectPlanningConflicts([
                ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
                ev("b", "2026-10-20T11:00:00Z", "2026-10-20T12:00:00Z"),
            ]),
        ).toEqual([]);
    });

    it("leaves all-day events out — context, not a time commitment", () => {
        expect(
            detectPlanningConflicts([
                ev("day", "2026-10-20", "2026-10-21", true),
                ev("b", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"),
            ]),
        ).toEqual([]);
    });

    it("finds every pair in a three-way overlap", () => {
        expect(
            detectPlanningConflicts([
                ev("a", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"),
                ev("b", "2026-10-20T10:30:00Z", "2026-10-20T11:30:00Z"),
                ev("c", "2026-10-20T11:00:00Z", "2026-10-20T13:00:00Z"),
            ]),
        ).toHaveLength(3);
    });

    it("ignores an event whose dates cannot be read", () => {
        expect(
            detectPlanningConflicts([
                ev("a", "not a date", "2026-10-20T12:00:00Z"),
                ev("b", "2026-10-20T10:30:00Z", "2026-10-20T11:30:00Z"),
            ]),
        ).toEqual([]);
    });
});
