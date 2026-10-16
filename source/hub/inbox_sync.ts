/**
 * The sync rule (CrOliX 2026-09-25): an item never outlives its linked object. Mail archived, trashed or read — in
 * Gmail itself, from the Core's panel, the mobile app or through Natsume — the item follows.
 *
 * This is the half that asks: one pass over each source tells where the items we hold stand (changes made elsewhere),
 * and each difference becomes a transition of the item's life (ItemLifecycle), which writes the box and tells everyone.
 * Never removes on uncertainty: a source that cannot be asked, or cannot judge an item, changes nothing.
 */
import type { IConnector } from "../connectors/connector_interface.js";
import type { EventStore } from "../store/event_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";
import type { ItemLifecycle } from "./item_lifecycle.js";

export interface InboxSyncDeps {
    connectors: IConnector[];
    /** Read only: the items held. */
    store: Pick<EventStore, "query">;
    life: Pick<ItemLifecycle, "changed">;
    /**
     * How long a purely informational item (RSS, Home Assistant) stays in the box: there is no
     * source object whose life it could follow, so it expires by age. Default INBOX_INFO_TTL_HOURS (72 h).
     */
    infoTtlMs?: number;
    now?: () => number;
}

/** Sources with no object to follow at the source: their items expire by age. */
const INFORMATIONAL: ReadonlySet<AcediaEvent["source"]> = new Set(["rss", "ha"]);

function defaultInfoTtlMs(): number {
    const hours = parseInt(process.env["INBOX_INFO_TTL_HOURS"] ?? "72", 10);
    return (Number.isFinite(hours) && hours > 0 ? hours : 72) * 3_600_000;
}

const STORE_SCAN = 1_000;

export class InboxSync {
    private running = false;

    constructor(private readonly deps: InboxSyncDeps) {}

    /** One pass over every source that can report state. Overlapping calls are skipped, not queued. */
    async reconcile(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const { events } = this.deps.store.query({ limit: STORE_SCAN });
            for (const connector of this.deps.connectors) {
                if (!connector.sourceState) continue;
                // A reminder lives as long as the reminder engine says, not as long as its source lists it.
                const held = (events as AcediaEvent[]).filter(
                    (e) => e.source === connector.slug && e.type !== "planning.reminder",
                );
                if (held.length === 0) continue;
                let state: Awaited<ReturnType<NonNullable<IConnector["sourceState"]>>>;
                try {
                    state = await connector.sourceState(held);
                } catch (e) {
                    console.warn(
                        `[InboxSync] ${connector.name} state failed:`,
                        (e as Error).message,
                    );
                    continue;
                }
                if (!state) continue;
                for (const e of held) {
                    const s = state.get(e.dedupeKey);
                    if (s === "gone") this.deps.life.changed(e.dedupeKey, "removed", "source");
                    else if (s === "read" && !e.read)
                        this.deps.life.changed(e.dedupeKey, "read", "source");
                    else if (s === "unread" && e.read)
                        this.deps.life.changed(e.dedupeKey, "unread", "source");
                }
            }
            this.expireInformational(events as AcediaEvent[]);
        } finally {
            this.running = false;
        }
    }

    /** Informational items past their lifetime leave the box (they stay in dedup: still in their feed). */
    private expireInformational(events: AcediaEvent[]): void {
        const cutoff = (this.deps.now ?? Date.now)() - (this.deps.infoTtlMs ?? defaultInfoTtlMs());
        for (const e of events) {
            if (!INFORMATIONAL.has(e.source) || e.ts >= cutoff) continue;
            this.deps.life.changed(e.dedupeKey, "removed", "expired");
        }
    }
}
