import type { AcediaEventPriority } from "../types/acedia_event.js";
import type { PlanningEvent, PlanningTask } from "../types/planning.js";

/**
 * When to remind Master of an event or a task. Deterministic: the code
 * decides when, never the LLM. Times are the server's local time (TZ).
 */
export type ReminderRule =
    "event_eve" | "event_soon" | "task_eve" | "task_day" | "task_overdue" | "task_undated";

export const REMINDER_RULES: readonly ReminderRule[] = [
    "event_eve",
    "event_soon",
    "task_eve",
    "task_day",
    "task_overdue",
    "task_undated",
];

export interface ReminderSettings {
    /** The general switch (law 3): off, no reminder at all. */
    enabled: boolean;
    /** "HH:MM" — no reminder in between; one due then waits for the end (and is dropped if its object is past). */
    quietStart: string;
    quietEnd: string;
    rules: {
        /** The evening before an event. */
        event_eve: { enabled: boolean; time: string };
        /** Shortly before a timed event. */
        event_soon: { enabled: boolean; minutesBefore: number };
        /** The day before a task is due. */
        task_eve: { enabled: boolean; time: string };
        /** The day a task is due. */
        task_day: { enabled: boolean; time: string };
        /** Every morning while a task is overdue. */
        task_overdue: { enabled: boolean; time: string };
        /** An undated task left open: a first nudge after `afterDays`, then every `everyDays`. */
        task_undated: { enabled: boolean; time: string; afterDays: number; everyDays: number };
    };
}

