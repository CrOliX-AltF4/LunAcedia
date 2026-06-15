import type { IConnector } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";

const DEDUP_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days
const URGENT_POLL_MS = 60_000;

type EventHandler = (event: AcediaEvent) => void;

/**
 * Orchestrates all connectors — polls on their preferred interval,
 * deduplicates events, and dispatches to registered handlers.
 *
 * Standalone: no dependency on Natsume. Handlers are registered by the WS server.
 */
export class IngestionHub {
    private readonly handlers   = new Set<EventHandler>();
    private readonly seen       = new Map<string, number>(); // dedupeKey → ts
    private urgentTimer:  ReturnType<typeof setInterval> | null = null;
    private normalTimer:  ReturnType<typeof setInterval> | null = null;
    private started = false;

    constructor(private readonly connectors: IConnector[]) {}

    onEvent(handler: EventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    start(): void {
        if (this.started) return;
        this.started = true;

        this.purgeSeen();

        // Initial sweep
        void this.pollAll();

        this.urgentTimer = setInterval(() => void this.pollUrgent(), URGENT_POLL_MS);

        const normalInterval = this.connectors.reduce(
            (min, c) => Math.min(min, c.preferredPollIntervalMs ?? 120_000),
            120_000,
        );
        this.normalTimer = setInterval(() => void this.pollAll(), normalInterval);
    }

    stop(): void {
        if (this.urgentTimer) { clearInterval(this.urgentTimer); this.urgentTimer = null; }
        if (this.normalTimer) { clearInterval(this.normalTimer); this.normalTimer = null; }
        this.started = false;
    }

    private async pollAll(): Promise<void> {
        for (const connector of this.connectors) {
            await this.pollConnector(connector);
        }
    }

    private async pollUrgent(): Promise<void> {
        for (const connector of this.connectors) {
            try {
                const events = await connector.poll();
                for (const e of events.filter((e) => e.priority === "urgent")) {
                    this.dispatch(e);
                }
            } catch (err) {
                console.error(`[Hub] ${connector.name} urgent poll error:`, (err as Error).message);
            }
        }
    }

    private async pollConnector(connector: IConnector): Promise<void> {
        try {
            const events = await connector.poll();
            for (const e of events) this.dispatch(e);
        } catch (err) {
            console.error(`[Hub] ${connector.name} poll error:`, (err as Error).message);
        }
    }

    private dispatch(event: AcediaEvent): void {
        if (this.seen.has(event.dedupeKey)) return;

        this.seen.set(event.dedupeKey, event.ts);
        for (const handler of this.handlers) {
            try { handler(event); } catch { /* never throw from dispatch */ }
        }
    }

    private purgeSeen(): void {
        const cutoff = Date.now() - DEDUP_TTL_MS;
        for (const [key, ts] of this.seen) {
            if (ts < cutoff) this.seen.delete(key);
        }
    }
}
