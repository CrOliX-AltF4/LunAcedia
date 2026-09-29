import { describe, it, expect, vi } from "vitest";
import { InboxSync, INBOX_CHANGED, type InboxChange } from "../../source/hub/inbox_sync.js";
import { EventStore } from "../../source/store/event_store.js";
import type { IConnector, SourceState } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// ADR-018 R8 — an item never outlives its linked object, wherever the change happened.

function item(key: string, source: AcediaEvent["source"] = "email", read = false): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source,
        title: key,
        priority: "normal",
        dedupeKey: key,
        read,
    };
}

function connector(
    slug: "email" | "github",
    state: Record<string, SourceState> | null,
): IConnector & { sourceState: ReturnType<typeof vi.fn> } {
    return {
        slug,
        name: slug,
        poll: async () => [],
        sourceState: vi.fn(async () => (state ? new Map(Object.entries(state)) : null)),
    };
}

function setup(events: AcediaEvent[], connectors: IConnector[]) {
    const store = new EventStore();
    for (const e of events) store.push(e);
    const emitted: InboxChange[] = [];
    const forgotten: string[] = [];
    const sync = new InboxSync({
        connectors,
        store,
        emit: (c) => emitted.push(c),
        forget: (k) => forgotten.push(k),
    });
    return { store, emitted, forgotten, sync };
}

describe("InboxSync.reconcile", () => {
    it("removes what is gone at the source, forgets it for dedup, and tells the Core", async () => {
        const { store, emitted, forgotten, sync } = setup(
            [item("email-a"), item("email-b")],
            [connector("email", { "email-a": "gone", "email-b": "unread" })],
        );
        await sync.reconcile();
        expect(store.get("email-a")).toBeUndefined();
        expect(store.get("email-b")).toBeDefined();
        expect(forgotten).toEqual(["email-a"]);
        expect(emitted).toEqual([{ op: "removed", key: "email-a", source: "email" }]);
    });

    it("reports a read state changed at the source, both ways", async () => {
        const { store, emitted, sync } = setup(
            [item("email-a", "email", false), item("email-b", "email", true)],
            [connector("email", { "email-a": "read", "email-b": "unread" })],
        );
        await sync.reconcile();
        expect(store.get("email-a")!.read).toBe(true);
        expect(store.get("email-b")!.read).toBe(false);
        expect(emitted).toHaveLength(2);
        expect(emitted).toEqual(
            expect.arrayContaining([
                { op: "read", key: "email-a", source: "email" },
                { op: "unread", key: "email-b", source: "email" },
            ]),
        );
    });

    it("stays silent when nothing changed", async () => {
        const { emitted, sync } = setup(
            [item("email-a", "email", true)],
            [connector("email", { "email-a": "read" })],
        );
        await sync.reconcile();
        expect(emitted).toEqual([]);
    });

    it("hands each connector only the items of its own source", async () => {
        const gmail = connector("email", {});
        const github = connector("github", {});
        const { sync } = setup([item("email-a"), item("gh-1", "github")], [gmail, github]);
        await sync.reconcile();
        expect(gmail.sourceState.mock.calls[0]![0].map((e: AcediaEvent) => e.dedupeKey)).toEqual([
            "email-a",
        ]);
        expect(github.sourceState.mock.calls[0]![0].map((e: AcediaEvent) => e.dedupeKey)).toEqual([
            "gh-1",
        ]);
    });

    it("changes nothing when a source cannot be asked", async () => {
        const { store, emitted, sync } = setup([item("email-a")], [connector("email", null)]);
        await sync.reconcile();
        expect(store.get("email-a")).toBeDefined();
        expect(emitted).toEqual([]);
    });

    it("keeps an item its connector could not judge", async () => {
        const { store, sync } = setup([item("email-a")], [connector("email", {})]);
        await sync.reconcile();
        expect(store.get("email-a")).toBeDefined();
    });

    it("survives a connector that throws", async () => {
        const broken: IConnector = {
            slug: "email",
            name: "email",
            poll: async () => [],
            sourceState: async () => {
                throw new Error("boom");
            },
        };
        const { store, sync } = setup([item("email-a")], [broken]);
        await expect(sync.reconcile()).resolves.toBeUndefined();
        expect(store.get("email-a")).toBeDefined();
    });

    it("never runs two passes at once", async () => {
        let release!: () => void;
        const slow: IConnector = {
            slug: "email",
            name: "email",
            poll: async () => [],
            sourceState: vi.fn(
                () => new Promise<Map<string, SourceState>>((r) => (release = () => r(new Map()))),
            ),
        };
        const { sync } = setup([item("email-a")], [slow]);
        const first = sync.reconcile();
        await sync.reconcile();
        release();
        await first;
        expect(slow.sourceState).toHaveBeenCalledTimes(1);
    });
});

describe("InboxSync.applyLocal — a gesture made through LunAcedia", () => {
    it("applies it to the store and tells the Core the same way", () => {
        const { store, emitted, forgotten, sync } = setup([item("email-a"), item("email-b")], []);
        sync.applyLocal({ op: "removed", key: "email-a", source: "email" });
        sync.applyLocal({ op: "read", key: "email-b", source: "email" });
        expect(store.get("email-a")).toBeUndefined();
        expect(forgotten).toEqual(["email-a"]);
        expect(store.get("email-b")!.read).toBe(true);
        expect(emitted).toHaveLength(2);
    });
});

describe("the wire message", () => {
    it("is an AcediaEvent of its own type, carrying the change, never stored as an item", () => {
        const msg = InboxSync.toWire({ op: "removed", key: "email-a", source: "email" }, 1234);
        expect(msg).toEqual({
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

describe("InboxSync — updated (ADR-019 L3)", () => {
    it("sends the fresh content on the wire and touches nothing in the store", () => {
        const { store, emitted, forgotten, sync } = setup([item("cal-1", "calendar")], []);
        sync.applyLocal({
            op: "updated",
            key: "cal-1",
            source: "calendar",
            item: { title: "moved", priority: "normal", ts: 2, body: undefined },
        });
        expect(store.get("cal-1")?.read).toBe(false);
        expect(forgotten).toEqual([]);
        expect(emitted).toHaveLength(1);
        const wire = InboxSync.toWire(emitted[0]!, 9);
        expect(wire.type).toBe(INBOX_CHANGED);
        expect(wire.meta).toMatchObject({ op: "updated", key: "cal-1", item: { title: "moved" } });
    });
});

describe("InboxSync — informational items expire (ADR-019 L7)", () => {
    it("removes RSS and Home Assistant items past their lifetime, keeps them in dedup, tells the Core", async () => {
        const store = new EventStore();
        const old = { ...item("rss-old", "rss"), ts: 1_000 };
        const recent = { ...item("ha-recent", "ha"), ts: 9_000 };
        const mail = { ...item("email-old", "email"), ts: 1_000 };
        for (const e of [old, recent, mail]) store.push(e);
        const emitted: InboxChange[] = [];
        const forgotten: string[] = [];
        const sync = new InboxSync({
            connectors: [],
            store,
            emit: (c) => emitted.push(c),
            forget: (k) => forgotten.push(k),
            infoTtlMs: 5_000,
            now: () => 10_000,
        });
        await sync.reconcile();
        expect(store.has("rss-old")).toBe(false);
        expect(store.has("ha-recent")).toBe(true);
        expect(store.has("email-old")).toBe(true);
        expect(emitted).toEqual([{ op: "removed", key: "rss-old", source: "rss" }]);
        expect(forgotten).toEqual([]);
    });
});
