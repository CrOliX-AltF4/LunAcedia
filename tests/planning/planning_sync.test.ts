import { describe, it, expect, vi } from "vitest";
import { PlanningStore } from "../../source/planning/planning_store.js";
import { PlanningSync, PLANNING_HORIZON } from "../../source/planning/planning_sync.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

const EVENT: PlanningEvent = {
    id: "primary/e1",
    calendarId: "primary",
    title: "Dentiste",
    start: "2026-10-20T10:00:00Z",
    end: "2026-10-20T11:00:00Z",
    allDay: false,
    recurring: false,
    updatedAt: 1,
};
const TASK: PlanningTask = {
    id: "l/t1",
    listId: "l",
    listTitle: "L",
    title: "Dossier",
    status: "open",
    updatedAt: 1,
};

describe("PlanningSync", () => {
    it("reads the calendar over the horizon (7 days back, 90 ahead) and the tasks completed in the last 14 days", async () => {
        const calendar = { readPlanning: vi.fn().mockResolvedValue([EVENT]) };
        const tasks = { readPlanning: vi.fn().mockResolvedValue([TASK]) };
        const store = new PlanningStore();
        const sync = new PlanningSync({ store, calendar, tasks, now: () => NOW });

        await sync.syncNow();

        expect(calendar.readPlanning).toHaveBeenCalledWith(NOW - 7 * DAY, NOW + 90 * DAY);
        expect(tasks.readPlanning).toHaveBeenCalledWith(NOW - 14 * DAY);
        expect(PLANNING_HORIZON).toEqual({ pastDays: 7, futureDays: 90, completedDays: 14 });
        const snap = store.snapshot(0, NOW + 365 * DAY, sync.configured());
        expect(snap.events).toEqual([EVENT]);
        expect(snap.tasks).toEqual([TASK]);
        expect(snap.syncedAt).toEqual({ calendar: NOW, tasks: NOW });
    });

    it("tells what changed, per source", async () => {
        const onChange = vi.fn();
        const calendar = { readPlanning: vi.fn().mockResolvedValue([EVENT]) };
        const sync = new PlanningSync({
            store: new PlanningStore(),
            calendar,
            now: () => NOW,
            onChange,
        });
        await sync.syncNow();
        expect(onChange).toHaveBeenCalledWith("calendar", {
            added: ["primary/e1"],
            changed: [],
            removed: [],
        });

        onChange.mockClear();
        await sync.syncNow();
        expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps what it holds when a source cannot be read — nothing is called gone on a failed read", async () => {
        const store = new PlanningStore();
        const calendar = {
            readPlanning: vi.fn().mockResolvedValueOnce([EVENT]).mockResolvedValueOnce(null),
        };
        const sync = new PlanningSync({ store, calendar, now: () => NOW });
        await sync.syncNow();
        await sync.syncNow();
        expect(store.getEvent("primary/e1")).toBeDefined();
    });

    it("a source that throws does not stop the other one", async () => {
        const store = new PlanningStore();
        const calendar = { readPlanning: vi.fn().mockRejectedValue(new Error("boom")) };
        const tasks = { readPlanning: vi.fn().mockResolvedValue([TASK]) };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await new PlanningSync({ store, calendar, tasks, now: () => NOW }).syncNow();
        expect(store.getTask("l/t1")).toBeDefined();
        warn.mockRestore();
    });

    it("never runs two reads at once — a read asked during one waits for it", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const calendar = {
            readPlanning: vi.fn().mockImplementation(async () => {
                await gate;
                return [EVENT];
            }),
        };
        const sync = new PlanningSync({ store: new PlanningStore(), calendar, now: () => NOW });
        const first = sync.syncNow();
        const second = sync.syncNow();
        release();
        await Promise.all([first, second]);
        expect(calendar.readPlanning).toHaveBeenCalledTimes(1);
    });

    it("says which sources are in use", () => {
        const store = new PlanningStore();
        expect(new PlanningSync({ store }).configured()).toEqual({ calendar: false, tasks: false });
        expect(new PlanningSync({ store, tasks: { readPlanning: vi.fn() } }).configured()).toEqual({
            calendar: false,
            tasks: true,
        });
    });

    it("reads at start, then on its interval, until stopped", async () => {
        vi.useFakeTimers();
        const calendar = { readPlanning: vi.fn().mockResolvedValue([]) };
        const sync = new PlanningSync({ store: new PlanningStore(), calendar, now: () => NOW });
        sync.start(60_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(calendar.readPlanning).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calendar.readPlanning).toHaveBeenCalledTimes(2);
        sync.stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calendar.readPlanning).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});
