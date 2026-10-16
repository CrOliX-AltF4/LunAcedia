/**
 * The life of a box item, told as transitions: collected, refreshed, removed. Every path that changes an item asks
 * this module, which writes the box and derives the effects once — the views that follow, the Core, the phone —
 * instead of each path deciding them on its own (the cause of the patches piled on the box).
 *
 * First step: the paths of the entry point (collection, refresh, reminders) go through here with the effects they
 * had; the other paths (gestures, source sync, actions) and a single persisted state with dedup come next.
 */
import { InboxSync, type InboxChange } from "./inbox_sync.js";
import type { ChangeFeed } from "../changes/change_feed.js";
import type { EventStore } from "../store/event_store.js";
import type { AcediaEvent } from "../types/acedia_event.js";

/**
 * Why an item enters the box. `new`: collected from its source. `recovered`: dedup had it but the box lost it — back
 * in the box only, it is news to no one. `reminder`: the planning calls for it; its truth is the planning, never a
 * source.
 */
export type CollectCause = "new" | "recovered" | "reminder";

/**
 * Why an item leaves the box through this module. `settled`: the planning no longer calls for a reminder. `snoozed`:
 * Master pushed a reminder back. `planning`: an event or a task the box held before the planning took them over.
 */
export type RemoveCause = "settled" | "snoozed" | "planning";

export interface ItemLifecycleDeps {
    store: EventStore;
    /** The box's sync path: store, dedup and the change on the wire to the Core. */
    sync: Pick<InboxSync, "applyLocal">;
    changes: Pick<ChangeFeed, "emit">;
    /** Sends an item to the Core (the WebSocket). */
    broadcast: (event: AcediaEvent) => void;
    /** Rings the phone (FCM); filtered by priority and token downstream. */
    push: (event: AcediaEvent) => void;
}

export class ItemLifecycle {
    constructor(private readonly deps: ItemLifecycleDeps) {}

    collected(event: AcediaEvent, cause: CollectCause): void {
        this.deps.store.push(event);
        this.deps.changes.emit("box", event.dedupeKey);
        if (cause === "recovered") return;
        this.deps.broadcast(event);
        // The box holds read items too: only something unread rings the phone.
        if (!event.read) this.deps.push(event);
    }

    /**
     * Content changed at the source (moved event, new due date): the Core refreshes its copy by key — never the event
     * itself, which it would announce as news. A backlog item was never sent to the Core, so its refresh is not either.
     */
    refreshed(fresh: AcediaEvent): void {
        const updated = this.deps.store.refresh(fresh);
        if (!updated || updated.meta?.["backlog"] === true) return;
        const { title, body, priority, ts } = updated;
        this.deps.sync.applyLocal({
            op: "updated",
            key: updated.dedupeKey,
            source: updated.source,
            item: { title, body, priority, ts },
        });
    }

    /** Takes a held item out of the box; an item the box does not hold changes nothing. */
    removed(key: string, _cause: RemoveCause): boolean {
        const held = this.deps.store.get(key);
        if (!held) return false;
        this.deps.sync.applyLocal({ op: "removed", key, source: held.source });
        return true;
    }
}

/**
 * Where a change made through the box's sync path goes: the Core on the WebSocket, and the views that follow — settled
 * when the item is read or gone, so a notification about it comes down (lot S).
 */
export function syncEffects(
    broadcast: (event: AcediaEvent) => void,
    changes: Pick<ChangeFeed, "emit">,
): (change: InboxChange) => void {
    return (change) => {
        broadcast(InboxSync.toWire(change));
        changes.emit("box", change.key, change.op === "removed" || change.op === "read");
    };
}
