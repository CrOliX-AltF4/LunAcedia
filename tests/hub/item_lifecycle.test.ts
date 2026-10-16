import { describe, it, expect } from "vitest";
import { ItemLifecycle, syncEffects } from "../../source/hub/item_lifecycle.js";
import { InboxSync, INBOX_CHANGED } from "../../source/hub/inbox_sync.js";
import { ChangeFeed, type Change } from "../../source/changes/change_feed.js";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// What each transition does, seen from outside: the box, the views that follow, the Core, the phone. These tests hold
// the box's behaviour while the paths that write it are moved behind this module (characterization).

function item(key: string, extra: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: key,
        priority: "normal",
        dedupeKey: key,
        read: false,
        ...extra,
    };
}

function setup(held: AcediaEvent[] = []) {
    const store = new EventStore();
    for (const e of held) store.push(e);
    const toCore: AcediaEvent[] = [];
    const rung: AcediaEvent[] = [];
    const forgotten: string[] = [];
    const views: Change[] = [];
    const changes = new ChangeFeed();
    changes.subscribe((c) => views.push(c));
    const sync = new InboxSync({
        connectors: [],
        store,
        emit: syncEffects((e) => toCore.push(e), changes),
        forget: (k) => forgotten.push(k),
    });
    const life = new ItemLifecycle({
        store,
        sync,
        changes,
        broadcast: (e) => toCore.push(e),
        push: (e) => rung.push(e),
    });
    return { store, toCore, rung, forgotten, views, life };
}

describe("ItemLifecycle — collected", () => {
    it("a new unread item: in the box, the views follow, the Core is told, the phone rings", () => {
        const { store, toCore, rung, views, life } = setup();
        life.collected(item("m1"), "new");
        expect(store.has("m1")).toBe(true);
        expect(views.map((v) => [v.scope, v.key, !!v.settled])).toEqual([["box", "m1", false]]);
        expect(toCore.map((e) => e.dedupeKey)).toEqual(["m1"]);
        expect(rung.map((e) => e.dedupeKey)).toEqual(["m1"]);
    });

    it("a new item already read: the Core is told, the phone stays silent", () => {
        const { toCore, rung, life } = setup();
        life.collected(item("m1", { read: true }), "new");
        expect(toCore).toHaveLength(1);
        expect(rung).toHaveLength(0);
    });

    it("a recovered item is back in the box only — news to no one", () => {
        const { store, toCore, rung, views, life } = setup();
        life.collected(item("m1"), "recovered");
        expect(store.has("m1")).toBe(true);
        expect(views).toHaveLength(1);
        expect(toCore).toHaveLength(0);
        expect(rung).toHaveLength(0);
    });

    it("a reminder goes where a new item goes: box, views, Core, phone", () => {
        const { store, toCore, rung, life } = setup();
        life.collected(item("rem-1", { type: "planning.reminder", source: "calendar" }), "reminder");
        expect(store.has("rem-1")).toBe(true);
        expect(toCore).toHaveLength(1);
        expect(rung).toHaveLength(1);
    });
});

describe("ItemLifecycle — refreshed", () => {
    it("changed content: the box holds it, the Core gets an update by key — never the item as news", () => {
        const { store, toCore, rung, life } = setup([item("m1")]);
        life.refreshed(item("m1", { title: "moved" }));
        expect(store.get("m1")?.title).toBe("moved");
        expect(toCore).toHaveLength(1);
        expect(toCore[0]).toMatchObject({ type: INBOX_CHANGED, meta: { op: "updated", key: "m1" } });
        expect(rung).toHaveLength(0);
    });

    it("tells no one when nothing changed, when the item is not held, or when it is backlog", () => {
        const { toCore, life } = setup([item("m1"), item("old", { meta: { backlog: true } })]);
        life.refreshed(item("m1"));
        life.refreshed(item("unknown", { title: "x" }));
        life.refreshed(item("old", { title: "x", meta: { backlog: true } }));
        expect(toCore).toHaveLength(0);
    });
});

describe("ItemLifecycle — removed", () => {
    it("a held item leaves the box: dedup forgets it, the Core is told, the views see it settled", () => {
        const { store, toCore, forgotten, views, life } = setup([item("rem-1", { source: "tasks" })]);
        expect(life.removed("rem-1", "settled")).toBe(true);
        expect(store.has("rem-1")).toBe(false);
        expect(forgotten).toEqual(["rem-1"]);
        expect(toCore[0]).toMatchObject({ type: INBOX_CHANGED, source: "tasks", meta: { op: "removed", key: "rem-1" } });
        expect(views.at(-1)).toMatchObject({ scope: "box", key: "rem-1", settled: true });
    });

    it("an item the box does not hold changes nothing and tells no one", () => {
        const { toCore, views, life } = setup();
        expect(life.removed("gone", "snoozed")).toBe(false);
        expect(toCore).toHaveLength(0);
        expect(views).toHaveLength(0);
    });
});
