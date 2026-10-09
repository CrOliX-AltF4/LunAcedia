import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ChangeFeed, changeEvent, serveChanges } from "../../source/changes/change_feed.js";

// One feed of changes, never their content: a view that learns one reloads what concerns it (lot S).

describe("ChangeFeed", () => {
    it("tells every listener what changed and when, and forgets one that left", () => {
        const feed = new ChangeFeed(() => 42);
        const a = vi.fn();
        const b = vi.fn();
        const leave = feed.subscribe(a);
        feed.subscribe(b);
        feed.emit("box", "email-1");
        leave();
        feed.emit("actions");
        expect(a.mock.calls).toEqual([[{ scope: "box", key: "email-1", at: 42 }]]);
        expect(b.mock.calls.map((c) => c[0])).toEqual([
            { scope: "box", key: "email-1", at: 42 },
            { scope: "actions", at: 42 },
        ]);
        expect(feed.listening).toBe(1);
    });

    it("a listener that fails never stops the others", () => {
        const feed = new ChangeFeed();
        const after = vi.fn();
        feed.subscribe(() => {
            throw new Error("boom");
        });
        feed.subscribe(after);
        feed.emit("topics", "t1");
        expect(after).toHaveBeenCalledOnce();
    });

    it("rides the WebSocket the Core listens to as system.change, settled said", () => {
        expect(changeEvent({ scope: "actions", key: "a1", settled: true, at: 5 })).toMatchObject({
            type: "system.change",
            source: "system",
            meta: { scope: "actions", key: "a1", settled: true },
        });
    });

    it("says when the object is settled, and only then", () => {
        const feed = new ChangeFeed(() => 1);
        const seen = vi.fn();
        feed.subscribe(seen);
        feed.emit("box", "email-1", true);
        feed.emit("box", "email-2");
        expect(seen.mock.calls.map((c) => c[0])).toEqual([
            { scope: "box", key: "email-1", settled: true, at: 1 },
            { scope: "box", key: "email-2", at: 1 },
        ]);
    });
});

describe("serveChanges — Server-Sent Events", () => {
    let server: http.Server | undefined;
    afterEach(() => server?.close());

    it("streams each change as an event, with a heartbeat, and lets go when the client leaves", async () => {
        const feed = new ChangeFeed(() => 7);
        server = http.createServer((req, res) => serveChanges(req, res, feed, 30));
        await new Promise<void>((r) => server!.listen(0, r));
        const { port } = server.address() as AddressInfo;
        const controller = new AbortController();
        const resp = await fetch(`http://localhost:${port}/`, { signal: controller.signal });
        expect(resp.headers.get("content-type")).toContain("text/event-stream");
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (feed.listening === 0) await new Promise((r) => setTimeout(r, 5));
        feed.emit("box", "email-1");
        while (!text.includes(": ping")) text += decoder.decode((await reader.read()).value);
        expect(text).toContain('event: change\ndata: {"scope":"box","key":"email-1","at":7}\n\n');
        controller.abort();
        while (feed.listening > 0) await new Promise((r) => setTimeout(r, 5));
        expect(feed.listening).toBe(0);
    });
});
