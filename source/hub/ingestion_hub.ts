import type { IConnector } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";

const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const URGENT_POLL_MS = 60_000;

type EventHandler = (event: AcediaEvent) => void;

export interface ConnectorHealth {
    slug: string;
    name: string;
    /** True only once a poll has actually succeeded and the most recent attempt didn't fail. */
    connected: boolean;
    lastSuccessAt: number | null;
    lastError: string | null;
}

interface HealthState {
    lastSuccessAt: number | null;
    lastError: string | null;
}

/**
 * Orchestrates all connectors — polls on their preferred interval,
 * deduplicates events, and dispatches to registered handlers.
 *
 * Standalone: no dependency on Natsume. Handlers are registered by the WS server.
 */
export class IngestionHub {
    private readonly handlers = new Set<EventHandler>();
    private readonly seen = new Map<string, number>(); // dedupeKey → ts
    private readonly health = new Map<string, HealthState>(); // connector slug → poll health
    private urgentTimer: ReturnType<typeof setInterval> | null = null;
    private normalTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;

    constructor(private readonly connectors: IConnector[]) {
        for (const c of connectors) {
            this.health.set(c.slug, { lastSuccessAt: null, lastError: null });
        }
    }

    onEvent(handler: EventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    /**
     * Real connectivity, not just "enabled" — connected only reflects a connector that
     * has actually completed a successful poll and whose most recent attempt didn't fail.
     * A misconfigured/expired token shows up here instead of silently reporting "connected"
     * forever the way "present in the connectors array" used to.
     */
    getConnectorHealth(): ConnectorHealth[] {
        return this.connectors.map((c) => {
            const state = this.health.get(c.slug) ?? { lastSuccessAt: null, lastError: null };
            return {
                slug: c.slug,
                name: c.name,
                connected: state.lastSuccessAt !== null && state.lastError === null,
                lastSuccessAt: state.lastSuccessAt,
                lastError: state.lastError,
            };
        });
    }

    /**
     * Force an immediate poll of a single connector, outside its normal interval — the
     * panel's "Reconnect" button. Health (lastSuccessAt/lastError) updates synchronously
     * with the result, unlike a passive wait for the next scheduled pollAll()/pollUrgent()
     * tick (up to `preferredPollIntervalMs`, several minutes for some connectors).
     */
    async pollOne(slug: string): Promise<{ ok: boolean; error?: string }> {
        const connector = this.connectors.find((c) => c.slug === slug);
        if (!connector) return { ok: false, error: "Unknown connector" };
        await this.pollConnector(connector); // never throws — records success/error internally
        const health = this.health.get(connector.slug);
        return health?.lastError ? { ok: false, error: health.lastError } : { ok: true };
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
        if (this.urgentTimer) {
            clearInterval(this.urgentTimer);
            this.urgentTimer = null;
        }
        if (this.normalTimer) {
            clearInterval(this.normalTimer);
            this.normalTimer = null;
        }
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
                this.recordSuccess(connector);
                for (const e of events.filter((e) => e.priority === "urgent")) {
                    this.dispatch(e);
                }
            } catch (err) {
                this.recordError(connector, (err as Error).message);
                console.error(`[Hub] ${connector.name} urgent poll error:`, (err as Error).message);
            }
        }
    }

    private async pollConnector(connector: IConnector): Promise<void> {
        try {
            const events = await connector.poll();
            this.recordSuccess(connector);
            for (const e of events) this.dispatch(e);
        } catch (err) {
            this.recordError(connector, (err as Error).message);
            console.error(`[Hub] ${connector.name} poll error:`, (err as Error).message);
        }
    }

    private recordSuccess(connector: IConnector): void {
        this.health.set(connector.slug, { lastSuccessAt: Date.now(), lastError: null });
    }

    private recordError(connector: IConnector, message: string): void {
        const prior = this.health.get(connector.slug) ?? { lastSuccessAt: null, lastError: null };
        this.health.set(connector.slug, { lastSuccessAt: prior.lastSuccessAt, lastError: message });
    }

    private dispatch(event: AcediaEvent): void {
        if (this.seen.has(event.dedupeKey)) return;

        this.seen.set(event.dedupeKey, event.ts);
        for (const handler of this.handlers) {
            try {
                handler(event);
            } catch {
                /* never throw from dispatch */
            }
        }
    }

    private purgeSeen(): void {
        const cutoff = Date.now() - DEDUP_TTL_MS;
        for (const [key, ts] of this.seen) {
            if (ts < cutoff) this.seen.delete(key);
        }
    }
}
