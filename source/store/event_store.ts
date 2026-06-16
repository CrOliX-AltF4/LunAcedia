import type { AcediaEvent, AcediaEventSource, AcediaEventPriority } from "../types/acedia_event.js";

export interface EventQuery {
    source?:   AcediaEventSource;
    priority?: AcediaEventPriority;
    since?:    number;
    limit?:    number;
    offset?:   number;
}

/**
 * In-memory ring buffer for AcediaEvents.
 * Oldest event is evicted when capacity is reached.
 * Thread-safe for single-threaded Node.js use.
 */
export class EventStore {
    private readonly buf: AcediaEvent[] = [];

    constructor(private readonly maxSize = 1000) {}

    push(event: AcediaEvent): void {
        this.buf.push(event);
        if (this.buf.length > this.maxSize) this.buf.shift();
    }

    query(opts: EventQuery = {}): { events: AcediaEvent[]; total: number } {
        const { source, priority, since, limit = 50, offset = 0 } = opts;
        const filtered = this.buf.filter((e) => {
            if (source   && e.source   !== source)   return false;
            if (priority && e.priority !== priority) return false;
            if (since    && e.ts       <  since)     return false;
            return true;
        });
        // Most recent first
        const sorted = filtered.slice().reverse();
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

    get size(): number { return this.buf.length; }
}
