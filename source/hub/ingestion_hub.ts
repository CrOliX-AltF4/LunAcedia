import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { IConnector } from "../connectors/connector_interface.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { GuardPipeline } from "../guards/guard_pipeline.js";

const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const URGENT_POLL_MS = 60_000;

function resolveSeenPath(): string {
    const storageDir = process.env["STORAGE_DIR"] ?? path.join(os.homedir(), ".lunacedia");
    return path.join(storageDir, "dedup_seen.json");
}

/**
 * `recovered`: not news to anyone downstream — the box lost this item and it came back (recoverMissing), it
 * was collected by the first sweep of a fresh install, or its connector flagged it as backlog (`meta.backlog`:
 * an old mail collected because the box is the whole inbox, C7). Stored in the box, never announced.
 */
export interface DispatchMeta {
    recovered: boolean;
}

type EventHandler = (event: AcediaEvent, meta?: DispatchMeta) => void;

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
    private readonly recovering = new Set<string>(); // forgotten by recoverMissing(), not yet re-collected
    /** No dedup file at load: the first sweep is the backlog (fresh install, storage moved), not news. */
    private quietFirstSweep = false;
    private readonly health = new Map<string, HealthState>(); // connector slug → poll health
    private readonly seenPath: string;
    private urgentTimer: ReturnType<typeof setInterval> | null = null;
    private normalTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;

    constructor(
        private readonly connectors: IConnector[],
        seenPath?: string,
        private readonly guard?: GuardPipeline,
    ) {
        this.seenPath = seenPath ?? resolveSeenPath();
        for (const c of connectors) {
            this.health.set(c.slug, { lastSuccessAt: null, lastError: null });
            c.setSettledFilter?.((key) => this.isSettled(key));
        }
    }

    /** Already dispatched, or dropped by a guard under the current rules — nothing left to do for this key. */
    private isSettled(key: string): boolean {
        return this.seen.has(key) || (this.guard?.isSettled(key) ?? false);
    }

    /**
     * The guard stage (chantier A): runs at COLLECTION, before the urgent filter and before dedup, so the
     * two poll paths (urgent every 60 s, normal on the connector interval) share one behaviour and a rule's
     * `set_priority` can promote an event even on the urgent path. Settled keys are skipped without being
     * re-evaluated (or re-counted).
     */
    private applyGuard(events: AcediaEvent[]): AcediaEvent[] {
        if (!this.guard) return events;
        const out: AcediaEvent[] = [];
        for (const event of events) {
            if (this.isSettled(event.dedupeKey)) continue;
            const outcome = this.guard.process(event);
            if (!outcome.dropped) out.push(outcome.event);
        }
        return out;
    }

    /**
     * Drops a key from dedup (ADR-018 R8): an item removed because its source object is gone comes back if
     * the object does — a mail restored from the trash, a GitHub thread with new activity.
     */
    forget(key: string): void {
        if (this.seen.delete(key)) void this.saveSeen();
    }

    /**
     * Forgets every seen key the box no longer holds so the next collection takes it again, and flags its
     * return as recovered (live check 2026-09-28): the box used to be memory-only while this dedup was on
     * disk, so a restart left the inbox's mail "seen" and never shown. A recovered item is not news — the
     * caller stores it without re-broadcasting or pushing it. Call after load(), before start(). Returns
     * the number of keys forgotten; one that the source no longer has simply never comes back (R8).
     */
    recoverMissing(isHeld: (key: string) => boolean): number {
        let forgotten = 0;
        for (const key of [...this.seen.keys()]) {
            if (isHeld(key)) continue;
            this.seen.delete(key);
            this.recovering.add(key);
            forgotten++;
        }
        if (forgotten > 0) void this.saveSeen();
        return forgotten;
    }

    /** Re-dispatches a user-restored event, bypassing both dedup and the guard (the user's decision wins). */
    dispatchRestored(event: AcediaEvent): void {
        this.seen.set(event.dedupeKey, event.ts);
        void this.saveSeen();
        this.notify(event);
    }

    /**
     * Restores dedup state from the last run — without this, every restart replayed every
     * currently-unread source event from scratch (AlertQueue.push() masks the duplicate
     * *entry*, but JarvisClient.handleEvent() still re-triggers proactive voice for each one
     * unconditionally, so a LunAcedia restart re-announced every open alert). Call before
     * start(), same convention as ActionTierStore/GoogleTokenStore's load().
     */
    async load(): Promise<void> {
        try {
            const raw = await fs.readFile(this.seenPath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, number>;
            for (const [key, ts] of Object.entries(parsed)) this.seen.set(key, ts);
        } catch {
            // File absent or unreadable — start empty, and keep the first sweep quiet: what it collects
            // was already there, announcing it would ring the phone for the whole backlog.
            this.quietFirstSweep = true;
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
        void this.pollAll().finally(() => {
            this.quietFirstSweep = false;
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
                for (const e of this.applyGuard(events).filter((e) => e.priority === "urgent")) {
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
            for (const e of this.applyGuard(events)) this.dispatch(e);
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
        void this.saveSeen();
        const recovered =
            this.recovering.delete(event.dedupeKey) ||
            this.quietFirstSweep ||
            event.meta?.["backlog"] === true;
        this.notify(event, { recovered });
    }

    private notify(event: AcediaEvent, meta: DispatchMeta = { recovered: false }): void {
        for (const handler of this.handlers) {
            try {
                handler(event, meta);
            } catch {
                /* never throw from dispatch */
            }
        }
    }

    private purgeSeen(): void {
        const cutoff = Date.now() - DEDUP_TTL_MS;
        let purged = false;
        for (const [key, ts] of this.seen) {
            if (ts < cutoff) {
                this.seen.delete(key);
                purged = true;
            }
        }
        if (purged) void this.saveSeen();
    }

    private async saveSeen(): Promise<void> {
        try {
            await fs.mkdir(path.dirname(this.seenPath), { recursive: true });
            await fs.writeFile(
                this.seenPath,
                JSON.stringify(Object.fromEntries(this.seen)),
                "utf-8",
            );
        } catch (e) {
            console.error("[Hub] Failed to persist dedup state:", (e as Error).message);
        }
    }
}
