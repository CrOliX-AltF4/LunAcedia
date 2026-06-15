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
});
