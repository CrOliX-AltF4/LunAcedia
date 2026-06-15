import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { AcediaWsServer } from "../../source/ws/acedia_ws_server.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

const testEvent: AcediaEvent = {
    type:      "github.push",
    ts:        Date.now(),
    source:    "github",
    title:     "Push to main",
    priority:  "normal",
    dedupeKey: "test-1",
};

async function connectClient(port: number): Promise<WebSocket> {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.once("open", () => resolve(ws));
    });
}

describe("AcediaWsServer", () => {
    let server: AcediaWsServer;

    afterEach(() => server.stop());

    it("should accept a client connection", async () => {
        server = new AcediaWsServer();
        server.start(0);
        // @ts-expect-error — accessing private wss for test
        const port = server.wss!.address().port as number;

        const ws = await connectClient(port);
        await new Promise((r) => setTimeout(r, 30));

        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    it("should broadcast an event to connected clients", async () => {
        server = new AcediaWsServer();
        server.start(0);
        // @ts-expect-error — accessing private wss for test
        const port = server.wss!.address().port as number;

        const ws = await connectClient(port);
        const received: AcediaEvent[] = [];
        ws.on("message", (data) => received.push(JSON.parse(data.toString()) as AcediaEvent));

        server.broadcast(testEvent);
        await new Promise((r) => setTimeout(r, 50));

        expect(received.some((e) => e.dedupeKey === "test-1")).toBe(true);
        ws.close();
    });

    it("should not send to closed clients", async () => {
        server = new AcediaWsServer();
        server.start(0);
        // @ts-expect-error — accessing private wss for test
        const port = server.wss!.address().port as number;

        const ws = await connectClient(port);
        ws.close();
        await new Promise((r) => setTimeout(r, 50));

        // Should not throw
        expect(() => server.broadcast(testEvent)).not.toThrow();
    });
});
