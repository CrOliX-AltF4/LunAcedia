import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { PlanningStore } from "../../source/planning/planning_store.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

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

const BOTH = { calendar: true, tasks: true };

describe("PlanningStore", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "planning-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("reports what a full read added, changed and removed", () => {
        const store = new PlanningStore();
        const first = store.replaceEvents(
            [
                ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
                ev("b", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"),
            ],
            100,
        );
        expect(first).toEqual({ added: ["primary/a", "primary/b"], changed: [], removed: [] });

        const second = store.replaceEvents(
            [
                ev("a", "2026-10-20T14:00:00Z", "2026-10-20T15:00:00Z"),
                ev("c", "2026-10-22T10:00:00Z", "2026-10-22T11:00:00Z"),
            ],
            200,
        );
        expect(second).toEqual({
            added: ["primary/c"],
            changed: ["primary/a"],
            removed: ["primary/b"],
        });
    });

    it("reports nothing when a read finds the same objects", () => {
        const store = new PlanningStore();
        store.replaceTasks([task("t1", { due: "2026-10-30" })], 100);
        expect(store.replaceTasks([task("t1", { due: "2026-10-30" })], 200)).toEqual({
            added: [],
            changed: [],
            removed: [],
        });
    });

    it("sees a due date added to a task as a change (the case the box missed, O21)", () => {
        const store = new PlanningStore();
        store.replaceTasks([task("t1")], 100);
        expect(store.replaceTasks([task("t1", { due: "2026-10-30" })], 200).changed).toEqual([
            "list-a/t1",
        ]);
    });

    it("shows the events that overlap the period asked, every task, and the conflicts between the events shown", () => {
        const store = new PlanningStore();
        store.replaceEvents(
            [
                ev("before", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
                ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
                ev("b", "2026-10-20T10:30:00Z", "2026-10-20T12:00:00Z"),
                ev("spanning", "2026-10-09T22:00:00Z", "2026-10-10T02:00:00Z"),
            ],
            100,
        );
        store.replaceTasks(
            [task("undated"), task("done", { status: "completed", completedAt: 50 })],
            100,
        );

        const snap = store.snapshot(
            Date.parse("2026-10-10T00:00:00Z"),
            Date.parse("2026-10-31T00:00:00Z"),
            BOTH,
        );
        expect(snap.events.map((e) => e.id)).toEqual([
            "primary/spanning",
            "primary/a",
            "primary/b",
        ]);
        expect(snap.tasks.map((t) => t.id)).toEqual(["list-a/undated", "list-a/done"]);
        expect(snap.conflicts).toHaveLength(1);
        expect(snap.syncedAt).toEqual({ calendar: 100, tasks: 100 });
        expect(snap.complete).toBe(true);
    });

    it("is not complete while a configured source has never been read", () => {
        const store = new PlanningStore();
        store.replaceEvents([], 100);
        expect(store.snapshot(0, Date.now(), BOTH).complete).toBe(false);
        // A source that is not configured is not waited for.
        expect(store.snapshot(0, Date.now(), { calendar: true, tasks: false }).complete).toBe(true);
    });

    it("sorts events by start and tasks open first, then by due date, undated last", () => {
        const store = new PlanningStore();
        store.replaceEvents(
            [
                ev("late", "2026-10-21T10:00:00Z", "2026-10-21T11:00:00Z"),
                ev("early", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
            ],
            100,
        );
        store.replaceTasks(
            [
                task("done", { status: "completed", completedAt: 5 }),
                task("undated"),
                task("soon", { due: "2026-10-20" }),
                task("later", { due: "2026-11-02" }),
            ],
            100,
        );
        const snap = store.snapshot(0, Date.parse("2027-01-01T00:00:00Z"), BOTH);
        expect(snap.events.map((e) => e.title)).toEqual(["early", "late"]);
        expect(snap.tasks.map((t) => t.title)).toEqual(["soon", "later", "undated", "done"]);
    });

    it("survives a restart, and an unreadable file means an empty planning, never a crash", async () => {
        const file = path.join(dir, "planning.json");
        const store = new PlanningStore(file);
        store.replaceEvents([ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z")], 100);
        store.replaceTasks([task("t1")], 120);
        await store.flush();

        const again = new PlanningStore(file);
        await again.load();
        const snap = again.snapshot(0, Date.parse("2027-01-01T00:00:00Z"), BOTH);
        expect(snap.events.map((e) => e.id)).toEqual(["primary/a"]);
        expect(snap.tasks.map((t) => t.id)).toEqual(["list-a/t1"]);
        expect(snap.syncedAt).toEqual({ calendar: 100, tasks: 120 });

        await fs.writeFile(file, "{ torn");
        const broken = new PlanningStore(file);
        await broken.load();
        expect(broken.snapshot(0, Date.now(), BOTH).events).toEqual([]);
    });

    it("finds one object by id", () => {
        const store = new PlanningStore();
        store.replaceEvents([ev("a", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z")], 100);
        store.replaceTasks([task("t1")], 100);
        expect(store.getEvent("primary/a")?.title).toBe("a");
        expect(store.getTask("list-a/t1")?.title).toBe("t1");
        expect(store.getTask("list-a/nope")).toBeUndefined();
    });
});
