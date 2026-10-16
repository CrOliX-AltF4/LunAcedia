import type { IConnector } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { GuardOutcome, GuardPipeline } from "../guards/guard_pipeline.js";

const URGENT_POLL_MS = 60_000;

/**
 * What the hub asks of the box (ItemLifecycle): it keeps no state of its own about what was collected.
 */
export interface KnownItems {
    /** Held, or gone and not to come back: a source listing it again is not news. */
    knows(key: string): boolean;
    /** A rule took it out at the source while it was collected: never stored, never to come back. */
    goneAtCollection(key: string): void;
    /** Nothing was restored at start: the first collection is the backlog, not news. */
    isFresh(): boolean;
}

/**
 * `backlog`: not news to anyone downstream — collected by the first sweep of a fresh install, or flagged as backlog
 * by its connector (`meta.backlog`: an old mail collected because the box is the whole inbox, C7). Stored in the box,
 * never announced.
 */
export interface DispatchMeta {
    backlog: boolean;
}

type EventHandler = (event: AcediaEvent, meta?: DispatchMeta) => void;
/** An already-dispatched item collected again — its content may have changed at the source. */
type RefreshHandler = (event: AcediaEvent) => void;

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
    private readonly refreshHandlers = new Set<RefreshHandler>();
    /** A fresh box: the first sweep is the backlog (fresh install, storage moved), not news. */
    private quietFirstSweep = false;
    private readonly health = new Map<string, HealthState>(); // connector slug → poll health
    private urgentTimer: ReturnType<typeof setInterval> | null = null;
    private normalTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    /** The initial sweep finished: the box reflects the sources (see isReady). */
    private initialSweepDone = false;
    /** Mails a rule already acted on at the source. */
    private readonly ruleActed = new Set<string>();

    constructor(
        private readonly connectors: IConnector[],
        private readonly known: KnownItems,
        private readonly guard?: GuardPipeline,
        /**
         * Carries out what a rule does at the source and says what came of it: `removed` = the mail left the
         * inbox (it is then neither stored nor announced), `read` = it was marked read. Absent: rules only sort the box.
         */
        private readonly ruleActor?: (
            event: AcediaEvent,
            actions: NonNullable<GuardOutcome["source"]>,
        ) => Promise<{ removed: boolean; read: boolean }>,
    ) {
        for (const c of connectors) {
            this.health.set(c.slug, { lastSuccessAt: null, lastError: null });
            c.setSettledFilter?.((key) => this.isSettled(key));
        }
    }

    /** Already dispatched, or dropped by a guard under the current rules — nothing left to do for this key. */
    private isSettled(key: string): boolean {
        return this.known.knows(key) || (this.guard?.isSettled(key) ?? false);
    }

    /**
     * The guard stage: runs at COLLECTION, before the urgent filter and before dedup, so the
     * two poll paths (urgent every 60 s, normal on the connector interval) share one behaviour and a rule's
     * `set_priority` can promote an event even on the urgent path. Settled keys are skipped without being
     * re-evaluated (or re-counted).
     */
    private async applyGuard(events: AcediaEvent[]): Promise<AcediaEvent[]> {
        if (!this.guard) return events;
        const out: AcediaEvent[] = [];
        for (const event of events) {
            if (this.isSettled(event.dedupeKey)) continue;
            const outcome = this.guard.process(event);
            if (outcome.dropped) continue;
            if (outcome.source && this.ruleActor && !this.ruleActed.has(event.dedupeKey)) {
                // Once per mail: the urgent pass sees it again every minute until it is announced, and a refusal
                // at the source is journaled, not retried in a loop.
                this.ruleActed.add(event.dedupeKey);
                const done = await this.ruleActor(outcome.event, outcome.source);
                if (done.removed) {
                    // Out of the inbox at the source: settled, never stored nor announced.
                    this.known.goneAtCollection(event.dedupeKey);
                    continue;
                }
                if (done.read) {
                    out.push({ ...outcome.event, read: true });
                    continue;
                }
            }
            out.push(outcome.event);
        }
        return out;
    }

    /** Re-dispatches a user-restored event, bypassing both dedup and the guard (the user's decision wins). */
    dispatchRestored(event: AcediaEvent): void {
        this.notify(event);
    }

    /**
     * Whether the box reflects the sources yet: false until the initial sweep after start() finished. A
     * client reconciling its copies against the box (the Core) must not remove anything before.
     */
    isReady(): boolean {
        return this.initialSweepDone;
    }

    onEvent(handler: EventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    /**
     * Called for every already-dispatched item a normal poll collects again: a calendar event
     * moved, a task whose due date changed keep their key, so dedup alone would keep the stale version
     * forever. The handler decides whether anything changed.
     */
    onRefresh(handler: RefreshHandler): () => void {
        this.refreshHandlers.add(handler);
        return () => this.refreshHandlers.delete(handler);
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
        this.quietFirstSweep = this.known.isFresh();

        // Initial sweep
        void this.pollAll().finally(() => {
            this.quietFirstSweep = false;
            this.initialSweepDone = true;
        });

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
                for (const e of (await this.applyGuard(events)).filter(
                    (e) => e.priority === "urgent",
                )) {
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
            for (const e of events) if (this.known.knows(e.dedupeKey)) this.refresh(e);
            for (const e of await this.applyGuard(events)) this.dispatch(e);
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

    /** New to the box: the handlers store it (ItemLifecycle), so a second sighting is known. */
    private dispatch(event: AcediaEvent): void {
        if (this.known.knows(event.dedupeKey)) return;
        this.notify(event, { backlog: this.quietFirstSweep || event.meta?.["backlog"] === true });
    }

    private refresh(fresh: AcediaEvent): void {
        // The same chain of priority as at collection: a VIP or a rule's priority is not reset to the source's default.
        const event = this.guard ? this.guard.prioritize(fresh) : fresh;
        for (const handler of this.refreshHandlers) {
            try {
                handler(event);
            } catch {
                /* never throw from a poll */
            }
        }
    }

    private notify(event: AcediaEvent, meta: DispatchMeta = { backlog: false }): void {
        for (const handler of this.handlers) {
            try {
                handler(event, meta);
            } catch {
                /* never throw from dispatch */
            }
        }
    }
}
