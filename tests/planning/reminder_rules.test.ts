import { describe, it, expect } from "vitest";
import {
    DEFAULT_REMINDER_SETTINGS,
    plannedReminders,
    type ReminderSettings,
} from "../../source/planning/reminder_rules.js";
import type { PlanningEvent, PlanningTask } from "../../source/types/planning.js";

// Local times throughout: the rules speak in Master's day (the server's TZ), so the fixtures are built the same way.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
    new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ts: number) => new Date(ts).toISOString();
const NOW = local(2026, 10, 13, 10, 0); // Tuesday 13 October, 10:00
const DAY = 86_400_000;

function ev(
    id: string,
    start: number,
    end: number,
    extra: Partial<PlanningEvent> = {},
): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title: id,
        start: iso(start),
        end: iso(end),
        allDay: false,
        recurring: false,
        updatedAt: 1,
        ...extra,
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
const seenLongAgo = () => NOW - 30 * DAY;

function plan(
    events: PlanningEvent[],
    tasks: PlanningTask[],
    settings = DEFAULT_REMINDER_SETTINGS,
    firstSeen = seenLongAgo,
) {
    return plannedReminders(events, tasks, settings, NOW, firstSeen);
}

describe("reminders for events", () => {
    it("the evening before at 20:00, and one hour before", () => {
        const start = local(2026, 10, 20, 14, 30);
        const r = plan([ev("Dentiste", start, start + 3_600_000, { location: "Lyon" })], []);
        expect(r.map((x) => [x.rule, x.at, x.title, x.priority])).toEqual([
            ["event_eve", local(2026, 10, 19, 20, 0), "Demain, 14:30 — Dentiste", "normal"],
            ["event_soon", local(2026, 10, 20, 13, 30), "À 14:30 — Dentiste", "urgent"],
        ]);
        expect(r[0]!.body).toBe("Lyon");
        expect(r[0]!.objectId).toBe("primary/Dentiste");
    });

    it("an all-day event: the evening before only", () => {
        const r = plan(
            [ev("Congés", 0, 0, { allDay: true, start: "2026-12-24", end: "2026-12-25" })],
            [],
        );
        expect(r.map((x) => [x.rule, x.at, x.title])).toEqual([
            ["event_eve", local(2026, 12, 23, 20, 0), "Demain, toute la journée — Congés"],
        ]);
    });

    it("a reminder in the quiet hours waits for 08:00 — and is dropped if the event has begun by then", () => {
        const early = local(2026, 10, 20, 8, 30); // one hour before = 07:30, quiet → 08:00, still before 08:30
        const dawn = local(2026, 10, 20, 7, 0); // one hour before = 06:00, quiet → 08:00, after the start: dropped
        const r = plan(
            [ev("early", early, early + 3_600_000), ev("dawn", dawn, dawn + 3_600_000)],
            [],
        );
        const soon = r.filter((x) => x.rule === "event_soon");
        expect(soon.map((x) => [x.objectId, x.at])).toEqual([
            ["primary/early", local(2026, 10, 20, 8, 0)],
        ]);
    });

    it("leaves past events out", () => {
        const past = NOW - 3 * DAY;
        expect(plan([ev("past", past, past + 3_600_000)], [])).toEqual([]);
    });
});

describe("reminders for tasks", () => {
    it("the day before and the day itself at 09:00", () => {
        const r = plan([], [task("Dossier", { due: "2026-10-30" })]);
        expect(r.map((x) => [x.rule, x.at, x.title])).toEqual([
            ["task_eve", local(2026, 10, 29, 9, 0), "À faire demain — Dossier"],
            ["task_day", local(2026, 10, 30, 9, 0), "À faire aujourd'hui — Dossier"],
        ]);
    });

    it("every morning while overdue, saying for how long", () => {
        const r = plan([], [task("Dossier", { due: "2026-10-10" })]);
        const overdue = r.find((x) => x.rule === "task_overdue")!;
        expect(overdue).toMatchObject({
            at: local(2026, 10, 13, 9, 0),
            title: "En retard de 3 j — Dossier",
            priority: "urgent",
        });
        expect(overdue.key).toBe("rem-task_overdue-l/Dossier-2026-10-13");
    });

    it("an undated task: a first nudge after 7 days, then every 7 days", () => {
        const at = (days: number) => () => NOW - days * DAY;
        const nudge = (days: number) =>
            plan([], [task("Ranger")], DEFAULT_REMINDER_SETTINGS, at(days)).filter(
                (x) => x.rule === "task_undated",
            );
        expect(nudge(6)).toEqual([]);
        expect(nudge(7).map((x) => x.title)).toEqual(["Toujours sans date, depuis 7 j — Ranger"]);
        expect(nudge(10)).toEqual([]);
        expect(nudge(14)).toHaveLength(1);
    });

    it("nothing for a completed task", () => {
        expect(plan([], [task("Fait", { due: "2026-10-14", status: "completed" })])).toEqual([]);
    });
});

describe("settings", () => {
    it("the general switch off: no reminder at all", () => {
        const off: ReminderSettings = { ...DEFAULT_REMINDER_SETTINGS, enabled: false };
        const start = local(2026, 10, 20, 14, 0);
        expect(plan([ev("x", start, start + 1)], [task("t", { due: "2026-10-20" })], off)).toEqual(
            [],
        );
    });

    it("a rule switched off is not applied; times and delays are the user's", () => {
        const s: ReminderSettings = {
            ...DEFAULT_REMINDER_SETTINGS,
            rules: {
                ...DEFAULT_REMINDER_SETTINGS.rules,
                event_eve: { enabled: false, time: "20:00" },
                event_soon: { enabled: true, minutesBefore: 15 },
            },
        };
        const start = local(2026, 10, 20, 14, 0);
        expect(plan([ev("x", start, start + 3_600_000)], [], s).map((x) => [x.rule, x.at])).toEqual(
            [["event_soon", local(2026, 10, 20, 13, 45)]],
        );
    });

    it("gives every reminder its own key, the same each time it is computed", () => {
        const start = local(2026, 10, 20, 14, 0);
        const a = plan([ev("x", start, start + 1)], [task("t", { due: "2026-10-20" })]).map(
            (x) => x.key,
        );
        const b = plan([ev("x", start, start + 1)], [task("t", { due: "2026-10-20" })]).map(
            (x) => x.key,
        );
        expect(new Set(a).size).toBe(a.length);
        expect(a).toEqual(b);
    });
});
