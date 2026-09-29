/**
 * The sync rule (ADR-018 R8, CrOliX 2026-09-25): an item never outlives its linked object. Mail archived,
 * trashed or read — in Gmail itself, from the Core's panel, the mobile app or through Natsume — the item
 * follows, and the Core is told so its notification dies too and Natsume stops mentioning it.
 *
 * Two entry points, one outcome: `reconcile()` asks each source where the items we hold stand (changes made
 * elsewhere), `applyLocal()` records a gesture made through LunAcedia itself. Either way the store is
 * updated and the change is emitted on the wire. Never removes on uncertainty: a source that cannot be
 * asked, or cannot judge an item, changes nothing.
 */
import type { IConnector } from "../connectors/connector_interface.js";
import type { EventStore } from "../store/event_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";

/** The wire type of a sync message — never stored as an item by any consumer. */
export const INBOX_CHANGED = "inbox.changed" as const;

export interface InboxChange {
    /** `updated` (ADR-019 L3): the item is still there but its content changed at the source — `item` carries it. */
    op: "removed" | "read" | "unread" | "updated";
    key: string;
    source: AcediaEvent["source"];
    item?: Pick<AcediaEvent, "title" | "body" | "priority" | "ts">;
}

export interface InboxSyncDeps {
    connectors: IConnector[];
    store: EventStore;
    /** Sends the change to the clients (the Core, over the WebSocket). */
    emit: (change: InboxChange) => void;
    /** Drops the key from dedup so the item comes back if its object does (restored mail, new activity). */
    forget: (key: string) => void;
}

const STORE_SCAN = 1_000;

export class InboxSync {
    private running = false;

    constructor(private readonly deps: InboxSyncDeps) {}

    /** The sync message as an AcediaEvent envelope (same wire as every event, its own type). */
    static toWire(change: InboxChange, ts: number = Date.now()): AcediaEvent {
        return {
            type: INBOX_CHANGED,
            ts,
            source: change.source,
            title: "",
            priority: "info",
            dedupeKey: `sync-${change.op}-${change.key}-${ts}`,
            meta: { op: change.op, key: change.key, ...(change.item && { item: change.item }) },
        };
    }

    /** One pass over every source that can report state. Overlapping calls are skipped, not queued. */
    async reconcile(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const { events } = this.deps.store.query({ limit: STORE_SCAN });
            for (const connector of this.deps.connectors) {
                if (!connector.sourceState) continue;
                const held = (events as AcediaEvent[]).filter((e) => e.source === connector.slug);
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
                    if (s === "gone")
                        this.applyLocal({ op: "removed", key: e.dedupeKey, source: e.source });
                    else if (s === "read" && !e.read)
                        this.applyLocal({ op: "read", key: e.dedupeKey, source: e.source });
                    else if (s === "unread" && e.read)
                        this.applyLocal({ op: "unread", key: e.dedupeKey, source: e.source });
                }
            }
        } finally {
            this.running = false;
        }
    }

    /** A change already made at the source (by a gesture or seen by reconcile): store, dedup, wire. */
    applyLocal(change: InboxChange): void {
        if (change.op === "removed") {
            this.deps.store.remove(change.key);
            this.deps.forget(change.key);
        } else if (change.op === "read") {
            this.deps.store.markRead(change.key);
        } else if (change.op === "unread") {
            this.deps.store.markUnread(change.key);
        }
        // "updated": the store already holds the fresh content (EventStore.refresh) — only the wire is left.
        this.deps.emit(change);
    }
}
