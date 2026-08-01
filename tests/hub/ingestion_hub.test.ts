import { describe, it, expect, vi, afterEach } from "vitest";
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
});
