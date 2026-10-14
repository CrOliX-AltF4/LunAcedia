import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ReminderEngine } from "../../source/planning/reminder_engine.js";
import {
    DEFAULT_REMINDER_SETTINGS,
    type ReminderSettings,
} from "../../source/planning/reminder_rules.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
    new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;
const DAY = 86_400_000;

function ev(id: string, start: number): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title: id,
        start: new Date(start).toISOString(),
        end: new Date(start + 3_600_000).toISOString(),
        allDay: false,
        recurring: false,
        updatedAt: 1,
    };
}
function task(id: string, extra: Partial<PlanningTask> = {}): PlanningTask {
    return {
        id: `l/${id}`,
        listId: "l",
        listTitle: "L",
        title: id,
        status: "open",
        updatedAt: 1,
        ...extra,
    };
}

function engine(
    world: { events: PlanningEvent[]; tasks: PlanningTask[]; complete?: boolean },
    clock: { now: number },
    extra: { filePath?: string; settings?: ReminderSettings } = {},
) {
    const emit = vi.fn();
    const e = new ReminderEngine({
        planning: () => ({
            events: world.events,
            tasks: world.tasks,
            complete: world.complete ?? true,
        }),
        settings: () => extra.settings ?? DEFAULT_REMINDER_SETTINGS,
        emit,
        now: () => clock.now,
        ...(extra.filePath && { filePath: extra.filePath }),
    });
    return { e, emit };
}

describe("ReminderEngine", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "reminders-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("sends a reminder when it is due, once", () => {
        const start = local(2026, 10, 20, 14, 0);
        const clock = { now: local(2026, 10, 20, 12, 59) };
        const { e, emit } = engine({ events: [ev("Dentiste", start)], tasks: [] }, clock);
        expect(e.tick()).toEqual([]);
        clock.now = local(2026, 10, 20, 13, 0);
        expect(e.tick().map((r) => r.rule)).toEqual(["event_soon"]);
        clock.now += MIN;
        expect(e.tick()).toEqual([]);
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it("catches up a reminder missed by a short downtime, not a stale one", () => {
        const start = local(2026, 10, 20, 14, 0);
        // Due at 13:00. Back at 13:30: sent. Back at 15:30 (event over): stale, not sent.
        const a = engine(
            { events: [ev("A", start)], tasks: [] },
            { now: local(2026, 10, 20, 13, 30) },
        );
        expect(a.e.tick().map((r) => r.rule)).toEqual(["event_soon"]);
        const b = engine(
            { events: [ev("A", start)], tasks: [] },
            { now: local(2026, 10, 20, 15, 30) },
        );
        expect(b.e.tick()).toEqual([]);
    });

    it("never sends twice across a restart", async () => {
        const file = path.join(dir, "reminders.json");
        const start = local(2026, 10, 20, 14, 0);
        const clock = { now: local(2026, 10, 20, 13, 0) };
        const first = engine({ events: [ev("A", start)], tasks: [] }, clock, { filePath: file });
        expect(first.e.tick()).toHaveLength(1);
        await first.e.flush();

        const again = engine({ events: [ev("A", start)], tasks: [] }, clock, { filePath: file });
        await again.e.load();
        expect(again.e.tick()).toEqual([]);
        expect(again.e.journal().map((j) => j.title)).toEqual(["À 14:00 — A"]);
    });

    it("brings a snoozed reminder back once its time is up, under a new key", () => {
        const start = local(2026, 10, 20, 14, 0);
        const clock = { now: local(2026, 10, 20, 13, 0) };
        const { e, emit } = engine({ events: [ev("A", start)], tasks: [] }, clock);
        const [first] = e.tick();
        expect(e.snooze(first!.key, 15)).toBe(true);
        clock.now += 14 * MIN;
        expect(e.tick()).toEqual([]);
        clock.now += MIN;
        const back = e.tick();
        expect(back).toHaveLength(1);
        expect(back[0]!.key).toBe(`${first!.key}~1`);
        expect(emit).toHaveBeenCalledTimes(2);
    });

    it("settles the reminders of an object done, deleted or changed — and a snooze does not bring them back", () => {
        const clock = { now: local(2026, 10, 30, 9, 0) };
        const world = {
            events: [] as PlanningEvent[],
            tasks: [task("Dossier", { due: "2026-10-30" })],
        };
        const { e } = engine(world, clock);
        const [day] = e.tick();
        e.snooze(day!.key, 30);
        expect(e.settleObject("l/Dossier")).toEqual([day!.key]);
        clock.now += 31 * MIN;
        expect(e.tick()).toEqual([]);
        expect(e.snooze(day!.key, 5)).toBe(false);
    });

    it("counts an undated task's age from when it was first held, and keeps it across an empty start-up read", () => {
        const clock = { now: local(2026, 10, 1, 9, 0) };
        const world = { events: [] as PlanningEvent[], tasks: [task("Ranger")], complete: true };
        const { e } = engine(world, clock);
        e.tick();
        // A restart's first pass, before the planning is read: no task, planning not complete — the age is kept.
        world.tasks = [];
        world.complete = false;
        e.tick();
        world.tasks = [task("Ranger")];
        world.complete = true;
        clock.now = local(2026, 10, 8, 9, 0);
        expect(e.tick().map((r) => r.title)).toEqual(["Toujours sans date, depuis 7 j — Ranger"]);
    });

    it("takes down the reminders the planning no longer calls for — a task done, a date moved (O21)", () => {
        const clock = { now: local(2026, 10, 30, 9, 0) };
        const world = {
            events: [] as PlanningEvent[],
            tasks: [task("Dossier", { due: "2026-10-30" })],
            complete: true,
        };
        const settle = vi.fn();
        const e = new ReminderEngine({
            planning: () => world,
            settings: () => DEFAULT_REMINDER_SETTINGS,
            emit: vi.fn(),
            settle,
            now: () => clock.now,
        });
        const [day] = e.tick();
        // Before the first read after a restart: nothing is judged.
        world.tasks = [];
        world.complete = false;
        e.tick();
        expect(settle).not.toHaveBeenCalled();
        // The task given another date: its reminder of today has nothing left to say.
        world.tasks = [task("Dossier", { due: "2026-11-05" })];
        world.complete = true;
        e.tick();
        expect(settle).toHaveBeenCalledWith([day!.key]);
        expect(e.journal()[0]!.settledAt).toBe(clock.now);
    });

    it("sends nothing while the general switch is off", () => {
        const clock = { now: local(2026, 10, 20, 13, 0) };
        const { e } = engine({ events: [ev("A", local(2026, 10, 20, 14, 0))], tasks: [] }, clock, {
            settings: { ...DEFAULT_REMINDER_SETTINGS, enabled: false },
        });
        expect(e.tick()).toEqual([]);
    });

    it("keeps a month of journal", () => {
        const clock = { now: local(2026, 10, 20, 13, 0) };
        const { e } = engine({ events: [ev("A", local(2026, 10, 20, 14, 0))], tasks: [] }, clock);
        e.tick();
        clock.now += 31 * DAY;
        e.tick();
        expect(e.journal()).toEqual([]);
    });
});
