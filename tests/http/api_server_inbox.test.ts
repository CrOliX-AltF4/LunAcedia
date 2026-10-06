import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { InboxSync, type InboxChange } from "../../source/hub/inbox_sync.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { AgentService } from "../../source/agent/agent_service.js";
import type {
    IConnector,
    InboxGesture,
    InboxGestureResult,
} from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// Master's own gestures act at the source, directly (D1), are journaled, and the item
// follows (R8): same path as a change seen at the source.

let PORT = 48_700 + Math.floor(Math.random() * 300);
const nextPort = () => PORT++;

async function call(
    method: string,
    url: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

function mail(id: string, read = false): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: `Mail ${id}`,
        priority: "normal",
        dedupeKey: `email-${id}`,
        meta: { messageId: id },
        read,
    };
}

type FakeGmail = IConnector & {
    gestures: Array<[InboxGesture, string]>;
    listTrash: () => Promise<Array<{ id: string; title: string; from: string; ts: number }>>;
    restoreMessage: ReturnType<typeof vi.fn>;
};

function fakeGmail(fail = false): FakeGmail {
    const gestures: Array<[InboxGesture, string]> = [];
    const results: Record<string, InboxGestureResult> = {
        open: { change: "read", body: "Texte intégral" },
        read: { change: "read" },
        unread: { change: "unread" },
        archive: { change: "removed" },
        trash: { change: "removed" },
        spam: { change: "removed" },
    };
    return {
        slug: "email",
        name: "Gmail",
        poll: async () => [],
        gestures,
        inboxGesture: async (g: InboxGesture, e: AcediaEvent) => {
            if (fail) throw new Error("Gmail said no");
            if (!(g in results)) throw new Error(`"${g}" does not apply to a mail`);
            gestures.push([g, e.dedupeKey]);
            return results[g]!;
        },
        listTrash: async () => [{ id: "t1", title: "Vieille pub", from: "x@y.z", ts: 1 }],
        restoreMessage: vi.fn(async () => {}),
    };
}

describe("AcediaApiServer — inbox routes", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(connector: IConnector, events: AcediaEvent[]) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-inbox-"));
        const store = new EventStore();
        for (const e of events) store.push(e);
        const hub = new IngestionHub([connector], path.join(dir, "seen.json"));
        const emitted: InboxChange[] = [];
        const forgotten: string[] = [];
        const sync = new InboxSync({
            connectors: [connector],
            store,
            emit: (c) => emitted.push(c),
            forget: (k) => {
                forgotten.push(k);
                hub.forget(k);
            },
        });
        server = new AcediaApiServer(
            store,
            [connector],
            hub,
            null,
            new NullAIProvider(),
            undefined,
            new ActionTierStore(path.join(dir, "t.json"), path.join(dir, "o.json")),
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            undefined,
            new AgentService(),
            sync,
        );
        const port = nextPort();
        server.start(port);
        return { base: `http://localhost:${port}`, store, emitted, forgotten, hub };
    }

    it("lists the box, newest first, with the unread count", async () => {
        const { base } = await start(fakeGmail(), [mail("a", true), mail("b")]);
        const r = await call("GET", `${base}/api/inbox`);
        expect(r.status).toBe(200);
        expect(r.body.items.map((i: AcediaEvent) => i.dedupeKey)).toEqual(["email-b", "email-a"]);
        expect(r.body.unread).toBe(1);
    });

    it("opens a mail: the whole text, marked read in the box, the Core told", async () => {
        const gmail = fakeGmail();
        const { base, store, emitted } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/open`);
        expect(r.body).toEqual({ ok: true, change: "read", body: "Texte intégral" });
        expect(store.get("email-a")!.read).toBe(true);
        expect(emitted).toEqual([{ op: "read", key: "email-a", source: "email" }]);
    });

    it("reports a mail as spam directly, and it leaves the box (D1)", async () => {
        const gmail = fakeGmail();
        const { base, store } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/spam`);
        expect(r.body).toEqual({ ok: true, change: "removed" });
        expect(gmail.gestures).toEqual([["spam", "email-a"]]);
        expect(store.get("email-a")).toBeUndefined();
    });

    it("trashes a mail directly — no tier, no pending: Master's click is the decision (D1)", async () => {
        const gmail = fakeGmail();
        const { base, store, emitted } = await start(gmail, [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/trash`);
        expect(r.body).toEqual({ ok: true, change: "removed" });
        expect(gmail.gestures).toEqual([["trash", "email-a"]]);
        expect(store.get("email-a")).toBeUndefined();
        expect(emitted).toEqual([{ op: "removed", key: "email-a", source: "email" }]);
        expect((await call("GET", `${base}/api/actions/pending`)).body).toEqual([]);
    });

    it("journals every gesture, successful or not", async () => {
        const { base } = await start(fakeGmail(), [mail("a"), mail("b")]);
        await call("POST", `${base}/api/inbox/email-a/archive`);
        await call("POST", `${base}/api/inbox/email-b/done`);
        const j = await call("GET", `${base}/api/inbox/journal`);
        expect(
            j.body.map((e: { key: string; gesture: string; ok: boolean }) => [
                e.key,
                e.gesture,
                e.ok,
            ]),
        ).toEqual([
            ["email-b", "done", false],
            ["email-a", "archive", true],
        ]);
    });

    it("answers 404 for an unknown item and 400 for an unknown gesture", async () => {
        const { base } = await start(fakeGmail(), [mail("a")]);
        expect((await call("POST", `${base}/api/inbox/email-zz/read`)).status).toBe(404);
        expect((await call("POST", `${base}/api/inbox/email-a/explode`)).status).toBe(400);
    });

    it("reports a refusal from the source as 502 and changes nothing", async () => {
        const { base, store, emitted } = await start(fakeGmail(true), [mail("a")]);
        const r = await call("POST", `${base}/api/inbox/email-a/trash`);
        expect(r.status).toBe(502);
        expect(r.body.error).toContain("Gmail said no");
        expect(store.get("email-a")).toBeDefined();
        expect(emitted).toEqual([]);
    });

    it("lists Gmail's trash and restores a mail, which comes back at the next collection", async () => {
        const gmail = fakeGmail();
        const { base, hub } = await start(gmail, []);
        const forget = vi.spyOn(hub, "forget");
        expect((await call("GET", `${base}/api/inbox/trash`)).body.items[0]).toMatchObject({
            id: "t1",
        });
        const r = await call("POST", `${base}/api/inbox/trash/t1/restore`);
        expect(r.body).toEqual({ ok: true });
        expect(gmail.restoreMessage).toHaveBeenCalledWith("t1");
        expect(forget).toHaveBeenCalledWith("email-t1");
    });
});
