import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
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
        hub = new IngestionHub([connector]);

        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(1);
        expect(received[0]!.dedupeKey).toBe("gh-push-1");
    });

    it("should not dispatch the same dedupeKey twice", async () => {
        const connector = makeConnector([baseEvent, baseEvent]);
        hub = new IngestionHub([connector]);

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
        hub = new IngestionHub([connector]);

        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(2);
    });

    it("should allow unsubscribing a handler", async () => {
        const connector = makeConnector([]);
        hub = new IngestionHub([connector]);

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
        hub = new IngestionHub([connector]);
        hub.start();

        await new Promise((r) => setTimeout(r, 50));
        // No throw — hub swallows connector errors
        expect(true).toBe(true);
    });

    it("should not start twice", async () => {
        const connector = makeConnector([baseEvent]);
        hub = new IngestionHub([connector]);

        hub.start();
        hub.start(); // second call is a no-op

        await new Promise((r) => setTimeout(r, 50));
        expect(vi.mocked(connector.poll)).toHaveBeenCalledTimes(1);
    });

    describe("getConnectorHealth()", () => {
        it("reports connected: false before any poll has run", () => {
            const connector = makeConnector([]);
            hub = new IngestionHub([connector]);

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
            hub = new IngestionHub([connector]);
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
            hub = new IngestionHub([connector]);
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
                hub = new IngestionHub([connector]);

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
                hub = new IngestionHub([connector]);

                const result = await hub.pollOne("email");

                expect(result).toEqual({ ok: false, error: "invalid_grant" });
            });

            it("returns { ok: false, error: 'Unknown connector' } for a slug not in the hub", async () => {
                hub = new IngestionHub([makeConnector([])]);

                const result = await hub.pollOne("nope");

                expect(result).toEqual({ ok: false, error: "Unknown connector" });
            });

            it("dispatches events found during the forced poll like any other poll", async () => {
                const connector = makeConnector([baseEvent]);
                hub = new IngestionHub([connector]);
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
            hub = new IngestionHub([connector]);
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

    describe("dedup persistence", () => {
        let seenPath: string;

        afterEach(async () => {
            await fs.rm(seenPath, { force: true });
        });

        it("persists a seen dedupeKey to disk on dispatch", async () => {
            seenPath = path.join(
                os.tmpdir(),
                `dedup-seen-${Math.random().toString(36).slice(2)}.json`,
            );
            const connector = makeConnector([baseEvent]);
            hub = new IngestionHub([connector], seenPath);
            hub.start();

            // saveSeen() is fire-and-forget: wait for the write itself, not a fixed delay (slow CI runners).
            await vi.waitFor(
                async () => {
                    const raw = await fs.readFile(seenPath, "utf-8");
                    expect(JSON.parse(raw)).toEqual({ [baseEvent.dedupeKey]: baseEvent.ts });
                },
                { timeout: 2000, interval: 20 },
            );
        });

        it("load() restores dedup state so a previously-seen event isn't redispatched after restart", async () => {
            seenPath = path.join(
                os.tmpdir(),
                `dedup-seen-${Math.random().toString(36).slice(2)}.json`,
            );
            await fs.writeFile(
                seenPath,
                JSON.stringify({ [baseEvent.dedupeKey]: baseEvent.ts }),
                "utf-8",
            );

            const connector = makeConnector([baseEvent]);
            hub = new IngestionHub([connector], seenPath);
            await hub.load();

            const received: AcediaEvent[] = [];
            hub.onEvent((e) => received.push(e));
            hub.start();

            await new Promise((r) => setTimeout(r, 50));
            expect(received).toHaveLength(0);
        });

        it("load() is a no-op when the file is absent (first run)", async () => {
            seenPath = path.join(
                os.tmpdir(),
                `dedup-seen-missing-${Math.random().toString(36).slice(2)}.json`,
            );
            const connector = makeConnector([baseEvent]);
            hub = new IngestionHub([connector], seenPath);

            await expect(hub.load()).resolves.toBeUndefined();

            const received: AcediaEvent[] = [];
            hub.onEvent((e) => received.push(e));
            hub.start();

            await new Promise((r) => setTimeout(r, 50));
            expect(received).toHaveLength(1);
        });
    });
});

// ADR-018 R8 — an item removed because its source object is gone must come back if the object does
// (a mail restored from the trash, a GitHub thread with new activity).
describe("IngestionHub.forget", () => {
    it("lets a forgotten key be dispatched again", async () => {
        const e = {
            type: "email.received" as const,
            ts: Date.now(),
            source: "email" as const,
            title: "t",
            priority: "normal" as const,
            dedupeKey: "email-a",
        };
        const polls = [[e], [e]];
        const connector = {
            slug: "email" as const,
            name: "Gmail",
            poll: async () => polls.shift() ?? [],
        };
        const hub = new IngestionHub(
            [connector],
            path.join(os.tmpdir(), `seen-${Date.now()}-${Math.random()}.json`),
        );
        const seen: string[] = [];
        hub.onEvent((ev) => seen.push(ev.dedupeKey));
        await hub.pollOne("email");
        hub.forget("email-a");
        await hub.pollOne("email");
        expect(seen).toEqual(["email-a", "email-a"]);
    });
});

// Live NAS check 2026-09-28: after a restart the box was empty while dedup still said "seen", so the
// mail already in the inbox never came back. recoverMissing() re-collects what the box lost — quietly:
// it is not new, the Core already holds it and the phone must not ring for it.
describe("IngestionHub.recoverMissing — what the box lost comes back, quietly", () => {
    let hub: IngestionHub;
    let seenPath: string;

    afterEach(async () => {
        hub.stop();
        await fs.rm(seenPath, { force: true });
    });

    const mail = (id: string): AcediaEvent => ({
        ...baseEvent,
        source: "email",
        dedupeKey: `email-${id}`,
    });

    it("forgets only the seen keys the box no longer holds, and marks their return as recovered", async () => {
        seenPath = path.join(os.tmpdir(), `dedup-seen-${Math.random().toString(36).slice(2)}.json`);
        const now = Date.now();
        await fs.writeFile(
            seenPath,
            JSON.stringify({ "email-kept": now, "email-lost": now }),
            "utf-8",
        );

        const connector = makeConnector([mail("kept"), mail("lost"), mail("new")]);
        hub = new IngestionHub([connector], seenPath);
        await hub.load();
        expect(hub.recoverMissing((key) => key === "email-kept")).toBe(1);

        const received: Array<{ key: string; recovered: boolean }> = [];
        hub.onEvent((e, meta) =>
            received.push({ key: e.dedupeKey, recovered: meta?.recovered === true }),
        );
        hub.start();

        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 2000, interval: 20 });
        expect(received).toEqual([
            { key: "email-lost", recovered: true },
            { key: "email-new", recovered: false },
        ]);
    });

    it("recovers a key once: its next sighting is ordinary dedup again", async () => {
        seenPath = path.join(os.tmpdir(), `dedup-seen-${Math.random().toString(36).slice(2)}.json`);
        await fs.writeFile(seenPath, JSON.stringify({ "email-lost": Date.now() }), "utf-8");

        const connector = makeConnector([mail("lost")]);
        hub = new IngestionHub([connector], seenPath);
        await hub.load();
        hub.recoverMissing(() => false);

        const received: string[] = [];
        hub.onEvent((e) => received.push(e.dedupeKey));
        await hub.pollOne("github");
        await hub.pollOne("github");
        expect(received).toEqual(["email-lost"]);
    });
});

