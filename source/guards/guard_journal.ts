import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AcediaEvent } from "../types/acedia_event.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

export interface JournalEntry {
    ts: number;
    ruleId: string | undefined;
    event: AcediaEvent;
}

type JournalLine =
    | { kind: "filtered"; ts: number; ruleId?: string; event: AcediaEvent }
    /** The user restored the event: it is dispatched and never evaluated (or dropped) again. */
    | { kind: "restored"; ts: number; dedupeKey: string }
    /** The event no longer needs journaling (a rule edit stopped dropping it) — but it is NOT forced through later. */
    | { kind: "released"; ts: number; dedupeKey: string };

function resolvePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "guard_filtered.jsonl");
}

/**
 * Append-only journal of every event a guard rule dropped — "never silent": a dropped
 * event is always visible and restorable. Deliberately its OWN file, never piggybacking on the hub's
 * `dedup_seen.json` (7-day TTL, rewritten whole on every event). Retention is independent
 * (default 30 days, GUARD_JOURNAL_RETENTION_DAYS). Writes are serialised so the file never interleaves.
 */
export class GuardJournal {
    private readonly active = new Map<string, JournalEntry>();
    private readonly restored = new Map<string, number>(); // dedupeKey → restore ts
    private readonly filePath: string;
    private readonly retentionMs: number;
    private chain: Promise<void> = Promise.resolve();

    constructor(filePath?: string, retentionDays?: number) {
        this.filePath = filePath ?? resolvePath();
        const days =
            retentionDays ??
            parseInt(
                process.env["GUARD_JOURNAL_RETENTION_DAYS"] ?? `${DEFAULT_RETENTION_DAYS}`,
                10,
            );
        this.retentionMs =
            Math.max(1, Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS) * DAY_MS;
    }

    async load(now: number = Date.now()): Promise<void> {
        let raw: string;
        try {
            raw = await fs.readFile(this.filePath, "utf-8");
        } catch {
            return; // no journal yet
        }
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
                this.apply(JSON.parse(line) as JournalLine);
            } catch {
                // a torn or corrupt line must never take the whole journal down
            }
        }
        await this.prune(now);
    }

    private apply(line: JournalLine): void {
        if (line.kind === "filtered")
            this.active.set(line.event.dedupeKey, {
                ts: line.ts,
                ruleId: line.ruleId,
                event: line.event,
            });
        else if (line.kind === "restored") {
            this.active.delete(line.dedupeKey);
            this.restored.set(line.dedupeKey, line.ts);
        } else this.active.delete(line.dedupeKey);
    }

    private append(line: JournalLine): void {
        this.chain = this.chain
            .then(async () => {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.appendFile(this.filePath, JSON.stringify(line) + "\n", "utf-8");
            })
            .catch((e: Error) =>
                console.error("[Guards] Failed to append to the journal:", e.message),
            );
    }

    /** Waits for pending writes — used by tests and by graceful shutdown. */
    async flush(): Promise<void> {
        await this.chain;
    }

    /** Records a dropped event once: re-evaluating the same event (after a restart, a cache miss) never duplicates it. */
    record(event: AcediaEvent, ruleId: string | undefined, now: number = Date.now()): void {
        const key = event.dedupeKey;
        if (this.restored.has(key)) return;
        const existing = this.active.get(key);
        if (existing && existing.ruleId === ruleId) return;
        this.active.set(key, { ts: now, ruleId, event });
        this.append({ kind: "filtered", ts: now, ruleId, event });
    }

    isFiltered(key: string): boolean {
        return this.active.has(key);
    }

    isRestored(key: string): boolean {
        return this.restored.has(key);
    }

    get(key: string): JournalEntry | undefined {
        return this.active.get(key);
    }

    /** Newest first. */
    list(limit = 100): JournalEntry[] {
        return [...this.active.values()].sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, limit));
    }

    get size(): number {
        return this.active.size;
    }

    /** Takes the event out of the journal and marks it as user-restored; returns it for re-dispatch. */
    restore(key: string, now: number = Date.now()): AcediaEvent | undefined {
        const entry = this.active.get(key);
        if (!entry) return undefined;
        this.active.delete(key);
        this.restored.set(key, now);
        this.append({ kind: "restored", ts: now, dedupeKey: key });
        return entry.event;
    }

    /** A rule edit stopped dropping this event: it leaves the journal without being forced through later. */
    release(key: string, now: number = Date.now()): void {
        if (!this.active.delete(key)) return;
        this.append({ kind: "released", ts: now, dedupeKey: key });
    }

    /** Drops entries older than the retention window and rewrites the file compactly. */
    async prune(now: number = Date.now()): Promise<void> {
        const cutoff = now - this.retentionMs;
        let changed = false;
        for (const [key, entry] of this.active)
            if (entry.ts < cutoff) {
                this.active.delete(key);
                changed = true;
            }
        for (const [key, ts] of this.restored)
            if (ts < cutoff) {
                this.restored.delete(key);
                changed = true;
            }
        if (!changed) return;
        const lines: JournalLine[] = [
            ...[...this.active.values()].map((e): JournalLine => ({
                kind: "filtered",
                ts: e.ts,
                ruleId: e.ruleId,
                event: e.event,
            })),
            ...[...this.restored].map(([dedupeKey, ts]): JournalLine => ({
                kind: "restored",
                ts,
                dedupeKey,
            })),
        ];
        this.chain = this.chain
            .then(async () => {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.writeFile(
                    this.filePath,
                    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
                    "utf-8",
                );
            })
            .catch((e: Error) =>
                console.error("[Guards] Failed to compact the journal:", e.message),
            );
        await this.chain;
    }
}
