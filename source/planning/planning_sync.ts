import type { PlanningEvent, PlanningTask } from "../types/planning.js";
import type { PlanningDiff, PlanningStore } from "./planning_store.js";

const DAY_MS = 86_400_000;

/**
 * What the planning holds (ADR-031 Q1): the calendar from 7 days back (what just ended) to 90 days ahead; every open
 * task, dated or not; the tasks completed in the last 14 days.
 */
export const PLANNING_HORIZON = { pastDays: 7, futureDays: 90, completedDays: 14 } as const;

export interface PlanningEventSource {
    readPlanning(from: number, to: number): Promise<PlanningEvent[] | null>;
}

export interface PlanningTaskSource {
    readPlanning(completedSince: number): Promise<PlanningTask[] | null>;
}

export type PlanningSourceKind = "calendar" | "tasks";

export interface PlanningSyncDeps {
    store: PlanningStore;
    calendar?: PlanningEventSource;
    tasks?: PlanningTaskSource;
    now?: () => number;
    /** Called once per source whose read changed something — what the views and the reminders follow. */
    onChange?: (source: PlanningSourceKind, diff: PlanningDiff) => void;
}

function changed(d: PlanningDiff): boolean {
    return d.added.length + d.changed.length + d.removed.length > 0;
}

/**
 * Keeps the planning in step with its sources: each pass reads every source whole and applies it (AT0: at the real
 * volumes a full read is one or two requests per calendar, and comparing to what is held finds deletions by
 * itself). A source that cannot be read is left as it was — never judged on a failed or partial read.
 */
export class PlanningSync {
    private running: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly now: () => number;

    constructor(private readonly deps: PlanningSyncDeps) {
        this.now = deps.now ?? Date.now;
    }

    configured(): { calendar: boolean; tasks: boolean } {
        return { calendar: !!this.deps.calendar, tasks: !!this.deps.tasks };
    }

    /** One pass. A pass asked while one runs gets that one — two reads never overlap. */
    syncNow(): Promise<void> {
        this.running ??= this.pass().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    start(intervalMs: number): void {
        this.stop();
        void this.syncNow();
        this.timer = setInterval(() => void this.syncNow(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async pass(): Promise<void> {
        const { store, calendar, tasks, onChange } = this.deps;
        const now = this.now();
        await Promise.all([
            calendar &&
                this.read("calendar", () =>
                    calendar.readPlanning(
                        now - PLANNING_HORIZON.pastDays * DAY_MS,
                        now + PLANNING_HORIZON.futureDays * DAY_MS,
                    ),
                ).then((events) => {
                    if (!events) return;
                    const d = store.replaceEvents(events, now);
                    if (changed(d)) onChange?.("calendar", d);
                }),
            tasks &&
                this.read("tasks", () =>
                    tasks.readPlanning(now - PLANNING_HORIZON.completedDays * DAY_MS),
                ).then((list) => {
                    if (!list) return;
                    const d = store.replaceTasks(list, now);
                    if (changed(d)) onChange?.("tasks", d);
                }),
        ]);
    }

    private async read<T>(
        source: PlanningSourceKind,
        run: () => Promise<T | null>,
    ): Promise<T | null> {
        try {
            return await run();
        } catch (e) {
            console.warn(`[Planning] ${source} not read:`, (e as Error).message);
            return null;
        }
    }
}
