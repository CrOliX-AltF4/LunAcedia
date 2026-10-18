import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { hubOnBox } from "./recording_lifecycle.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

const baseEvent: AcediaEvent = {
    type: "github.push",
    ts: Date.now(),
    source: "github",
    title: "New push",
    priority: "normal",
    dedupeKey: "gh-push-1",
};

function makeConnector(events: AcediaEvent[]): IConnector {
    return {
        slug: "github",
        name: "MockConnector",
        poll: vi.fn().mockResolvedValue(events),
    };
}

describe("IngestionHub", () => {
    let hub: IngestionHub;

    afterEach(() => hub.stop());

    it("should dispatch event to registered handler on start", async () => {
        const connector = makeConnector([baseEvent]);
        hub = hubOnBox([connector]).hub;

        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(1);
        expect(received[0]!.dedupeKey).toBe("gh-push-1");
    });

    it("should not dispatch the same dedupeKey twice", async () => {
        const connector = makeConnector([baseEvent, baseEvent]);
        hub = hubOnBox([connector]).hub;

        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(1);
    });

    it("should dispatch different dedupeKeys separately", async () => {
        const e1 = { ...baseEvent, dedupeKey: "key-1" };
        const e2 = { ...baseEvent, dedupeKey: "key-2" };
        const connector = makeConnector([e1, e2]);
        hub = hubOnBox([connector]).hub;

        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(2);
    });

    it("should allow unsubscribing a handler", async () => {
        const connector = makeConnector([]);
        hub = hubOnBox([connector]).hub;

        const received: AcediaEvent[] = [];
        const unsub = hub.onEvent((e) => received.push(e));
        unsub();

        (connector.poll as ReturnType<typeof vi.fn>).mockResolvedValue([baseEvent]);
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(0);
    });

    it("should not throw if a connector poll rejects", async () => {
        const connector: IConnector = {
            slug: "github",
            name: "BrokenConnector",
            poll: vi.fn().mockRejectedValue(new Error("network error")),
        };
        hub = hubOnBox([connector]).hub;
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        // No throw — hub swallows connector errors
        expect(true).toBe(true);
    });

    it("should not start twice", async () => {
        const connector = makeConnector([baseEvent]);
        hub = hubOnBox([connector]).hub;

        hub.start();
        hub.start(); // second call is a no-op

        await new Promise((r) => setTimeout(r, 50));
        expect(vi.mocked(connector.poll)).toHaveBeenCalledTimes(1);
    });

    describe("getConnectorHealth()", () => {
        it("reports connected: false before any poll has run", () => {
            const connector = makeConnector([]);
            hub = hubOnBox([connector]).hub;

            expect(hub.getConnectorHealth()).toEqual([
                {
                    slug: "github",
                    name: "MockConnector",
                    connected: false,
                    lastSuccessAt: null,
                    lastError: null,
                },
            ]);
        });

        it("reports connected: true after a poll succeeds — not just because the connector is enabled", async () => {
            const connector = makeConnector([baseEvent]);
            hub = hubOnBox([connector]).hub;
            hub.start();

            await new Promise((r) => setTimeout(r, 50));

            const [health] = hub.getConnectorHealth();
            expect(health).toMatchObject({ connected: true, lastError: null });
            expect(health!.lastSuccessAt).not.toBeNull();
        });

        it("reports connected: false and surfaces lastError after a poll rejects", async () => {
            const connector: IConnector = {
                slug: "email",
                name: "BrokenConnector",
                poll: vi.fn().mockRejectedValue(new Error("invalid_grant")),
            };
            hub = hubOnBox([connector]).hub;
            hub.start();

            await new Promise((r) => setTimeout(r, 50));

            expect(hub.getConnectorHealth()).toEqual([
                {
                    slug: "email",
                    name: "BrokenConnector",
                    connected: false,
                    lastSuccessAt: null,
                    lastError: "invalid_grant",
                },
            ]);
        });

        describe("pollOne()", () => {
            it("returns { ok: true } and records success without waiting for the scheduled interval", async () => {
                const connector = makeConnector([baseEvent]);
                hub = hubOnBox([connector]).hub;

                const result = await hub.pollOne("github");

                expect(result).toEqual({ ok: true });
                expect(hub.getConnectorHealth()[0]!.lastSuccessAt).not.toBeNull();
            });

            it("returns { ok: false, error } when the connector's poll fails", async () => {
                const connector: IConnector = {
                    slug: "email",
                    name: "Broken",
                    poll: vi.fn().mockRejectedValue(new Error("invalid_grant")),
                };
                hub = hubOnBox([connector]).hub;

                const result = await hub.pollOne("email");

                expect(result).toEqual({ ok: false, error: "invalid_grant" });
            });

            it("returns { ok: false, error: 'Unknown connector' } for a slug not in the hub", async () => {
                hub = hubOnBox([makeConnector([])]).hub;

                const result = await hub.pollOne("nope");

                expect(result).toEqual({ ok: false, error: "Unknown connector" });
            });

            it("dispatches events found during the forced poll like any other poll", async () => {
                const connector = makeConnector([baseEvent]);
                hub = hubOnBox([connector]).hub;
                const received: AcediaEvent[] = [];
                hub.onEvent((e) => received.push(e));

                await hub.pollOne("github");

                expect(received).toHaveLength(1);
            });
        });

        it("keeps the last known success time when a later poll fails", async () => {
            const poll = vi
                .fn()
                .mockResolvedValueOnce([baseEvent])
                .mockRejectedValueOnce(new Error("token expired"));
            const connector: IConnector = { slug: "email", name: "Flaky", poll };
            hub = hubOnBox([connector]).hub;
            hub.start(); // initial sweep — succeeds

            await new Promise((r) => setTimeout(r, 50));
            const successAt = hub.getConnectorHealth()[0]!.lastSuccessAt;
            expect(successAt).not.toBeNull();

            await (hub as unknown as { pollAll(): Promise<void> }).pollAll(); // second poll — fails

            const health = hub.getConnectorHealth()[0]!;
            expect(health.connected).toBe(false);
            expect(health.lastError).toBe("token expired");
            expect(health.lastSuccessAt).toBe(successAt);
        });
    });

    it("takes neither a key the box holds nor one it remembers as gone for news after a restart", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-restart-"));
        const file = path.join(dir, "inbox_store.json");
        const before = new EventStore(1000, file);
        before.push({ ...baseEvent, dedupeKey: "held" });
        before.markGone("expired");
        await before.flush();

        const store = new EventStore(1000, file);
        await store.load();
        const listed = ["held", "expired", "new"].map((k) => ({ ...baseEvent, dedupeKey: k }));
        hub = hubOnBox([makeConnector(listed)], { store }).hub;
        const received: string[] = [];
        hub.onEvent((e) => received.push(e.dedupeKey));
        await hub.pollOne("github");
        expect(received).toEqual(["new"]);
        await fs.rm(dir, { recursive: true, force: true });
    });
});

