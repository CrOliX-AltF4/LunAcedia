import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";

/** Where the box lives on disk — next to dedup_seen.json, which it must stay consistent with. */
export function defaultEventStorePath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "inbox_store.json");
}

export interface EventQuery {
    source?: AcediaEventSource;
    priority?: AcediaEventPriority;
    since?: number;
    limit?: number;
    offset?: number;
    unread?: boolean;
    /** Only events carrying this guard tag (case-insensitive). */
    tag?: string;
}

/**
 * Ring buffer for AcediaEvents — since ADR-018 it IS the box.
 * Oldest event is evicted when capacity is reached.
 * Thread-safe for single-threaded Node.js use.
 *
 * Persisted when given a file (the live check of 2026-09-28): it used to be memory-only on the idea
 * that polls refill it within seconds, but dedup is persisted, so after a restart the mail already in the
 * inbox was "seen" and never collected again — the box stayed empty. Every change rewrites the file
 * (≤ maxSize events), writes are chained so they land in order.
 */
export class EventStore {
    private buf: AcediaEvent[] = [];
    private chain: Promise<void> = Promise.resolve();
    private writeQueued = false;

    constructor(
        private readonly maxSize = 1000,
        private readonly filePath?: string,
    ) {}

    /** Restores the box from disk; a missing or unreadable file means an empty box, never a crash. */
    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            if (Array.isArray(parsed)) this.buf = (parsed as AcediaEvent[]).slice(-this.maxSize);
        } catch {
            // first run, or a torn file: start empty — recovery re-collects what the source still has
        }
    }

    /** Waits for pending writes — used by tests and by graceful shutdown. */
    async flush(): Promise<void> {
        await this.chain;
    }

    private persist(): void {
        if (!this.filePath || this.writeQueued) return;
        this.writeQueued = true;
        const file = this.filePath;
        this.chain = this.chain
            .then(async () => {
                this.writeQueued = false;
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, JSON.stringify(this.buf), "utf-8");
            })
            .catch((e: Error) => {
                this.writeQueued = false;
                console.error("[Store] Failed to persist the box:", e.message);
            });
    }

    push(event: AcediaEvent): void {
        this.buf.push(event);
        if (this.buf.length > this.maxSize) this.buf.shift();
        this.persist();
    }

    has(dedupeKey: string): boolean {
        return this.buf.some((e) => e.dedupeKey === dedupeKey);
    }

    query(opts: EventQuery = {}): { events: AcediaEvent[]; total: number } {
        const { source, priority, since, limit = 50, offset = 0, unread, tag } = opts;
        const wantedTag = tag?.toLowerCase();
        const filtered = this.buf.filter((e) => {
            if (source && e.source !== source) return false;
            if (priority && e.priority !== priority) return false;
            if (since && e.ts < since) return false;
            if (unread && e.read) return false;
            if (wantedTag && !(e.tags ?? []).some((t) => t.toLowerCase() === wantedTag))
                return false;
            return true;
        });
        // Most recent first — by date, not by arrival: a mail re-collected after a restart is older than
        // what arrived meanwhile. Stable, so equal dates keep newest-arrival first.
        const sorted = filtered
            .slice()
            .reverse()
            .sort((a, b) => b.ts - a.ts);
        return { events: sorted.slice(offset, offset + limit), total: sorted.length };
    }

    get(dedupeKey: string): AcediaEvent | undefined {
        for (let i = this.buf.length - 1; i >= 0; i--) {
            if (this.buf[i]!.dedupeKey === dedupeKey) return this.buf[i];
        }
        return undefined;
    }

    stats(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const e of this.buf) {
            counts[e.source] = (counts[e.source] ?? 0) + 1;
        }
        return counts;
    }

    markRead(dedupeKey: string): void {
        for (let i = this.buf.length - 1; i >= 0; i--) {
            if (this.buf[i]!.dedupeKey === dedupeKey) {
                this.buf[i]!.read = true;
                this.persist();
                return;
            }
        }
    }

    markAllRead(): void {
        for (const e of this.buf) {
            e.read = true;
        }
        this.persist();
    }

    markUnread(dedupeKey: string): void {
        for (let i = this.buf.length - 1; i >= 0; i--) {
            if (this.buf[i]!.dedupeKey === dedupeKey) {
                this.buf[i]!.read = false;
                this.persist();
                return;
            }
        }
    }

    /** Drops an event entirely — for actions whose real-world effect (Gmail trash, calendar
     *  delete, task delete) means the notification itself no longer has anything to point at.
     *  A no-op if the key isn't present (already evicted, or never existed). */
    remove(dedupeKey: string): void {
        const idx = this.buf.findIndex((e) => e.dedupeKey === dedupeKey);
        if (idx !== -1) {
            this.buf.splice(idx, 1);
            this.persist();
        }
    }

    /** Drops every already-read event — the "vider les lus" bulk action. Unread events are
     *  never touched, no matter how old. Returns the number removed, for UI feedback. */
    removeAllRead(): number {
        const before = this.buf.length;
        for (let i = this.buf.length - 1; i >= 0; i--) {
            if (this.buf[i]!.read) this.buf.splice(i, 1);
        }
        const removed = before - this.buf.length;
        if (removed > 0) this.persist();
        return removed;
    }

    get size(): number {
        return this.buf.length;
    }

    get unreadCount(): number {
        return this.buf.filter((e) => !e.read).length;
    }
}
