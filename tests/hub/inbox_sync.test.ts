import { describe, it, expect, vi } from "vitest";
import { InboxSync } from "../../source/hub/inbox_sync.js";
import { recordingLifecycle } from "./recording_lifecycle.js";
import { EventStore } from "../../source/store/event_store.js";
import type { IConnector, SourceState } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// An item never outlives its linked object: what a source says of the items held becomes their transition.

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
    const { life, emitted } = recordingLifecycle(store);
    const sync = new InboxSync({ connectors, store, life });
    return { store, emitted, sync };
}

describe("InboxSync.reconcile", () => {
    it("removes what is gone at the source, forgets it for dedup, and tells the Core", async () => {
        const { store, emitted, sync } = setup(
            [item("email-a"), item("email-b")],
            [connector("email", { "email-a": "gone", "email-b": "unread" })],
        );
        await sync.reconcile();
        expect(store.get("email-a")).toBeUndefined();
        expect(store.get("email-b")).toBeDefined();
        expect(store.knows("email-a")).toBe(false); // may come back if its object does
        expect(emitted).toEqual([{ op: "removed", key: "email-a", source: "email" }]);
    });

    // Lot AT4: a reminder's life is the reminder engine's — the calendar's window would call it gone.
    it("never asks a source about a reminder", async () => {
        const reminder: AcediaEvent = {
            ...item("rem-event_soon-primary/ev1-1", "calendar"),
            type: "planning.reminder",
        };
        const calendar: IConnector & { sourceState: ReturnType<typeof vi.fn> } = {
            slug: "calendar",
            name: "Calendar",
            poll: async () => [],
            sourceState: vi.fn(
                async () => new Map<string, SourceState>([[reminder.dedupeKey, "gone"]]),
            ),
        };
        const { store, sync } = setup([reminder], [calendar]);
        await sync.reconcile();
        expect(calendar.sourceState).not.toHaveBeenCalled();
        expect(store.get(reminder.dedupeKey)).toBeDefined();
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

describe("InboxSync — informational items expire", () => {
    it("removes RSS and Home Assistant items past their lifetime, remembers them as gone, tells the Core", async () => {
        const store = new EventStore();
        const old = { ...item("rss-old", "rss"), ts: 1_000 };
        const recent = { ...item("ha-recent", "ha"), ts: 9_000 };
        const mail = { ...item("email-old", "email"), ts: 1_000 };
        for (const e of [old, recent, mail]) store.push(e);
        const { life, emitted } = recordingLifecycle(store);
        const sync = new InboxSync({
            connectors: [],
            store,
            life,
            infoTtlMs: 5_000,
            now: () => 10_000,
        });
        await sync.reconcile();
        expect(store.has("rss-old")).toBe(false);
        expect(store.has("ha-recent")).toBe(true);
        expect(store.has("email-old")).toBe(true);
        expect(emitted).toEqual([{ op: "removed", key: "rss-old", source: "rss" }]);
        expect(store.isGone("rss-old")).toBe(true); // still in its feed: not news again
    });
});
