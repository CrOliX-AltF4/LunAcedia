import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { PlanningEvent, PlanningSnapshot, PlanningTask } from "../types/planning.js";
import { detectPlanningConflicts } from "./planning_conflicts.js";

/** Where the planning lives on disk — STORAGE_DIR, kept across image updates. */
export function defaultPlanningPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "planning.json");
}

/** What a full read changed, by object id — what the views and, later, the reminders follow. */
export interface PlanningDiff {
    added: string[];
    changed: string[];
    removed: string[];
}

interface PlanningFile {
    events: PlanningEvent[];
    tasks: PlanningTask[];
    syncedAt: { calendar: number | null; tasks: number | null };
}

function diff<T extends { id: string }>(before: Map<string, T>, after: T[]): PlanningDiff {
    const out: PlanningDiff = { added: [], changed: [], removed: [] };
    const seen = new Set<string>();
    for (const item of after) {
        seen.add(item.id);
        const old = before.get(item.id);
        if (!old) out.added.push(item.id);
        else if (JSON.stringify(old) !== JSON.stringify(item)) out.changed.push(item.id);
    }
    for (const id of before.keys()) if (!seen.has(id)) out.removed.push(id);
    return out;
}

/** Open first; then by due date, undated after the dated ones; completed last, most recent first. */
function taskOrder(a: PlanningTask, b: PlanningTask): number {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.status === "completed") return (b.completedAt ?? 0) - (a.completedAt ?? 0);
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return a.title.localeCompare(b.title);
}

/**
 * The planning: every event of the horizon and every task, as objects. A read of a source is
 * applied whole — the source IS the truth, what it no longer lists is gone — and only after a complete read (the
 * sync never applies a partial one). Persisted to one file; writes are chained so they land in order.
 */
export class PlanningStore {
    private events = new Map<string, PlanningEvent>();
    private tasks = new Map<string, PlanningTask>();
    private syncedAt: PlanningFile["syncedAt"] = { calendar: null, tasks: null };
    private chain: Promise<void> = Promise.resolve();
    private writeQueued = false;

    constructor(private readonly filePath?: string) {}

    /** A missing or unreadable file means an empty planning — the next read fills it — never a crash. */
    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(
                await fs.readFile(this.filePath, "utf-8"),
            ) as Partial<PlanningFile>;
            this.events = new Map((parsed.events ?? []).map((e) => [e.id, e]));
            this.tasks = new Map((parsed.tasks ?? []).map((t) => [t.id, t]));
            this.syncedAt = {
                calendar: parsed.syncedAt?.calendar ?? null,
                tasks: parsed.syncedAt?.tasks ?? null,
            };
        } catch {
            // first run, or a torn file
        }
    }

    async flush(): Promise<void> {
        await this.chain;
    }

    /** Applies a complete read of the calendars. */
    replaceEvents(events: PlanningEvent[], at: number): PlanningDiff {
        const d = diff(this.events, events);
        this.events = new Map(events.map((e) => [e.id, e]));
        this.syncedAt.calendar = at;
        this.persist();
        return d;
    }

    /** Applies a complete read of the task lists. */
    replaceTasks(tasks: PlanningTask[], at: number): PlanningDiff {
        const d = diff(this.tasks, tasks);
        this.tasks = new Map(tasks.map((t) => [t.id, t]));
        this.syncedAt.tasks = at;
        this.persist();
        return d;
    }

    getEvent(id: string): PlanningEvent | undefined {
        return this.events.get(id);
    }

    getTask(id: string): PlanningTask | undefined {
        return this.tasks.get(id);
    }

    /**
     * The events that overlap [from, to), every task held, and the conflicts between the events shown.
     * `configured`: the sources in use — complete only once each of them has been read in full.
     */
    snapshot(
        from: number,
        to: number,
        configured: { calendar: boolean; tasks: boolean },
    ): PlanningSnapshot {
        const events = [...this.events.values()]
            .filter((e) => {
                const start = Date.parse(e.start);
                const end = Date.parse(e.end);
                return !isNaN(start) && !isNaN(end) && start < to && end > from;
            })
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        return {
            events,
            tasks: [...this.tasks.values()].sort(taskOrder),
            conflicts: detectPlanningConflicts(events),
            syncedAt: { ...this.syncedAt },
            complete:
                (!configured.calendar || this.syncedAt.calendar !== null) &&
                (!configured.tasks || this.syncedAt.tasks !== null),
        };
    }

    private persist(): void {
        if (!this.filePath || this.writeQueued) return;
        this.writeQueued = true;
        const file = this.filePath;
        this.chain = this.chain
            .then(async () => {
                this.writeQueued = false;
                const data: PlanningFile = {
                    events: [...this.events.values()],
                    tasks: [...this.tasks.values()],
                    syncedAt: this.syncedAt,
                };
                await fs.mkdir(path.dirname(file), { recursive: true });
                const tmp = `${file}.tmp`;
                await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
                await fs.rename(tmp, file);
            })
            .catch((e: unknown) =>
                console.warn("[Planning] could not save:", (e as Error).message),
            );
    }
}
