import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";
import { VIP_REASON } from "../guards/guard_types.js";

/** Where the box lives on disk: the items held, and the keys gone that must not come back. */
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

/** What the source says about an item — not what the box decided (read state, guard tags). */
function sameContent(a: AcediaEvent, b: AcediaEvent): boolean {
    return (
        a.type === b.type &&
        a.ts === b.ts &&
        a.title === b.title &&
        a.body === b.body &&
        a.url === b.url &&
        a.priority === b.priority &&
        JSON.stringify(a.meta ?? {}) === JSON.stringify(b.meta ?? {})
    );
}

/** The file's shape since the box and dedup became one state (version 1 was the bare list of items). */
interface StoredBox {
    version: 2;
    items: AcediaEvent[];
    /** dedupeKey → when it left the box. */
    gone: Record<string, number>;
}

/**
 * The box, and everything it knows about a key: held (an item), gone and not to come back (`gone`: expired,
 * taken out at the source by a rule, evicted past capacity), or unknown — collected as news when a source lists it.
 * One state, one file: dedup used to live in a file of its own, and keeping the two consistent across restarts
 * cost a recovery pass that brought gone items back.
 *
 * Only ItemLifecycle changes it. The oldest item is evicted past capacity — and remembered as gone, or the next
 * collection would announce it as new. Every change rewrites the file atomically (a temporary file, then a
 * rename); writes are chained so they land in order.
 */
export class EventStore {
    private buf: AcediaEvent[] = [];
    private readonly gone = new Map<string, number>();
    /** Nothing on disk at load: a first run (or a lost file) — what the first collection finds is not news. */
    private fresh = false;
    private chain: Promise<void> = Promise.resolve();
    private writeQueued = false;

    constructor(
        private readonly maxSize = 1000,
        private readonly filePath?: string,
    ) {}

    /**
     * Restores the box from disk; a missing or unreadable file means an empty, fresh box, never a crash. Reads the
     * version-1 file (the bare list of items) as well: the next write turns it into version 2.
     */
    async load(): Promise<void> {
        if (!this.filePath) return;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8")) as unknown;
            if (Array.isArray(parsed)) {
                this.buf = (parsed as AcediaEvent[]).slice(-this.maxSize);
            } else if (isStoredBox(parsed)) {
                this.buf = parsed.items.slice(-this.maxSize);
                for (const [key, at] of Object.entries(parsed.gone)) this.gone.set(key, at);
            } else {
                this.fresh = true;
            }
        } catch {
            this.fresh = true;
        }
    }

    /** Whether load() found nothing to restore. */
    isFresh(): boolean {
        return this.fresh;
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
                const box: StoredBox = {
                    version: 2,
                    items: this.buf,
                    gone: Object.fromEntries(this.gone),
                };
                await fs.mkdir(path.dirname(file), { recursive: true });
                // Atomic: a crash mid-write leaves the previous file whole, never a torn one.
                const tmp = `${file}.tmp`;
                await fs.writeFile(tmp, JSON.stringify(box), "utf-8");
                await fs.rename(tmp, file);
            })
            .catch((e: Error) => {
                this.writeQueued = false;
                console.error("[Store] Failed to persist the box:", e.message);
            });
    }

    push(event: AcediaEvent, now: number = Date.now()): void {
        this.gone.delete(event.dedupeKey);
        this.buf.push(event);
        if (this.buf.length > this.maxSize) {
            const evicted = this.buf.shift()!;
            if (!this.has(evicted.dedupeKey)) this.gone.set(evicted.dedupeKey, now);
        }
        this.persist();
    }

    /**
     * Replaces a held item with a fresh collection of it when its content changed at the source (
     * a moved event, a new due date). What the box decided locally survives: the read state (unless the
     * source reports one), and the guard's tags/ruleId/priority (a refresh does not go through the guard again).
     * Returns the stored item when it changed, null when nothing changed or the key is not held.
     */
    refresh(fresh: AcediaEvent): AcediaEvent | null {
        const idx = this.buf.findIndex((e) => e.dedupeKey === fresh.dedupeKey);
        if (idx === -1) return null;
        const held = this.buf[idx]!;
        // A guard rule or the VIP list may have set the priority: that choice stands over the source's.
        const decided = held.ruleId !== undefined || held.priorityReason === VIP_REASON;
        const decidedEvent = decided
            ? {
                  ...fresh,
                  priority: held.priority,
                  ...(held.priorityReason && { priorityReason: held.priorityReason }),
              }
            : fresh;
        // A mail Master filed by hand keeps its class over what the source and the rules say.
        const incoming =
            held.meta?.["mailClassByHand"] === true
                ? {
                      ...decidedEvent,
                      meta: {
                          ...decidedEvent.meta,
                          mailClass: held.meta["mailClass"],
                          mailClassByHand: true,
                      },
                  }
                : decidedEvent;
        if (sameContent(held, incoming)) return null;
        const merged: AcediaEvent = {
            ...incoming,
            read: fresh.read ?? held.read,
            ...(held.tags && { tags: held.tags }),
            ...(held.ruleId && { ruleId: held.ruleId }),
        };
        this.buf[idx] = merged;
        this.persist();
        return merged;
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

    markRead(dedupeKey: string): void {
        for (let i = this.buf.length - 1; i >= 0; i--) {
            if (this.buf[i]!.dedupeKey === dedupeKey) {
                this.buf[i]!.read = true;
                this.persist();
                return;
            }
        }
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

    /** Held, or gone and not to come back: a source listing it again is not news. */
    knows(dedupeKey: string): boolean {
        return this.gone.has(dedupeKey) || this.has(dedupeKey);
    }

    isGone(dedupeKey: string): boolean {
        return this.gone.has(dedupeKey);
    }

    /** Remembers a key that left (or never entered) the box and must not come back as news. */
    markGone(dedupeKey: string, at: number = Date.now()): void {
        this.gone.set(dedupeKey, at);
        this.persist();
    }

    /** The key may come back: its object returned at the source (a mail restored from the trash). */
    clearGone(dedupeKey: string): void {
        if (this.gone.delete(dedupeKey)) this.persist();
    }

    /** Forgets the keys gone before `cutoff` — a held item is never forgotten. Returns how many. */
    purgeGone(cutoff: number): number {
        let purged = 0;
        for (const [key, at] of this.gone) {
            if (at >= cutoff) continue;
            this.gone.delete(key);
            purged++;
        }
        if (purged > 0) this.persist();
        return purged;
    }

    get size(): number {
        return this.buf.length;
    }
}

function isStoredBox(value: unknown): value is StoredBox {
    const v = value as Partial<StoredBox> | null;
    return (
        typeof v === "object" &&
        v !== null &&
        Array.isArray(v.items) &&
        typeof v.gone === "object" &&
        v.gone !== null
    );
}
