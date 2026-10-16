import { ItemLifecycle, INBOX_CHANGED, type InboxChange } from "../../source/hub/item_lifecycle.js";
import { ChangeFeed, type Change } from "../../source/changes/change_feed.js";
import type { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

/**
 * A real ItemLifecycle whose effects are recorded: the changes told to the Core (as `{op, key, source}`), the new
 * items sent to it, the phone rung, the keys forgotten by dedup, the views told.
 */
export function recordingLifecycle(store: EventStore, onForget?: (key: string) => void) {
    const emitted: InboxChange[] = [];
    const sent: AcediaEvent[] = [];
    const rung: AcediaEvent[] = [];
    const forgotten: string[] = [];
    const views: Change[] = [];
    const changes = new ChangeFeed();
    changes.subscribe((c) => views.push(c));
    const life = new ItemLifecycle({
        store,
        forget: (k) => {
            forgotten.push(k);
            onForget?.(k);
        },
        changes,
        broadcast: (e) => {
            if (e.type !== INBOX_CHANGED) return void sent.push(e);
            const m = e.meta as { op: InboxChange["op"]; key: string; item?: InboxChange["item"] };
            emitted.push({
                op: m.op,
                key: m.key,
                source: e.source,
                ...(m.item && { item: m.item }),
            });
        },
        push: (e) => rung.push(e),
    });
    return { life, emitted, sent, rung, forgotten, views };
}