// Live NAS check 2026-09-28: STORAGE_DIR was never set in the image, so dedup lived in the container and
// died with it; moving it to the volume means one start with no dedup file. That first sweep — like a
// fresh install's — is the backlog, not news: it fills the box without ringing the phone or the Core.
describe("IngestionHub — the first sweep without a dedup file is quiet", () => {
    let hub: IngestionHub;
    let seenPath: string;

    afterEach(async () => {
        hub.stop();
        await fs.rm(seenPath, { force: true });
    });

    it("flags the first sweep's events as recovered, and later ones as new", async () => {
        seenPath = path.join(os.tmpdir(), `dedup-seen-${Math.random().toString(36).slice(2)}.json`);
        const poll = vi
            .fn()
            .mockResolvedValueOnce([{ ...baseEvent, dedupeKey: "backlog-1" }])
            .mockResolvedValue([{ ...baseEvent, dedupeKey: "fresh-1" }]);
        hub = new IngestionHub([{ slug: "github", name: "Mock", poll }], seenPath);
        await hub.load();

        const received: Array<{ key: string; recovered: boolean }> = [];
        hub.onEvent((e, meta) =>
            received.push({ key: e.dedupeKey, recovered: meta?.recovered === true }),
        );
        hub.start();
        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000, interval: 20 });
        await hub.pollOne("github");

        expect(received).toEqual([
            { key: "backlog-1", recovered: true },
            { key: "fresh-1", recovered: false },
        ]);
    });

    it("stores a backlog event without announcing it (C7)", async () => {
        seenPath = path.join(os.tmpdir(), `dedup-seen-${Math.random().toString(36).slice(2)}.json`);
        await fs.writeFile(seenPath, "{}", "utf-8");
        hub = new IngestionHub(
            [
                makeConnector([
                    { ...baseEvent, dedupeKey: "old", meta: { backlog: true } },
                    { ...baseEvent, dedupeKey: "new" },
                ]),
            ],
            seenPath,
        );
        await hub.load();

        const received: Array<{ key: string; recovered: boolean }> = [];
        hub.onEvent((e, meta) =>
            received.push({ key: e.dedupeKey, recovered: meta?.recovered === true }),
        );
        hub.start();
        await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 2000, interval: 20 });
        expect(received).toEqual([
            { key: "old", recovered: true },
            { key: "new", recovered: false },
        ]);
    });

    it("is not quiet when a dedup file exists", async () => {
        seenPath = path.join(os.tmpdir(), `dedup-seen-${Math.random().toString(36).slice(2)}.json`);
        await fs.writeFile(seenPath, "{}", "utf-8");
        hub = new IngestionHub([makeConnector([baseEvent])], seenPath);
        await hub.load();

        const received: boolean[] = [];
        hub.onEvent((_e, meta) => received.push(meta?.recovered === true));
        hub.start();
        await vi.waitFor(() => expect(received).toEqual([false]), { timeout: 2000, interval: 20 });
    });
});
