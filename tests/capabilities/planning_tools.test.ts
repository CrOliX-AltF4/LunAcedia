import { describe, it, expect } from "vitest";
import {
    readToolDefinitions,
    runReadTool,
    type ReadToolDeps,
} from "../../source/capabilities/read_tools.js";
import { EventStore } from "../../source/store/event_store.js";
import { PlanningStore } from "../../source/planning/planning_store.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

// Lot AT3: the agent sees the whole planning — a meeting in three weeks, a task due in two months — not only the box.

const NOW = Date.parse("2026-10-13T10:00:00Z");
const DAY = 86_400_000;

function ev(
    id: string,
    start: string,
    end: string,
    extra: Partial<PlanningEvent> = {},
): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title: id,
        start,
        end,
        allDay: false,
        recurring: false,
        updatedAt: 1,
        ...extra,
    };
}
function task(id: string, extra: Partial<PlanningTask> = {}): PlanningTask {
    return {
        id: `list-a/${id}`,
        listId: "list-a",
        listTitle: "Mes tâches",
        title: id,
        status: "open",
        updatedAt: 1,
        ...extra,
    };
}

function deps(events: PlanningEvent[], tasks: PlanningTask[]): ReadToolDeps {
    const planning = new PlanningStore();
    planning.replaceEvents(events, NOW);
    planning.replaceTasks(tasks, NOW);
    return {
        store: new EventStore(),
        busyIntervals: () => [],
        now: () => NOW,
        planning: (from, to) => planning.snapshot(from, to, { calendar: true, tasks: true }),
    };
}

function ok<T>(r: ReturnType<typeof runReadTool>): T {
    if (!r.ok) throw new Error(r.error);
    return r.result as T;
}

describe("planning tools — offered only with a planning", () => {
    it("adds agenda and tasks to the read tools", () => {
        expect(readToolDefinitions().map((d) => d.name)).toEqual([
            "search_events",
            "get_event",
            "free_slots",
        ]);
        expect(readToolDefinitions({ planning: true }).map((d) => d.name)).toEqual([
            "search_events",
            "get_event",
            "free_slots",
            "agenda",
            "tasks",
        ]);
    });

    it("says so when there is no planning", () => {
        const d = { ...deps([], []), planning: undefined };
        expect(runReadTool("agenda", {}, d)).toEqual({
            ok: false,
            error: "the planning is not available",
        });
    });
});

describe("agenda", () => {
    const events = [
        ev("today", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z", {
            location: "Lyon",
            description: "Apporter le dossier",
        }),
        ev("in3weeks", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
        ev("clash", "2026-11-03T09:30:00Z", "2026-11-03T11:00:00Z"),
    ];

    it("defaults to the next 7 days, from the start of today", () => {
        const r = ok<{ events: { id: string }[] }>(runReadTool("agenda", {}, deps(events, [])));
        expect(r.events.map((e) => e.id)).toEqual(["primary/today"]);
    });

    it("reads any period of the horizon, with the conflicts in it and the ids actions take", () => {
        const r = ok<{
            from: string;
            to: string;
            events: Record<string, unknown>[];
            conflicts: { eventIds: string[] }[];
        }>(runReadTool("agenda", { from: "2026-11-01", to: "2026-11-08" }, deps(events, [])));
        expect(r.events).toEqual([
            {
                id: "primary/in3weeks",
                title: "in3weeks",
                start: "2026-11-03T09:00:00Z",
                end: "2026-11-03T10:00:00Z",
                allDay: false,
            },
            {
                id: "primary/clash",
                title: "clash",
                start: "2026-11-03T09:30:00Z",
                end: "2026-11-03T11:00:00Z",
                allDay: false,
            },
        ]);
        expect(r.conflicts[0]!.eventIds).toEqual(["primary/clash", "primary/in3weeks"]);
    });

    it("gives the place and the description, flagged as text from others (an invitation is written by someone else)", () => {
        const r = runReadTool("agenda", { days: 1 }, deps(events, []));
        if (!r.ok) throw new Error(r.error);
        expect((r.result as { events: Record<string, unknown>[] }).events[0]).toMatchObject({
            location: "Lyon",
            description: "Apporter le dossier",
        });
        expect(r.external).toBe(true);
    });

    it("refuses dates it cannot read and a period beyond 90 days", () => {
        expect(runReadTool("agenda", { from: "lundi" }, deps(events, [])).ok).toBe(false);
        expect(
            runReadTool("agenda", { from: "2026-10-13", to: "2027-03-01" }, deps(events, [])).ok,
        ).toBe(false);
    });

    it("tells when the planning was last read, and when it may be missing objects", () => {
        const r = ok<{ syncedAt: unknown; complete: boolean }>(
            runReadTool("agenda", {}, deps(events, [])),
        );
        expect(r.complete).toBe(true);
        expect(r.syncedAt).toEqual({ calendar: NOW, tasks: NOW });
    });
});

describe("tasks", () => {
    const tasks = [
        task("soon", { due: "2026-10-15" }),
        task("in2months", { due: "2026-12-15" }),
        task("undated", { notes: "voir avec Paul" }),
        task("other-list", { listId: "list-b", listTitle: "Courses", id: "list-b/other-list" }),
        task("done", { status: "completed", completedAt: NOW - DAY }),
    ];

    it("lists the open tasks, whatever their due date, with the ids actions take", () => {
        const r = ok<{ tasks: Record<string, unknown>[] }>(
            runReadTool("tasks", {}, deps([], tasks)),
        );
        expect(r.tasks.map((t) => t["id"])).toEqual([
            "list-a/soon",
            "list-a/in2months",
            "list-b/other-list",
            "list-a/undated",
        ]);
        expect(r.tasks[0]).toEqual({
            id: "list-a/soon",
            title: "soon",
            list: "Mes tâches",
            due: "2026-10-15",
            status: "open",
        });
    });

    it("filters by status, list, due date and text", () => {
        const d = deps([], tasks);
        const ids = (args: Record<string, unknown>) =>
            ok<{ tasks: { id: string }[] }>(runReadTool("tasks", args, d)).tasks.map((t) => t.id);
        expect(ids({ status: "completed" })).toEqual(["list-a/done"]);
        expect(ids({ listId: "list-b" })).toEqual(["list-b/other-list"]);
        expect(ids({ dueBefore: "2026-10-31" })).toEqual(["list-a/soon"]);
        expect(ids({ undated: true })).toEqual(["list-b/other-list", "list-a/undated"]);
        expect(ids({ text: "paul" })).toEqual(["list-a/undated"]);
    });
});

describe("free_slots over the planning", () => {
    it("looks up to two weeks ahead", () => {
        const r = runReadTool("free_slots", { hours: 336 }, deps([], []));
        expect(r.ok).toBe(true);
    });
});
