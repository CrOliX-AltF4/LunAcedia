import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { PlanningEvent, PlanningTask } from "../types/planning.js";
import { plannedReminders, type DueReminder, type ReminderSettings } from "./reminder_rules.js";

export function defaultReminderJournalPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "reminders.json");
}

/** What was sent, kept so a reminder is sent once and so Master can see what was sent (law 3). */
export interface ReminderJournalEntry {
    /** The key the reminder was sent under — a snoozed one comes back under `<key>~<n>`. */
    key: string;
    /** The reminder's own key, the same across snoozes. */
    baseKey: string;
    rule: DueReminder["rule"];
    objectKind: DueReminder["objectKind"];
    objectId: string;
    title: string;
    /** When it was due, and when it was sent (ms). */
    dueAt: number;
    sentAt: number;
    snoozedUntil?: number;
    /** Its object was done, deleted or changed: the reminder has nothing left to say. */
    settledAt?: number;
}

interface JournalFile {
    entries: ReminderJournalEntry[];
    /** When each undated task was first held — Google keeps no creation date. */
    firstSeen: Record<string, number>;
}

export interface ReminderEngineDeps {
    /** `complete`: every configured source has been read in full — only then is an absent task forgotten. */
    planning: () => { events: PlanningEvent[]; tasks: PlanningTask[]; complete: boolean };
    settings: () => ReminderSettings;
    /** Sends one reminder (to the box, the Core, the phone). */
    emit: (reminder: DueReminder) => void;
    /** Takes down reminders the planning no longer calls for (their object done, deleted, moved or past). */
    settle?: (keys: string[]) => void;
    filePath?: string;
    now?: () => number;
    /** A reminder due longer ago than this when first seen is not sent (after a long downtime, it is stale). */
    catchUpMs?: number;
}

const DAY_MS = 86_400_000;
const KEEP_MS = 30 * DAY_MS;
const DEFAULT_CATCH_UP_MS = 2 * 60 * 60_000;

/**
 * Sends each reminder the planning calls for, once, when it is due. Runs on a minute timer;
 * the journal survives a restart, so nothing is sent twice and nothing due during a short downtime is lost.
 */
export class ReminderEngine {
    private entries: ReminderJournalEntry[] = [];
    private firstSeenAt: Record<string, number> = {};
    private timer: ReturnType<typeof setInterval> | null = null;
    private chain: Promise<void> = Promise.resolve();
    private readonly now: () => number;

    constructor(private readonly deps: ReminderEngineDeps) {
        this.now = deps.now ?? Date.now;
    }

    async load(): Promise<void> {
        if (!this.deps.filePath) return;
        try {
            const parsed = JSON.parse(
                await fs.readFile(this.deps.filePath, "utf-8"),
            ) as Partial<JournalFile>;
            this.entries = parsed.entries ?? [];
            this.firstSeenAt = parsed.firstSeen ?? {};
        } catch {
            // first run, or a torn file: nothing sent yet
        }
    }

    async flush(): Promise<void> {
        await this.chain;
    }

