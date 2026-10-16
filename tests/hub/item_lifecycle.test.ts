import { describe, it, expect } from "vitest";
import { toWire, INBOX_CHANGED } from "../../source/hub/item_lifecycle.js";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";
import { recordingLifecycle } from "./recording_lifecycle.js";

// What each transition does, seen from outside: the box, dedup, the views that follow, the Core, the phone.

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
    return { store, ...recordingLifecycle(store) };
}

describe("ItemLifecycle — collected", () => {
    it("a new unread item: in the box, the views follow, the Core is told, the phone rings", () => {
        const { store, sent, rung, views, life } = setup();
        life.collected(item("m1"), "new");
        expect(store.has("m1")).toBe(true);
        expect(views.map((v) => [v.scope, v.key, !!v.settled])).toEqual([["box", "m1", false]]);
        expect(sent.map((e) => e.dedupeKey)).toEqual(["m1"]);
        expect(rung.map((e) => e.dedupeKey)).toEqual(["m1"]);
    });

    it("a new item already read: the Core is told, the phone stays silent", () => {
        const { sent, rung, life } = setup();
        life.collected(item("m1", { read: true }), "new");
        expect(sent).toHaveLength(1);
        expect(rung).toHaveLength(0);
    });

    it("a recovered item is back in the box only — news to no one", () => {
        const { store, sent, rung, views, life } = setup();
        life.collected(item("m1"), "recovered");
        expect(store.has("m1")).toBe(true);
        expect(views).toHaveLength(1);
        expect(sent).toHaveLength(0);
        expect(rung).toHaveLength(0);
    });

    it("a reminder goes where a new item goes: box, views, Core, phone", () => {
        const { store, sent, rung, life } = setup();
        life.collected(
            item("rem-1", { type: "planning.reminder", source: "calendar" }),
            "reminder",
        );
        expect(store.has("rem-1")).toBe(true);
        expect(sent).toHaveLength(1);
        expect(rung).toHaveLength(1);
    });
});

describe("ItemLifecycle — refreshed", () => {
    it("changed content: the box holds it, the Core gets an update by key — never the item as news", () => {
        const { store, emitted, sent, rung, forgotten, life } = setup([item("m1")]);
        life.refreshed(item("m1", { title: "moved" }));
        expect(store.get("m1")).toMatchObject({ title: "moved", read: false });
        expect(emitted).toEqual([
            {
                op: "updated",
                key: "m1",
                source: "email",
                item: expect.objectContaining({ title: "moved" }),
            },
        ]);
        expect(sent).toHaveLength(0);
        expect(rung).toHaveLength(0);
        expect(forgotten).toHaveLength(0);
    });

    it("tells no one when nothing changed, when the item is not held, or when it is backlog", () => {
        const { emitted, life } = setup([item("m1"), item("old", { meta: { backlog: true } })]);
        life.refreshed(item("m1"));
        life.refreshed(item("unknown", { title: "x" }));
        life.refreshed(item("old", { title: "x", meta: { backlog: true } }));
        expect(emitted).toHaveLength(0);
    });
});

describe("ItemLifecycle — changed", () => {
    it("read and unread: the box follows, the Core is told, the views see a read item settled", () => {
        const { store, emitted, views, forgotten, life } = setup([
            item("a"),
            item("b", { read: true }),
        ]);
        life.changed("a", "read", "gesture");
        life.changed("b", "unread", "source");
        expect(store.get("a")!.read).toBe(true);
        expect(store.get("b")!.read).toBe(false);
        expect(emitted).toEqual([
            { op: "read", key: "a", source: "email" },
            { op: "unread", key: "b", source: "email" },
        ]);
        expect(views.map((v) => [v.key, !!v.settled])).toEqual([
            ["a", true],
            ["b", false],
        ]);
        expect(forgotten).toHaveLength(0);
    });

    it("removed: leaves the box and dedup forgets it, so it comes back if its object does", () => {
        const { store, emitted, forgotten, views, life } = setup([
            item("rem-1", { source: "tasks" }),
        ]);
        expect(life.changed("rem-1", "removed", "settled")).toBe(true);
        expect(store.has("rem-1")).toBe(false);
        expect(forgotten).toEqual(["rem-1"]);
        expect(emitted).toEqual([{ op: "removed", key: "rem-1", source: "tasks" }]);
        expect(views.at(-1)).toMatchObject({ scope: "box", key: "rem-1", settled: true });
    });

    it("expired: leaves the box but stays in dedup — still in its feed, it must not come back as news", () => {
        const { store, forgotten, emitted, life } = setup([item("rss-1", { source: "rss" })]);
        life.changed("rss-1", "removed", "expired");
        expect(store.has("rss-1")).toBe(false);
        expect(forgotten).toHaveLength(0);
        expect(emitted).toHaveLength(1);
    });

    it("an item the box does not hold changes nothing and tells no one", () => {
        const { emitted, views, life } = setup();
        expect(life.changed("gone", "removed", "action")).toBe(false);
        expect(emitted).toHaveLength(0);
        expect(views).toHaveLength(0);
    });
});

// The Core reads this envelope (contract): its own type, never stored as an item.
describe("the wire message", () => {
    it("is an AcediaEvent of its own type, carrying the change", () => {
        expect(toWire({ op: "removed", key: "email-a", source: "email" }, 1234)).toEqual({
            type: INBOX_CHANGED,
            ts: 1234,
            source: "email",
            title: "",
            priority: "info",
            dedupeKey: "sync-removed-email-a-1234",
            meta: { op: "removed", key: "email-a" },
        });
    });
});