/** The default reminder rules. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
    enabled: true,
    quietStart: "22:00",
    quietEnd: "08:00",
    rules: {
        event_eve: { enabled: true, time: "20:00" },
        event_soon: { enabled: true, minutesBefore: 60 },
        task_eve: { enabled: true, time: "09:00" },
        task_day: { enabled: true, time: "09:00" },
        task_overdue: { enabled: true, time: "09:00" },
        task_undated: { enabled: true, time: "09:00", afterDays: 7, everyDays: 7 },
    },
};

/** One reminder due: what to say, about which object, from when. */
export interface DueReminder {
    /** Unique per rule, object and occurrence — a reminder is sent once. */
    key: string;
    rule: ReminderRule;
    objectKind: "event" | "task";
    objectId: string;
    /** When it is due (ms), after the quiet hours. */
    at: number;
    title: string;
    body?: string;
    priority: AcediaEventPriority;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function hm(value: string): [number, number] {
    const [h, m] = value.split(":").map(Number);
    return [h ?? 0, m ?? 0];
}

/** Local midnight of the day holding `ts`. */
function dayStart(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** `time` ("HH:MM") on the local day holding `dayTs`, `offsetDays` days later. */
function at(dayTs: number, time: string, offsetDays = 0): number {
    const d = new Date(dayStart(dayTs));
    d.setDate(d.getDate() + offsetDays);
    const [h, m] = hm(time);
    d.setHours(h, m, 0, 0);
    return d.getTime();
}

/** A YYYY-MM-DD date as its local midnight. */
function localDate(date: string): number {
    const [y, mo, d] = date.slice(0, 10).split("-").map(Number);
    return new Date(y!, mo! - 1, d!).getTime();
}

function localDayKey(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Inside the quiet hours (which may span midnight)? */
function inQuiet(ts: number, s: ReminderSettings): boolean {
    const d = new Date(ts);
    const mins = d.getHours() * 60 + d.getMinutes();
    const [qsH, qsM] = hm(s.quietStart);
    const [qeH, qeM] = hm(s.quietEnd);
    const start = qsH * 60 + qsM;
    const end = qeH * 60 + qeM;
    if (start === end) return false;
    return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** A time inside the quiet hours waits for their end. */
function afterQuiet(ts: number, s: ReminderSettings): number {
    if (!inQuiet(ts, s)) return ts;
    const sameDayEnd = at(ts, s.quietEnd);
    // Before the end on the same morning; in the evening, the end is tomorrow's.
    return sameDayEnd > ts ? sameDayEnd : at(ts, s.quietEnd, 1);
}

/**
 * Every reminder the planning calls for, whatever its time — the engine keeps the due ones it has not sent.
 * `firstSeen`: when each undated task was first held (Google keeps no creation date).
 */
export function plannedReminders(
    events: PlanningEvent[],
    tasks: PlanningTask[],
    settings: ReminderSettings,
    now: number,
    firstSeen: (taskId: string) => number,
): DueReminder[] {
    if (!settings.enabled) return [];
    const r = settings.rules;
    const out: DueReminder[] = [];
    const push = (x: DueReminder, objectTime?: number) => {
        const shifted = afterQuiet(x.at, settings);
        // Pushed past its object by the quiet hours: it has nothing left to say.
        if (objectTime !== undefined && shifted >= objectTime) return;
        out.push({ ...x, at: shifted });
    };

    for (const e of events) {
        const start = e.allDay ? localDate(e.start) : Date.parse(e.start);
        if (isNaN(start) || start <= now - DAY_MS) continue;
        const when = e.allDay ? "toute la journée" : clock(start);
        if (r.event_eve.enabled)
            push(
                {
                    key: `rem-event_eve-${e.id}-${localDayKey(start)}`,
                    rule: "event_eve",
                    objectKind: "event",
                    objectId: e.id,
                    at: at(start, r.event_eve.time, -1),
                    title: `Demain, ${when} — ${e.title}`,
                    ...(e.location && { body: e.location }),
                    priority: "normal",
                },
                start,
            );
        if (r.event_soon.enabled && !e.allDay)
            push(
                {
                    key: `rem-event_soon-${e.id}-${start}`,
                    rule: "event_soon",
                    objectKind: "event",
                    objectId: e.id,
                    at: start - r.event_soon.minutesBefore * MINUTE_MS,
                    title: `À ${clock(start)} — ${e.title}`,
                    ...(e.location && { body: e.location }),
                    priority: "urgent",
                },
                start,
            );
    }

    for (const t of tasks) {
        if (t.status !== "open") continue;
        if (t.due) {
            const due = localDate(t.due);
            if (r.task_eve.enabled)
                push({
                    key: `rem-task_eve-${t.id}-${t.due}`,
                    rule: "task_eve",
                    objectKind: "task",
                    objectId: t.id,
                    at: at(due, r.task_eve.time, -1),
                    title: `À faire demain — ${t.title}`,
                    priority: "normal",
                });
            if (r.task_day.enabled)
                push({
                    key: `rem-task_day-${t.id}-${t.due}`,
                    rule: "task_day",
                    objectKind: "task",
                    objectId: t.id,
                    at: at(due, r.task_day.time),
                    title: `À faire aujourd'hui — ${t.title}`,
                    priority: "normal",
                });
            if (r.task_overdue.enabled && dayStart(now) > due) {
                const late = Math.round((dayStart(now) - due) / DAY_MS);
                push({
                    key: `rem-task_overdue-${t.id}-${localDayKey(now)}`,
                    rule: "task_overdue",
                    objectKind: "task",
                    objectId: t.id,
                    at: at(now, r.task_overdue.time),
                    title: `En retard de ${late} j — ${t.title}`,
                    priority: "urgent",
                });
            }
        } else if (r.task_undated.enabled) {
            const since = firstSeen(t.id);
            const age = Math.floor((dayStart(now) - dayStart(since)) / DAY_MS);
            const { afterDays, everyDays } = r.task_undated;
            if (age >= afterDays && (age - afterDays) % Math.max(1, everyDays) === 0)
                push({
                    key: `rem-task_undated-${t.id}-${localDayKey(now)}`,
                    rule: "task_undated",
                    objectKind: "task",
                    objectId: t.id,
                    at: at(now, r.task_undated.time),
                    title: `Toujours sans date, depuis ${age} j — ${t.title}`,
                    body: "Lui donner une échéance, ou la terminer ?",
                    priority: "info",
                });
        }
    }
    return out;
}
