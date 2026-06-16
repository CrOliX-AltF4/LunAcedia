import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HaConnector } from "../../../source/connectors/ha/ha_connector.js";

const LAST_CHANGED = "2026-06-16T10:00:00.000Z";
const LAST_CHANGED_TS = new Date(LAST_CHANGED).getTime();

function makeStateResponse(entityId: string, state: string) {
    return {
        ok: true,
        json: () =>
            Promise.resolve({
                entity_id: entityId,
                state,
                attributes: { friendly_name: entityId },
                last_changed: LAST_CHANGED,
            }),
    };
}

beforeEach(() => {
    process.env["HA_URL"] = "http://ha.local:8123";
    process.env["HA_TOKEN"] = "test-token";
    process.env["HA_ENTITIES"] = JSON.stringify(["light.living_room"]);
    process.env["HA_PRIORITY"] = "normal";
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["HA_URL"];
    delete process.env["HA_TOKEN"];
    delete process.env["HA_ENTITIES"];
    delete process.env["HA_PRIORITY"];
    delete process.env["HA_POLL_INTERVAL_MIN"];
});

describe("HaConnector", () => {
    it("should return empty array when HA_URL is missing", async () => {
        delete process.env["HA_URL"];
        expect(await new HaConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when HA_TOKEN is missing", async () => {
        delete process.env["HA_TOKEN"];
        expect(await new HaConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when HA_ENTITIES is empty", async () => {
        process.env["HA_ENTITIES"] = "[]";
        expect(await new HaConnector().poll()).toHaveLength(0);
    });

    it("should emit event on first poll (no previous state)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on")),
        );
        const connector = new HaConnector();
        const events = await connector.poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe("ha.state_changed");
        expect(events[0]!.title).toBe("light.living_room: on");
        expect(events[0]!.body).toBe("on");
        expect(events[0]!.source).toBe("ha");
    });

    it("should NOT emit when state has not changed since last poll", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on")),
        );
        const connector = new HaConnector();
        await connector.poll(); // first poll — emits
        const events = await connector.poll(); // second poll — same state
        expect(events).toHaveLength(0);
    });

    it("should emit again when state changes", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(makeStateResponse("light.living_room", "off"))
            .mockResolvedValueOnce(makeStateResponse("light.living_room", "on"));
        vi.stubGlobal("fetch", fetchMock);

        const connector = new HaConnector();
        await connector.poll();
        const events = await connector.poll();

        expect(events).toHaveLength(1);
        expect(events[0]!.body).toBe("off → on");
    });

    it("should include prevState → newState in body after first poll", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(makeStateResponse("binary_sensor.motion", "off"))
            .mockResolvedValueOnce(makeStateResponse("binary_sensor.motion", "on"));
        vi.stubGlobal("fetch", fetchMock);

        process.env["HA_ENTITIES"] = JSON.stringify(["binary_sensor.motion"]);
        const connector = new HaConnector();
        await connector.poll();
        const events = await connector.poll();
        expect(events[0]!.body).toBe("off → on");
    });

    it("should use dedupeKey with ha- prefix, entityId, state, and ts", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on")),
        );
        const connector = new HaConnector();
        const events = await connector.poll();
        expect(events[0]!.dedupeKey).toBe(`ha-light.living_room-on-${LAST_CHANGED_TS}`);
    });

    it("should include meta with entityId, state, prevState, attributes", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on")),
        );
        const connector = new HaConnector();
        const events = await connector.poll();
        const meta = events[0]!.meta!;
        expect(meta["entityId"]).toBe("light.living_room");
        expect(meta["state"]).toBe("on");
        expect(meta["prevState"]).toBeUndefined();
    });

    it("should respect HA_PRIORITY env", async () => {
        process.env["HA_PRIORITY"] = "urgent";
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on")),
        );
        const events = await new HaConnector().poll();
        expect(events[0]!.priority).toBe("urgent");
    });

    it("should poll multiple entities independently", async () => {
        process.env["HA_ENTITIES"] = JSON.stringify(["light.room1", "light.room2"]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("room1"))
                    return Promise.resolve(makeStateResponse("light.room1", "on"));
                return Promise.resolve(makeStateResponse("light.room2", "off"));
            }),
        );
        const events = await new HaConnector().poll();
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.title).sort()).toEqual(["light.room1: on", "light.room2: off"]);
    });

    it("should skip entity and continue on fetch error", async () => {
        process.env["HA_ENTITIES"] = JSON.stringify(["light.ok", "light.broken"]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("light.ok"))
                    return Promise.resolve(makeStateResponse("light.ok", "on"));
                return Promise.reject(new Error("network"));
            }),
        );
        const events = await new HaConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.title).toBe("light.ok: on");
    });

    it("should skip entity on non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
        expect(await new HaConnector().poll()).toHaveLength(0);
    });

    it("should expose name and preferredPollIntervalMs", () => {
        const connector = new HaConnector();
        expect(connector.name).toBe("HomeAssistant");
        expect(connector.preferredPollIntervalMs).toBeGreaterThan(0);
    });

    it("should strip trailing slash from HA_URL", async () => {
        process.env["HA_URL"] = "http://ha.local:8123/";
        const fetchMock = vi.fn().mockResolvedValue(makeStateResponse("light.living_room", "on"));
        vi.stubGlobal("fetch", fetchMock);
        await new HaConnector().poll();
        const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
        expect(calledUrl).toBe("http://ha.local:8123/api/states/light.living_room");
    });
});