// An item removed because its source object is gone comes back if the object does (a mail restored from the trash, a
// GitHub thread with new activity); an expired one, still in its feed, does not.
describe("IngestionHub — what left the box", () => {
    const mail = { ...baseEvent, source: "email" as const, dedupeKey: "email-a" };
    const rss = { ...baseEvent, source: "rss" as const, dedupeKey: "rss-a" };

    it("collects again an item removed from the box, never an expired one", async () => {
        const connector = { slug: "email" as const, name: "Gmail", poll: async () => [mail, rss] };
        const { hub, life } = hubOnBox([connector]);
        const received: string[] = [];
        hub.onEvent((e) => received.push(e.dedupeKey));
        await hub.pollOne("email");
        life.changed("email-a", "removed", "gesture");
        life.changed("rss-a", "removed", "expired");
        await hub.pollOne("email");
        expect(received).toEqual(["email-a", "rss-a", "email-a"]);
    });
});

// Live NAS check 2026-09-28: a fresh box — first run, storage moved — makes the first sweep the backlog, not news:
// it fills the box without ringing the phone or the Core.
describe("IngestionHub — the first sweep of a fresh box is backlog", () => {
    let hub: IngestionHub;
    let dir: string;
    let store: EventStore;

    afterEach(async () => {
        hub.stop();
        // The box writes in the background: wait for its last write, or the folder is removed under it (ENOTEMPTY).
        await store.flush();
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function boxAt(existing: boolean): Promise<EventStore> {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-fresh-"));
        const file = path.join(dir, "inbox_store.json");
        if (existing)
            await fs.writeFile(file, JSON.stringify({ version: 2, items: [], gone: {} }), "utf-8");
        store = new EventStore(1000, file);
        await store.load();
        return store;
    }

    it("flags the first sweep's events as backlog, and later ones as new", async () => {
        const poll = vi
            .fn()
            .mockResolvedValueOnce([{ ...baseEvent, dedupeKey: "backlog-1" }])
            .mockResolvedValue([{ ...baseEvent, dedupeKey: "fresh-1" }]);
        hub = hubOnBox([{ slug: "github", name: "Mock", poll }], { store: await boxAt(false) }).hub;

        const received: Array<{ key: string; backlog: boolean }> = [];
        hub.onEvent((e, meta) =>
            received.push({ key: e.dedupeKey, backlog: meta?.backlog === true }),
        );
        hub.start();
        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000, interval: 20 });
        await hub.pollOne("github");

        expect(received).toEqual([
            { key: "backlog-1", backlog: true },
            { key: "fresh-1", backlog: false },
        ]);
    });

    it("stores a backlog event without announcing it (C7), and is not quiet when the box existed", async () => {
        const listed = [
            { ...baseEvent, dedupeKey: "old", meta: { backlog: true } },
            { ...baseEvent, dedupeKey: "new" },
        ];
        hub = hubOnBox([makeConnector(listed)], { store: await boxAt(true) }).hub;

        const received: Array<{ key: string; backlog: boolean }> = [];
        hub.onEvent((e, meta) =>
            received.push({ key: e.dedupeKey, backlog: meta?.backlog === true }),
        );
        hub.start();
        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 2000, interval: 20 });
        expect(received).toEqual([
            { key: "old", backlog: true },
            { key: "new", backlog: false },
        ]);
    });
});

