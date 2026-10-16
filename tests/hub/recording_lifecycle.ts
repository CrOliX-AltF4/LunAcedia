import { ItemLifecycle, INBOX_CHANGED, type InboxChange } from "../../source/hub/item_lifecycle.js";
import { ChangeFeed, type Change } from "../../source/changes/change_feed.js";
import { EventStore } from "../../source/store/event_store.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import type { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent, AcediaEventPriority } from "../../source/types/acedia_event.js";
import { rings } from "../../source/push/notify_policy.js";

type RuleActor = ConstructorParameters<typeof IngestionHub>[3];

/**
 * A real ItemLifecycle whose effects are recorded: the changes told to the Core (as `{op, key, source}`), the new
 * items sent to it, the phone rung, the views told.
 */
export function recordingLifecycle(
    store: EventStore,
    ringing: AcediaEventPriority[] = ["urgent", "normal", "info"],
) {
    const emitted: InboxChange[] = [];
    const sent: AcediaEvent[] = [];
    const rung: AcediaEvent[] = [];
    const views: Change[] = [];
    const changes = new ChangeFeed();
    changes.subscribe((c) => views.push(c));
    const life = new ItemLifecycle({
        store,
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
        // Every priority rings here, unless a test says otherwise: what matters is the read state and the cause.
        rings: (e) => rings(e, ringing),
        push: (e) => rung.push(e),
    });
    return { life, emitted, sent, rung, views };
}

/**
 * A hub collecting into a box, wired as in production: what it dispatches is stored through the lifecycle, so a
 * second sighting is known. Pass the store a server under test reads.
 */
export function hubOnBox(
    connectors: IConnector[],
    opts: { store?: EventStore; guard?: GuardPipeline; ruleActor?: RuleActor } = {},
) {
    const store = opts.store ?? new EventStore();
    const life = ItemLifecycle.local(store);
    const hub = new IngestionHub(connectors, life, opts.guard, opts.ruleActor);
    hub.onEvent((e, meta) => life.collected(e, meta?.backlog ? "backlog" : "new"));
    return { hub, store, life };
}