    start(intervalMs = 60_000): void {
        this.stop();
        this.tick();
        this.timer = setInterval(() => this.tick(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One pass: sends what is due and was not sent, and what a snooze brings back. Returns what it sent. */
    tick(): DueReminder[] {
        const now = this.now();
        const { events, tasks, complete } = this.deps.planning();
        this.trackUndated(tasks, now, complete);
        const settings = this.deps.settings();
        const sent: DueReminder[] = [];
        const settled: string[] = [];
        if (settings.enabled) {
            const known = new Set(this.entries.map((e) => e.baseKey));
            const catchUp = this.deps.catchUpMs ?? DEFAULT_CATCH_UP_MS;
            const planned = plannedReminders(events, tasks, settings, now, (id) =>
                this.firstSeen(id),
            );
            for (const r of planned) {
                if (known.has(r.key) || r.at > now || r.at < now - catchUp) continue;
                this.record(r, r.key, now);
                sent.push(r);
            }
            // A snoozed reminder comes back once its time is up.
            for (const e of this.entries) {
                if (e.snoozedUntil === undefined || e.snoozedUntil > now || e.settledAt) continue;
                const again = planned.find((p) => p.key === e.baseKey);
                e.snoozedUntil = undefined;
                if (!again) continue; // its object is gone or done meanwhile
                const n = this.entries.filter((x) => x.baseKey === e.baseKey).length;
                const key = `${e.baseKey}~${n}`;
                this.record(again, key, now);
                sent.push({ ...again, key });
            }
            // What the planning no longer calls for has nothing left to say: the task was done or given another date,
            // the event moved, deleted or past. Judged on a complete planning only — before the first read after a
            // restart, everything would look gone.
            if (complete) {
                const plannedKeys = new Set(planned.map((p) => p.key));
                for (const e of this.entries) {
                    if (e.settledAt || plannedKeys.has(e.baseKey)) continue;
                    e.settledAt = now;
                    e.snoozedUntil = undefined;
                    settled.push(e.key);
                }
            }
        }
        this.prune(now);
        if (sent.length > 0 || settled.length > 0) this.persist();
        if (settled.length > 0) this.deps.settle?.(settled);
        for (const r of sent) this.deps.emit(r);
        return sent;
    }

    /** Snoozes a sent reminder: it comes back after `minutes`. False when unknown or settled. */
    snooze(key: string, minutes: number): boolean {
        const entry = this.entries.find((e) => e.key === key);
        if (!entry || entry.settledAt) return false;
        entry.snoozedUntil = this.now() + minutes * 60_000;
        this.persist();
        return true;
    }

    /**
     * The object changed, was done or deleted: its reminders still standing have nothing left to say. Returns their
     * keys, for the box and the phone to take them down.
     */
    settleObject(objectId: string): string[] {
        const now = this.now();
        const keys: string[] = [];
        for (const e of this.entries) {
            if (e.objectId !== objectId || e.settledAt) continue;
            e.settledAt = now;
            e.snoozedUntil = undefined;
            keys.push(e.key);
        }
        if (keys.length > 0) this.persist();
        return keys;
    }

    /** What was sent, newest first. */
    journal(limit = 100): ReminderJournalEntry[] {
        return [...this.entries].sort((a, b) => b.sentAt - a.sentAt).slice(0, limit);
    }

    private firstSeen(taskId: string): number {
        return this.firstSeenAt[taskId] ?? this.now();
    }

    private trackUndated(tasks: PlanningTask[], now: number, complete: boolean): void {
        const undated = new Set(
            tasks.filter((t) => t.status === "open" && !t.due).map((t) => t.id),
        );
        let changed = false;
        for (const id of undated)
            if (this.firstSeenAt[id] === undefined) {
                this.firstSeenAt[id] = now;
                changed = true;
            }
        // A task given a date, done or gone starts over if it ever comes back undated — judged on a complete planning
        // only: before the first read after a restart, every task would look gone.
        if (complete)
            for (const id of Object.keys(this.firstSeenAt))
                if (!undated.has(id)) {
                    delete this.firstSeenAt[id];
                    changed = true;
                }
        if (changed) this.persist();
    }

    private record(r: DueReminder, key: string, now: number): void {
        this.entries.push({
            key,
            baseKey: r.key,
            rule: r.rule,
            objectKind: r.objectKind,
            objectId: r.objectId,
            title: r.title,
            dueAt: r.at,
            sentAt: now,
        });
    }

    private prune(now: number): void {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.sentAt > now - KEEP_MS);
        if (this.entries.length !== before) this.persist();
    }

    private persist(): void {
        const file = this.deps.filePath;
        if (!file) return;
        const data: JournalFile = { entries: this.entries, firstSeen: this.firstSeenAt };
        const json = JSON.stringify(data);
        this.chain = this.chain
            .then(async () => {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const tmp = `${file}.tmp`;
                await fs.writeFile(tmp, json, "utf-8");
                await fs.rename(tmp, file);
            })
            .catch((e: unknown) =>
                console.warn("[Reminders] could not save the journal:", (e as Error).message),
            );
    }
}
