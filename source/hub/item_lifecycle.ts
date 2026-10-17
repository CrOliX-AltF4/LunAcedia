/**
 * The life of a box item, told as transitions: collected, refreshed, changed (read, unread, removed). Every path that
 * changes an item — collection, the source sync, Master's gestures, an action carried out, the agent reading a mail,
 * reminders — asks this module, which writes the box and dedup and derives the effects once: the views that follow,
 * the Core, the phone. No path decides them on its own any more (the cause of the patches piled on the box).
 */
import type { ChangeFeed } from "../changes/change_feed.js";
import type { KnownItems } from "./ingestion_hub.js";
import type { EventStore } from "../store/event_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";

/** The wire type of a change message to the Core — never stored as an item by any consumer. */
export const INBOX_CHANGED = "inbox.changed" as const;

export interface InboxChange {
    /** `updated`: the item is still there but its content changed at the source — `item` carries it. */
    op: "removed" | "read" | "unread" | "updated";
    key: string;
    source: AcediaEvent["source"];
    item?: Pick<AcediaEvent, "title" | "body" | "priority" | "ts" | "ai">;
}

/** A change message as an AcediaEvent envelope (same wire as every event, its own type). */
export function toWire(change: InboxChange, ts: number = Date.now()): AcediaEvent {
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

/**
 * Why an item enters the box. `new`: collected from its source. `backlog`: already there before (a fresh install's
 * first sweep, an old mail of the inbox) — in the box only, it is news to no one. `reminder`: the planning calls for
 * it; its truth is the planning, never a source.
 */
export type CollectCause = "new" | "backlog" | "reminder" | "conflict";

export type ItemOp = "read" | "unread" | "removed";

/**
 * Why an item is read, unread or gone. `source`: seen at the source. `gesture`: Master in the box. `action`: an action
 * carried out. `agent`: the agent read the mail in full. `expired`: an informational item (RSS, HA) past its lifetime —
 * remembered as gone, being still in its feed. `settled`: the planning no longer calls for a reminder. `snoozed`:
 * Master pushed a reminder back. `planning`: an event or a task the box held before the planning took them over.
 * `dismissed`: a conflict Master left as it is — remembered as gone, not brought back while it lasts.
 * Every removal but `expired` and `dismissed` lets the item come back if its source lists it again.
 */
export type ChangeCause =
    | "source"
    | "gesture"
    | "action"
    | "agent"
    | "expired"
    | "settled"
    | "snoozed"
    | "planning"
    | "dismissed";

export interface ItemLifecycleDeps {
    store: EventStore;
    changes: Pick<ChangeFeed, "emit">;
    /** Sends to the Core (the WebSocket): a new item, or a change message. */
    broadcast: (event: AcediaEvent) => void;
    /** Whether a new item rings the phone (notify_policy.ts) — decided here once, for LunAcedia and for a hub. */
    rings: (event: AcediaEvent) => boolean;
    /** Rings the phone registered with LunAcedia (FCM) — a wired phone is registered with the hub instead. */
    push: (event: AcediaEvent) => void;
    /** Whether a model may read it (its class of mail) — told to the Core with the item. Absent: readable. */
    aiReadable?: (event: AcediaEvent) => boolean;
}

export class ItemLifecycle implements KnownItems {
    constructor(private readonly deps: ItemLifecycleDeps) {}

    /** The box alone, telling no one — where nothing listens (tests, tools). */
    static local(store: EventStore): ItemLifecycle {
        const none = (): void => {};
        return new ItemLifecycle({
            store,
            changes: { emit: none },
            broadcast: none,
            rings: () => false,
            push: none,
        });
    }

    collected(event: AcediaEvent, cause: CollectCause): void {
        this.deps.store.push(event);
        this.deps.changes.emit("box", event.dedupeKey);
        if (cause === "backlog") return;
        const notify = this.deps.rings(event);
        const ai = this.deps.aiReadable?.(event) ?? true;
        this.deps.broadcast({ ...event, notify, ...(!ai && { ai: false }) });
        if (notify) this.deps.push(event);
    }

    /**
     * Content changed at the source (moved event, new due date): the Core refreshes its copy by key — never the event
     * itself, which it would announce as news. A backlog item was never sent to the Core, so its refresh is not either.
     */
    refreshed(fresh: AcediaEvent): void {
        const updated = this.deps.store.refresh(fresh);
        if (!updated || updated.meta?.["backlog"] === true) return;
        const { title, body, priority, ts } = updated;
        // Whether a model may read it travels with every update: filing a mail in another class changes it.
        const ai = this.deps.aiReadable?.(updated) ?? true;
        this.tell({
            op: "updated",
            key: updated.dedupeKey,
            source: updated.source,
            item: { title, body, priority, ts, ai },
        });
    }

    /**
     * An item read, unread or gone, already so at its source when there is one. An item the box does not hold changes
     * nothing and tells no one. Returns whether the box held it.
     */
    changed(key: string, op: ItemOp, cause: ChangeCause): boolean {
        const held = this.deps.store.get(key);
        if (!held) return false;
        if (op === "removed") {
            this.deps.store.remove(key);
            // Expired (still in its feed) or dismissed (a conflict Master left): remembered as gone, not news again.
            if (cause === "expired" || cause === "dismissed") this.deps.store.markGone(key);
        } else if (op === "read") {
            this.deps.store.markRead(key);
        } else {
            this.deps.store.markUnread(key);
        }
        this.tell({ op, key, source: held.source });
        return true;
    }

    knows(key: string): boolean {
        return this.deps.store.knows(key);
    }

    goneAtCollection(key: string): void {
        this.deps.store.markGone(key);
    }

    isFresh(): boolean {
        return this.deps.store.isFresh();
    }

    /** Its object is back at the source (a mail restored from the trash): the next collection takes it again. */
    mayReturn(key: string): void {
        this.deps.store.clearGone(key);
    }

    /** Forgets the keys gone before `cutoff`, so a source listing them long after may bring them back. */
    forgetGoneBefore(cutoff: number): number {
        return this.deps.store.purgeGone(cutoff);
    }

    /** The Core on the WebSocket, and the views that follow — settled when read or gone, so a notification comes down. */
    private tell(change: InboxChange): void {
        this.deps.broadcast(toWire(change));
        this.deps.changes.emit("box", change.key, change.op === "removed" || change.op === "read");
    }
}