describe("IngestionHub — refresh", () => {
    it("hands an item the box holds, collected again, to the refresh handlers — never as news", async () => {
        const poll = vi
            .fn()
            .mockResolvedValueOnce([{ ...baseEvent, dedupeKey: "cal-1", title: "v1" }])
            .mockResolvedValue([
                { ...baseEvent, dedupeKey: "cal-1", title: "v2" },
                { ...baseEvent, dedupeKey: "cal-2" },
            ]);
        const { hub } = hubOnBox([{ slug: "calendar", name: "Mock", poll }]);
        const news: string[] = [];
        const refreshed: string[] = [];
        hub.onEvent((e) => news.push(e.dedupeKey));
        hub.onRefresh((e) => refreshed.push(`${e.dedupeKey}:${e.title}`));

        await hub.pollOne("calendar");
        await hub.pollOne("calendar");

        expect(news).toEqual(["cal-1", "cal-2"]);
        expect(refreshed).toEqual(["cal-1:v2"]);
    });
});

describe("IngestionHub.isReady", () => {
    let hub: IngestionHub;
    afterEach(() => hub.stop());

    it("is false until the initial sweep after start() has finished", async () => {
        let release!: (events: AcediaEvent[]) => void;
        const poll = vi.fn().mockReturnValueOnce(
            new Promise<AcediaEvent[]>((r) => {
                release = r;
            }),
        );
        hub = hubOnBox([{ slug: "email", name: "Mock", poll }]).hub;
        expect(hub.isReady()).toBe(false);
        hub.start();
        expect(hub.isReady()).toBe(false);
        release([]);
        await vi.waitFor(() => expect(hub.isReady()).toBe(true), { timeout: 2000, interval: 10 });
    });
});
