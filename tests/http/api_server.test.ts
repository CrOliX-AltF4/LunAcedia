import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { ChangeFeed } from "../../source/changes/change_feed.js";
import { ActionCooldownTracker } from "../../source/actions/action_cooldown.js";
import { EmailClassificationStore } from "../../source/connectors/email/email_classification_store.js";
import { GoogleTokenStore } from "../../source/auth/google_token_store.js";
import { DEFAULT_ACTION_TIERS } from "../../source/types/action_tier.js";
import type { IAIProvider } from "../../source/ai/ai_provider.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";
import type { ConnectorAction } from "../../source/types/connector_action.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: Date.now(),
        source: "email",
        title: "Test",
        priority: "normal",
        dedupeKey: `e-${Math.random()}`,
        ...overrides,
    };
}

function get(
    url: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => {
            let data = "";
            res.on("data", (c: Buffer) => {
                data += c.toString();
            });
            res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
            );
        }).on("error", reject);
    });
}

function post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const parsed = new URL(url);
        const req = http.request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    ...headers,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c: Buffer) => {
                    data += c.toString();
                });
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
                );
            },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function getNoRedirect(
    url: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; location: string | undefined; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => {
            let data = "";
            res.on("data", (c: Buffer) => {
                data += c.toString();
            });
            res.on("end", () =>
                resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    body: data,
                }),
            );
        }).on("error", reject);
    });
}

function patch(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const parsed = new URL(url);
        const req = http.request(
            {
                hostname: parsed.hostname,
                port: parsed.port,
                path: parsed.pathname,
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    ...headers,
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c: Buffer) => {
                    data += c.toString();
                });
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
                );
            },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET = "test-secret";
const AUTH = { Authorization: `Bearer ${SECRET}` };
let PORT = 14000;

function nextPort() {
    return PORT++;
}

function makeConnector(
    name: string,
    executeAction?: (a: ConnectorAction) => Promise<void>,
): IConnector {
    return { slug: "github", name, poll: async () => [], executeAction };
}

const nullAI = new NullAIProvider();

// Isolated tmp file per call — writing tiers must never touch the real ~/.lunacedia.
function tmpTierStore(): ActionTierStore {
    return new ActionTierStore(
        path.join(
            os.tmpdir(),
            `lunacedia-test-tiers-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
        ),
    );
}

function makeServer(
    store: EventStore,
    connectors: IConnector[] = [],
    ai: IAIProvider = nullAI,
    secret: string | undefined = SECRET,
    tierStore: ActionTierStore = new ActionTierStore(),
    emailClassificationStore?: EmailClassificationStore,
    googleTokenStore?: GoogleTokenStore,
    cooldown?: ActionCooldownTracker,
): AcediaApiServer {
    return new AcediaApiServer(
        store,
        connectors,
        new IngestionHub(connectors),
        null,
        ai,
        secret,
        tierStore,
        new PendingActionStore(null),
        emailClassificationStore,
        googleTokenStore,
        cooldown,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AcediaApiServer — /api/health", () => {
    it("should return 200 without auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/health`);
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>)["status"]).toBe("ok");
    });

    it("should include the package.json version in health response", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/health`);
        server.stop();
        expect((res.body as Record<string, unknown>)["version"]).toBe(
            (await import("../../package.json", { with: { type: "json" } })).default.version,
        );
    });

    it("should include ai mode in health response", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/health`);
        server.stop();
        expect((res.body as Record<string, unknown>)["ai"]).toBe("none");
    });

    it("should report a configured-but-never-polled connector as not connected, not just 'enabled'", async () => {
        const port = nextPort();
        const conn = makeConnector("Gmail");
        const server = makeServer(new EventStore(), [conn]);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/health`);
        server.stop();
        expect(res.body).toMatchObject({
            connectors: [
                {
                    slug: "github",
                    name: "Gmail",
                    connected: false,
                    lastSuccessAt: null,
                    lastError: null,
                },
            ],
        });
    });
});

describe("AcediaApiServer — auth", () => {
    it("should return 401 without bearer token when secret is set", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/events`);
        server.stop();
        expect(res.status).toBe(401);
    });

    it("should return 200 with correct bearer token", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/events`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
    });

    it("should allow requests without auth when no secret is configured", async () => {
        const port = nextPort();
        const server = new AcediaApiServer(
            new EventStore(),
            [],
            new IngestionHub([]),
            null,
            nullAI,
            undefined,
            new ActionTierStore(),
            new PendingActionStore(null),
        );
        server.start(port);
        const res = await get(`http://localhost:${port}/api/events`);
        server.stop();
        expect(res.status).toBe(200);
    });
});

describe("AcediaApiServer — GET /api/events", () => {
    let port: number;
    let store: EventStore;
    let server: AcediaApiServer;

    beforeEach(() => {
        port = nextPort();
        store = new EventStore();
        server = makeServer(store);
        server.start(port);
    });
    afterEach(() => server.stop());

    it("should return empty events list when store is empty", async () => {
        const res = await get(`http://localhost:${port}/api/events`, AUTH);
        expect(res.status).toBe(200);
        const body = res.body as { events: unknown[]; total: number };
        expect(body.events).toHaveLength(0);
        expect(body.total).toBe(0);
    });

    it("should return pushed events", async () => {
        store.push(makeEvent({ dedupeKey: "e1", title: "Mail 1" }));
        const res = await get(`http://localhost:${port}/api/events`, AUTH);
        const body = res.body as { events: AcediaEvent[]; total: number };
        expect(body.total).toBe(1);
        expect(body.events[0]!.title).toBe("Mail 1");
    });

    it("should filter by source query param", async () => {
        store.push(makeEvent({ source: "email", dedupeKey: "e1" }));
        store.push(makeEvent({ source: "calendar", dedupeKey: "c1" }));
        const res = await get(`http://localhost:${port}/api/events?source=email`, AUTH);
        const body = res.body as { events: AcediaEvent[] };
        expect(body.events).toHaveLength(1);
        expect(body.events[0]!.source).toBe("email");
    });

    it("should ignore unknown source values", async () => {
        store.push(makeEvent({ dedupeKey: "e1" }));
        const res = await get(`http://localhost:${port}/api/events?source=unknown`, AUTH);
        const body = res.body as { events: AcediaEvent[] };
        expect(body.events).toHaveLength(1); // source filter ignored
    });
});

describe("AcediaApiServer — GET /api/events/:dedupeKey", () => {
    it("should return 404 for unknown key", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/events/no-such-key`, AUTH);
        server.stop();
        expect(res.status).toBe(404);
    });

    it("should return the event for a known key", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ dedupeKey: "email-42", title: "Found it" }));
        const res = await get(`http://localhost:${port}/api/events/email-42`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as AcediaEvent).title).toBe("Found it");
    });
});

describe("AcediaApiServer — GET /api/stats", () => {
    it("should return stats by source", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ source: "email", dedupeKey: "e1" }));
        store.push(makeEvent({ source: "email", dedupeKey: "e2" }));
        store.push(makeEvent({ source: "github", dedupeKey: "g1", type: "github.push" }));
        const res = await get(`http://localhost:${port}/api/stats`, AUTH);
        server.stop();
        const body = res.body as { bySource: Record<string, number>; total: number };
        expect(body.bySource["email"]).toBe(2);
        expect(body.bySource["github"]).toBe(1);
        expect(body.total).toBe(3);
    });
});

describe("AcediaApiServer — POST /api/actions", () => {
    it("defaults to the 'confirm' tier — queues instead of executing immediately", async () => {
        const port = nextPort();
        const store = new EventStore();
        let called = false;
        const conn = makeConnector("Gmail", async () => {
            called = true;
        });
        const server = makeServer(store, [conn]);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(202);
        expect((res.body as { status: string }).status).toBe("pending");
        expect(called).toBe(false);
    });

    it("executes immediately when the action kind's tier is 'auto'", async () => {
        const port = nextPort();
        const store = new EventStore();
        let called = false;
        const conn = makeConnector("Gmail", async () => {
            called = true;
        });
        const tierStore = tmpTierStore();
        await tierStore.patch({ reply: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(204);
        expect(called).toBe(true);
    });

    // Connectors used to swallow their own HTTP failures (log + return) instead of throwing,
    // so dispatchAction's try/catch never fired and a broken action reported success (204)
    // to the caller — see source/connectors/connector_http.ts.
    it("returns 500 instead of a false success when the connector's executeAction throws", async () => {
        const port = nextPort();
        const store = new EventStore();
        const conn = makeConnector("Gmail", async () => {
            throw new Error("[Gmail] reply send returned 401");
        });
        const tierStore = tmpTierStore();
        await tierStore.patch({ reply: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(500);
        // The reason travels with the failure: "nothing was done" must say why.
        expect((res.body as { error: string }).error).toBe(
            "Action failed: [Gmail] reply send returned 401",
        );
    });

    it("rejects with 403 once the action kind hits its cooldown, even on 'auto' tier", async () => {
        const port = nextPort();
        const store = new EventStore();
        let calls = 0;
        const conn = makeConnector("Gmail", async () => {
            calls++;
        });
        const tierStore = tmpTierStore();
        await tierStore.patch({ reply: "auto" });
        const server = makeServer(
            store,
            [conn],
            nullAI,
            SECRET,
            tierStore,
            undefined,
            undefined,
            new ActionCooldownTracker(5 * 60_000, 1),
        );
        server.start(port);
        const body = {
            connector: "Gmail",
            action: { kind: "reply", sourceId: "msg1", body: "Hi" },
        };
        const first = await post(`http://localhost:${port}/api/actions`, body, AUTH);
        const second = await post(`http://localhost:${port}/api/actions`, body, AUTH);
        server.stop();
        expect(first.status).toBe(204);
        expect(second.status).toBe(403);
        expect(calls).toBe(1);
    });

    it("rejects with 403 when the action kind's tier is 'manual'", async () => {
        const port = nextPort();
        const store = new EventStore();
        let called = false;
        const conn = makeConnector("Gmail", async () => {
            called = true;
        });
        const tierStore = tmpTierStore();
        await tierStore.patch({ reply: "manual" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(403);
        expect(called).toBe(false);
    });

    it("confirm tier: POST /api/actions/:id/confirm executes the pending action", async () => {
        const port = nextPort();
        const store = new EventStore();
        let called: ConnectorAction | null = null;
        const conn = makeConnector("Gmail", async (a) => {
            called = a;
        });
        const server = makeServer(store, [conn]);
        server.start(port);
        const create = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        const id = (create.body as { id: string }).id;
        const confirm = await post(`http://localhost:${port}/api/actions/${id}/confirm`, {}, AUTH);
        server.stop();
        expect(confirm.status).toBe(204);
        expect(called).toEqual({ kind: "reply", sourceId: "msg1", body: "Hi" });
    });

    it("says what became of each action: confirmed, failed with its reason, cancelled", async () => {
        const port = nextPort();
        let fail = false;
        const conn = makeConnector("Gmail", async () => {
            if (fail) throw new Error("[Gmail] reply send returned 401");
        });
        const server = makeServer(new EventStore(), [conn]);
        server.start(port);
        const base = `http://localhost:${port}`;
        const propose = async () =>
            (
                (
                    await post(
                        `${base}/api/actions`,
                        {
                            connector: "Gmail",
                            action: { kind: "reply", sourceId: "m1", body: "Hi" },
                        },
                        AUTH,
                    )
                ).body as { id: string }
            ).id;
        const ok = await propose();
        const ko = await propose();
        const no = await propose();
        const waiting = await propose();
        await post(`${base}/api/actions/${ok}/confirm`, {}, AUTH);
        fail = true;
        await post(`${base}/api/actions/${ko}/confirm`, {}, AUTH);
        await post(`${base}/api/actions/${no}/cancel`, {}, AUTH);
        const r = await get(
            `${base}/api/actions/status?ids=${[ok, ko, no, waiting, "zz"].join(",")}`,
            AUTH,
        );
        server.stop();
        expect(r.status).toBe(200);
        const states = (r.body as { states: Record<string, Record<string, unknown>> }).states;
        expect(states[ok]).toMatchObject({ status: "confirmed", kind: "reply" });
        expect(states[ko]).toMatchObject({
            status: "failed",
            reason: "[Gmail] reply send returned 401",
        });
        expect(states[no]).toMatchObject({ status: "cancelled" });
        expect(states[waiting]).toMatchObject({ status: "pending" });
        expect(states["zz"]).toBeUndefined();
    });

    it("confirm tier: POST /api/actions/:id/confirm rejects with 429 once the kind hits its cooldown", async () => {
        const port = nextPort();
        const store = new EventStore();
        let calls = 0;
        const conn = makeConnector("Gmail", async () => {
            calls++;
        });
        const cooldown = new ActionCooldownTracker(5 * 60_000, 1);
        const server = makeServer(
            store,
            [conn],
            nullAI,
            SECRET,
            new ActionTierStore(),
            undefined,
            undefined,
            cooldown,
        );
        server.start(port);
        const body = {
            connector: "Gmail",
            action: { kind: "reply", sourceId: "msg1", body: "Hi" },
        };
        const create1 = await post(`http://localhost:${port}/api/actions`, body, AUTH);
        const id1 = (create1.body as { id: string }).id;
        const confirm1 = await post(
            `http://localhost:${port}/api/actions/${id1}/confirm`,
            {},
            AUTH,
        );

        const create2 = await post(`http://localhost:${port}/api/actions`, body, AUTH);
        const id2 = (create2.body as { id: string }).id;
        const confirm2 = await post(
            `http://localhost:${port}/api/actions/${id2}/confirm`,
            {},
            AUTH,
        );
        server.stop();

        expect(confirm1.status).toBe(204);
        expect(confirm2.status).toBe(429);
        expect(calls).toBe(1);
    });

    it("confirm tier: POST /api/actions/:id/cancel discards the pending action without executing it", async () => {
        const port = nextPort();
        const store = new EventStore();
        let called = false;
        const conn = makeConnector("Gmail", async () => {
            called = true;
        });
        const server = makeServer(store, [conn]);
        server.start(port);
        const create = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        const id = (create.body as { id: string }).id;
        const cancel = await post(`http://localhost:${port}/api/actions/${id}/cancel`, {}, AUTH);
        const confirmAfterCancel = await post(
            `http://localhost:${port}/api/actions/${id}/confirm`,
            {},
            AUTH,
        );
        server.stop();
        expect(cancel.status).toBe(204);
        expect(confirmAfterCancel.status).toBe(404);
        expect(called).toBe(false);
    });

    it("returns 404 confirming an unknown or already-resolved pending action id", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions/does-not-exist/confirm`,
            {},
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(404);
    });

    it("should return 404 when connector not found", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "NoSuchConnector", action: { kind: "complete_task", sourceId: "x" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(404);
    });

    it("should return 400 when connector does not support actions", async () => {
        const port = nextPort();
        const conn = makeConnector("ReadOnly");
        const server = makeServer(new EventStore(), [conn]);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "ReadOnly", action: { kind: "complete_task", sourceId: "x" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(400);
    });

    it("should return 400 for missing body fields", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/actions`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(400);
    });
});

// Regression: connector.executeAction() touches Gmail/GCal/Tasks for real, but EventStore
// (what /api/events actually serves) never heard about it — a deleted email's notification
// kept showing up as if nothing had happened. See source/store/event_sync.ts.
describe("AcediaApiServer — EventStore sync after action execution", () => {
    it("delete_email removes the matching buffered event ('auto' tier, direct execute path)", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Test",
            priority: "normal",
            dedupeKey: "email-msg1",
        });
        const conn = makeConnector("Gmail", async () => {});
        const tierStore = tmpTierStore();
        await tierStore.patch({ delete_email: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "delete_email", sourceId: "msg1" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("email-msg1")).toBeUndefined();
    });

    it("mark_email_read marks the matching event read, without removing it", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Test",
            priority: "normal",
            dedupeKey: "email-msg1",
        });
        const conn = makeConnector("Gmail", async () => {});
        const tierStore = tmpTierStore();
        await tierStore.patch({ mark_email_read: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "mark_email_read", sourceId: "msg1" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("email-msg1")?.read).toBe(true);
    });

    it("delete_task removes the matching event, resolving '{listId}/{taskId}' to the bare taskId", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "task.due",
            ts: Date.now(),
            source: "tasks",
            title: "Test",
            priority: "normal",
            dedupeKey: "task-abc",
        });
        const conn = makeConnector("Tasks", async () => {});
        const tierStore = tmpTierStore();
        await tierStore.patch({ delete_task: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Tasks", action: { kind: "delete_task", sourceId: "listX/abc" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("task-abc")).toBeUndefined();
    });

    it("reply has no derivable mapping — the buffered event is untouched", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Test",
            priority: "normal",
            dedupeKey: "email-msg1",
        });
        const conn = makeConnector("Gmail", async () => {});
        const tierStore = tmpTierStore();
        await tierStore.patch({ reply: "auto" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("email-msg1")?.read).toBeUndefined();
    });

    it("syncs after execution via the confirm-tier path too (POST /api/actions/:id/confirm)", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Test",
            priority: "normal",
            dedupeKey: "email-msg1",
        });
        const conn = makeConnector("Gmail", async () => {});
        // delete_email defaults to "manual" (refused outright) — force "confirm" so this test
        // exercises the pending-action path, not the default tier.
        const tierStore = tmpTierStore();
        await tierStore.patch({ delete_email: "confirm" });
        const server = makeServer(store, [conn], nullAI, SECRET, tierStore);
        server.start(port);
        const create = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "delete_email", sourceId: "msg1" } },
            AUTH,
        );
        const id = (create.body as { id: string }).id;
        const confirm = await post(`http://localhost:${port}/api/actions/${id}/confirm`, {}, AUTH);
        server.stop();
        expect(confirm.status).toBe(204);
        expect(store.get("email-msg1")).toBeUndefined();
    });
});

// A durable list Master comes back to: when it expires, where it came from, and the tier and the
// source checked again at the moment of confirming.
describe("AcediaApiServer — pending writes (M5a)", () => {
    it("says when a pending action expires and where it came from", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore(), [makeConnector("Gmail", async () => {})]);
        server.start(port);
        const before = Date.now();
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        const list = await get(`http://localhost:${port}/api/actions/pending`, AUTH);
        server.stop();
        const body = res.body as { status: string; id: string; expiresAt: number };
        expect(body.expiresAt).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000);
        expect((list.body as Array<Record<string, unknown>>)[0]).toMatchObject({
            id: body.id,
            origin: "api",
            expiresAt: body.expiresAt,
            // Said in words once, here — the phone, the panel and the dashboard only show it.
            summary: "Répondre à un mail — Hi",
        });
    });

    it("refuses to confirm a kind set to manual since it was queued", async () => {
        const port = nextPort();
        let called = false;
        const tiers = tmpTierStore();
        const server = makeServer(
            new EventStore(),
            [makeConnector("Gmail", async () => void (called = true))],
            nullAI,
            SECRET,
            tiers,
        );
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        await tiers.patch({ reply: "manual" });
        const confirm = await post(
            `http://localhost:${port}/api/actions/${(res.body as { id: string }).id}/confirm`,
            {},
            AUTH,
        );
        server.stop();
        expect(confirm.status).toBe(403);
        expect(called).toBe(false);
    });

    it("says why a confirmed action failed at the source", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore(), [
            makeConnector("Gmail", async () => {
                throw new Error("[Gmail] mail no longer exists");
            }),
        ]);
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        const confirm = await post(
            `http://localhost:${port}/api/actions/${(res.body as { id: string }).id}/confirm`,
            {},
            AUTH,
        );
        server.stop();
        expect(confirm.status).toBe(502);
        expect((confirm.body as { error: string }).error).toContain("mail no longer exists");
    });
});

describe("AcediaApiServer — GET /api/actions/pending", () => {
    it("lists a pending action created via POST /api/actions (confirm tier)", async () => {
        const port = nextPort();
        const conn = makeConnector("Gmail", async () => {});
        const server = makeServer(new EventStore(), [conn]);
        server.start(port);
        await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        const res = await get(`http://localhost:${port}/api/actions/pending`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as unknown[]).length).toBe(1);
    });
});

describe("AcediaApiServer — GET/PATCH /api/config/tiers", () => {
    // Isolated tmp file per test — writing tiers must never touch the real ~/.lunacedia.
    function tmpTierStore(): ActionTierStore {
        return new ActionTierStore(
            path.join(
                os.tmpdir(),
                `lunacedia-test-tiers-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            ),
        );
    }

    it("GET returns the default tiers when nothing was ever patched", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore(), [], nullAI, SECRET, tmpTierStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/tiers`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual(DEFAULT_ACTION_TIERS);
    });

    it("PATCH updates a tier and it takes effect on the very next POST /api/actions", async () => {
        const port = nextPort();
        let called = false;
        const conn = makeConnector("Tasks", async () => {
            called = true;
        });
        const server = makeServer(new EventStore(), [conn], nullAI, SECRET, tmpTierStore());
        server.start(port);
        const patchRes = await patch(
            `http://localhost:${port}/api/config/tiers`,
            { complete_task: "auto" },
            AUTH,
        );
        const actionRes = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Tasks", action: { kind: "complete_task", sourceId: "t1" } },
            AUTH,
        );
        server.stop();
        expect(patchRes.status).toBe(200);
        expect((patchRes.body as { changed: string[] }).changed).toEqual(["complete_task"]);
        expect(actionRes.status).toBe(204);
        expect(called).toBe(true);
    });

    it("PATCH ignores unknown action kinds and invalid tier values", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore(), [], nullAI, SECRET, tmpTierStore());
        server.start(port);
        const res = await patch(
            `http://localhost:${port}/api/config/tiers`,
            { notAKind: "auto", reply: "not-a-real-tier" },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as { changed: string[] }).changed).toEqual([]);
    });
});

describe("AcediaApiServer — GET /api/config/risk", () => {
    it("returns the static ACTION_RISK map", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/risk`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as Record<string, string>)["merge_pr"]).toBe("high");
        expect((res.body as Record<string, string>)["mark_email_read"]).toBe("low");
        expect((res.body as Record<string, string>)["reply"]).toBe("medium");
    });
});

// what a client needs to show and set the tiers without a copy of its own — LunAcedia's own words.
describe("AcediaApiServer — GET /api/config/actions", () => {
    it("lists every action with its label, connector, tier, risk, and whether its tier is locked", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/actions`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        const list = res.body as Array<Record<string, unknown>>;
        expect(list.find((a) => a.kind === "delete_email")).toEqual({
            kind: "delete_email",
            label: "Mettre un mail à la corbeille",
            connector: "Gmail",
            tier: "confirm",
            risk: "medium",
            category: "triage",
            locked: false,
        });
        expect(list.find((a) => a.kind === "merge_pr")).toMatchObject({
            tier: "manual",
            locked: true,
        });
    });
});

describe("AcediaApiServer — GET/PATCH /api/config/tier-overrides", () => {
    // Isolated tmp files per test — writing overrides must never touch the real ~/.lunacedia.
    function tmpTierStoreWithOverrides(): ActionTierStore {
        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new ActionTierStore(
            path.join(os.tmpdir(), `lunacedia-test-tiers-${stamp}.json`),
            path.join(os.tmpdir(), `lunacedia-test-overrides-${stamp}.json`),
        );
    }

    it("GET returns an empty map when nothing was ever set", async () => {
        const port = nextPort();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            tmpTierStoreWithOverrides(),
        );
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/tier-overrides`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });

    it("PATCH sets a scoped override that takes effect on the very next POST /api/actions", async () => {
        const port = nextPort();
        let called = false;
        const conn = makeConnector("Tasks", async () => {
            called = true;
        });
        const server = makeServer(
            new EventStore(),
            [conn],
            nullAI,
            SECRET,
            tmpTierStoreWithOverrides(),
        );
        server.start(port);
        const patchRes = await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "reply", scope: "boss@corp.com", tier: "manual" },
            AUTH,
        );
        server.stop();
        expect(patchRes.status).toBe(200);
        expect((patchRes.body as { overrides: Record<string, string> }).overrides).toEqual({
            "reply:boss@corp.com": "manual",
        });
        expect(called).toBe(false); // sanity — no action was submitted in this test
    });

    it("an email reply from an overridden sender is refused even though 'reply' defaults to confirm", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Hi",
            priority: "normal",
            dedupeKey: "email-msg1",
            meta: { from: "boss@corp.com" },
        });
        const conn = makeConnector("Gmail", async () => {});
        const server = makeServer(store, [conn], nullAI, SECRET, tmpTierStoreWithOverrides());
        server.start(port);
        await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "reply", scope: "boss@corp.com", tier: "manual" },
            AUTH,
        );
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "Gmail", action: { kind: "reply", sourceId: "msg1", body: "Hi" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(403);
    });

    it("a GitHub action on an overridden repo is refused via the sourceId-derived scope", async () => {
        const port = nextPort();
        const conn = makeConnector("GitHub", async () => {});
        const server = makeServer(
            new EventStore(),
            [conn],
            nullAI,
            SECRET,
            tmpTierStoreWithOverrides(),
        );
        server.start(port);
        await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "close_issue", scope: "owner/repo", tier: "manual" },
            AUTH,
        );
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "GitHub", action: { kind: "close_issue", sourceId: "owner/repo#42" } },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(403);
    });

    it("tier: null removes an existing override", async () => {
        const port = nextPort();
        const tierStore = tmpTierStoreWithOverrides();
        const server = makeServer(new EventStore(), [], nullAI, SECRET, tierStore);
        server.start(port);
        await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "reply", scope: "boss@corp.com", tier: "manual" },
            AUTH,
        );
        const res = await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "reply", scope: "boss@corp.com", tier: null },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as { overrides: Record<string, string> }).overrides).toEqual({});
    });

    it("PATCH rejects an unknown kind with 400", async () => {
        const port = nextPort();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            tmpTierStoreWithOverrides(),
        );
        server.start(port);
        const res = await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "notAKind", scope: "x", tier: "manual" },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(400);
    });

    it("PATCH rejects a malformed body with 400", async () => {
        const port = nextPort();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            tmpTierStoreWithOverrides(),
        );
        server.start(port);
        const res = await patch(
            `http://localhost:${port}/api/config/tier-overrides`,
            { kind: "reply" },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(400);
    });
});

describe("AcediaApiServer — GET/PATCH /api/config/email-rules", () => {
    function tmpClassificationStore(): EmailClassificationStore {
        return new EmailClassificationStore(
            path.join(
                os.tmpdir(),
                `lunacedia-test-email-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            ),
        );
    }

    it("returns 503 when no classification store is wired", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/email-rules`, AUTH);
        server.stop();
        expect(res.status).toBe(503);
    });

    it("GET returns empty lists by default", async () => {
        const port = nextPort();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            new ActionTierStore(),
            tmpClassificationStore(),
        );
        server.start(port);
        const res = await get(`http://localhost:${port}/api/config/email-rules`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ vipSenders: [], urgentKeywords: [], normalKeywords: [] });
    });

    it("PATCH updates the config and GET reflects it afterwards", async () => {
        const port = nextPort();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            new ActionTierStore(),
            tmpClassificationStore(),
        );
        server.start(port);
        const patchRes = await patch(
            `http://localhost:${port}/api/config/email-rules`,
            { vipSenders: ["boss@corp.com"] },
            AUTH,
        );
        const getRes = await get(`http://localhost:${port}/api/config/email-rules`, AUTH);
        server.stop();
        expect(patchRes.status).toBe(200);
        expect((patchRes.body as { vipSenders: string[] }).vipSenders).toEqual(["boss@corp.com"]);
        expect((getRes.body as { vipSenders: string[] }).vipSenders).toEqual(["boss@corp.com"]);
    });

    // One way to set a priority: keywords are guard rules now — a client still sending them is told so, not ignored.
    it("PATCH refuses keywords and changes nothing", async () => {
        const port = nextPort();
        const store = tmpClassificationStore();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            new ActionTierStore(),
            store,
        );
        server.start(port);
        const res = await patch(
            `http://localhost:${port}/api/config/email-rules`,
            { vipSenders: ["a@b.c"], urgentKeywords: ["deadline"] },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(400);
        expect((res.body as { error: string }).error).toMatch(/rules/);
        expect(store.getAll().vipSenders).toEqual([]);
    });
});

// Lot S: one stream of changes — what changed, never the content — for the dashboard and paired phones.
describe("AcediaApiServer — GET /api/changes", () => {
    it("streams the server's changes to an authenticated caller, and refuses anyone else", async () => {
        const port = nextPort();
        const feed = new ChangeFeed(() => 9);
        const server = new AcediaApiServer(
            new EventStore(),
            [],
            new IngestionHub([]),
            null,
            nullAI,
            SECRET,
            new ActionTierStore(),
            new PendingActionStore(null),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            feed,
        );
        server.start(port);
        expect((await fetch(`http://localhost:${port}/api/changes`)).status).toBe(401);
        const controller = new AbortController();
        const resp = await fetch(`http://localhost:${port}/api/changes`, {
            headers: { Authorization: AUTH["Authorization"]! },
            signal: controller.signal,
        });
        expect(resp.headers.get("content-type")).toContain("text/event-stream");
        while (feed.listening === 0) await new Promise((r) => setTimeout(r, 5));
        feed.emit("actions", "a1");
        const reader = resp.body!.getReader();
        let text = "";
        while (!text.includes("event: change"))
            text += new TextDecoder().decode((await reader.read()).value);
        controller.abort();
        server.stop();
        expect(text).toContain('{"scope":"actions","key":"a1","at":9}');
    });
});

describe("AcediaApiServer — GET /api/oauth/google/*", () => {
    const PAIRS = ["GMAIL", "GCAL", "GTASKS", "GOOGLE"].flatMap((p) => [
        `${p}_CLIENT_ID`,
        `${p}_CLIENT_SECRET`,
        `${p}_REFRESH_TOKEN`,
    ]);
    beforeEach(() => {
        process.env["GOOGLE_CLIENT_ID"] = "test-client-id";
        process.env["GOOGLE_CLIENT_SECRET"] = "test-client-secret";
    });
    afterEach(() => {
        PAIRS.forEach((k) => delete process.env[k]);
        vi.unstubAllGlobals();
    });

    /** The state of a start: the only one a callback accepts. */
    function stateOf(location: string | null): string {
        return new URL(location ?? "").searchParams.get("state") ?? "";
    }

    function tmpTokenStore(): GoogleTokenStore {
        return new GoogleTokenStore(
            path.join(
                os.tmpdir(),
                `lunacedia-test-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            ),
        );
    }

    it("start: redirects to Google's consent screen without requiring auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore(), [], nullAI, undefined);
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/start?connector=gmail`,
        );
        server.stop();
        expect(res.status).toBe(302);
        expect(res.location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
        // An unguessable state, never the connector's name.
        expect(stateOf(res.location)).toMatch(/^[0-9a-f]{32}$/);
    });

    it("start: consents with the connector's own client — the one it will refresh the token with", async () => {
        process.env["GMAIL_CLIENT_ID"] = "gm-id";
        process.env["GMAIL_CLIENT_SECRET"] = "gm-secret";
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/start?connector=gmail`,
        );
        server.stop();
        expect(new URL(res.location ?? "").searchParams.get("client_id")).toBe("gm-id");
    });

    it("start: returns 400 for an unknown connector", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/start?connector=dropbox`,
        );
        server.stop();
        expect(res.status).toBe(400);
    });

    it("start: returns 503 when neither the connector's pair nor GOOGLE_* is configured", async () => {
        delete process.env["GOOGLE_CLIENT_ID"];
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/start?connector=gmail`,
        );
        server.stop();
        expect(res.status).toBe(503);
    });

    it("callback: exchanges the code, persists the token, and does not require auth", async () => {
        process.env["GMAIL_CLIENT_ID"] = "gm-id";
        process.env["GMAIL_CLIENT_SECRET"] = "gm-secret";
        const exchange = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ refresh_token: "rt-abc" }),
        });
        const port = nextPort();
        const tokenStore = tmpTokenStore();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            new ActionTierStore(),
            undefined,
            tokenStore,
        );
        server.start(port);
        const start = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/start?connector=gmail`,
        );
        const state = stateOf(start.location);
        vi.stubGlobal("fetch", exchange);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/callback?code=abc&state=${state}`,
        );
        // The same return again: refused, nothing stored twice.
        const replay = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/callback?code=abc&state=${state}`,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toContain("Gmail connecté");
        expect(tokenStore.get("gmail")).toBe("rt-abc");
        // Exchanged with the connector's own pair.
        expect(String((exchange.mock.calls[0]![1] as RequestInit).body)).toContain(
            "client_id=gm-id",
        );
        expect(replay.body).toContain("expiré");
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it("callback: refuses a return it did not ask for — nothing exchanged, nothing stored", async () => {
        const exchange = vi.fn();
        vi.stubGlobal("fetch", exchange);
        const port = nextPort();
        const tokenStore = tmpTokenStore();
        const server = makeServer(
            new EventStore(),
            [],
            nullAI,
            SECRET,
            new ActionTierStore(),
            undefined,
            tokenStore,
        );
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/callback?code=abc&state=gmail`,
        );
        server.stop();
        expect(res.body).toContain("expiré");
        expect(exchange).not.toHaveBeenCalled();
        expect(tokenStore.get("gmail")).toBeUndefined();
    });

    it("callback: shows an error page and does not throw when Google reports an error", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await getNoRedirect(
            `http://localhost:${port}/api/oauth/google/callback?error=access_denied&state=gmail`,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toContain("refusée");
    });

    // 2026-10-07: a token in .env showed « non connecté », a token Google refused showed « connecté ».
    it("status: where each source's token comes from, whether it can be connected, and how its last collection went", async () => {
        delete process.env["GOOGLE_CLIENT_ID"];
        process.env["GMAIL_CLIENT_ID"] = "gm-id";
        process.env["GMAIL_CLIENT_SECRET"] = "gm-secret";
        process.env["GMAIL_REFRESH_TOKEN"] = "rt-env";
        const port = nextPort();
        const tokenStore = tmpTokenStore();
        await tokenStore.set("gcal", "rt-xyz");
        const gmail: IConnector = {
            slug: "email",
            name: "Gmail",
            poll: async () => {
                throw new Error("invalid_grant");
            },
        };
        const hub = new IngestionHub([gmail]);
        await hub.pollOne("email");
        const server = new AcediaApiServer(
            new EventStore(),
            [gmail],
            hub,
            null,
            nullAI,
            SECRET,
            new ActionTierStore(),
            new PendingActionStore(null),
            undefined,
            tokenStore,
        );
        server.start(port);
        const res = await get(`http://localhost:${port}/api/oauth/google/status`, AUTH);
        server.stop();
        const body = res.body as Record<string, Record<string, unknown>>;
        expect(body["gmail"]).toMatchObject({
            token: "env",
            client: "GMAIL",
            canConnect: true,
            state: "refused",
            lastError: "invalid_grant",
        });
        expect(body["gcal"]).toMatchObject({ token: "stored", canConnect: false, state: "idle" });
        expect(body["gcal"]!["why"]).toContain("GCAL_CLIENT_ID");
        expect(body["gtasks"]).toMatchObject({ token: null, state: "absent" });
    });
});

describe("AcediaApiServer — POST /api/connectors/:slug/reconnect", () => {
    it("should return 200 and ok:true when the poll succeeds", async () => {
        const port = nextPort();
        const conn: IConnector = { slug: "github", name: "GitHub", poll: async () => [] };
        const hub = new IngestionHub([conn]);
        const server = new AcediaApiServer(
            new EventStore(),
            [conn],
            hub,
            null,
            nullAI,
            SECRET,
            new ActionTierStore(),
            new PendingActionStore(null),
        );
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/connectors/github/reconnect`,
            {},
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });

    it("should return 502 and the connector's error when the poll fails", async () => {
        const port = nextPort();
        const conn: IConnector = {
            slug: "email",
            name: "Gmail",
            poll: async () => {
                throw new Error("invalid_grant");
            },
        };
        const hub = new IngestionHub([conn]);
        const server = new AcediaApiServer(
            new EventStore(),
            [conn],
            hub,
            null,
            nullAI,
            SECRET,
            new ActionTierStore(),
            new PendingActionStore(null),
        );
        server.start(port);
        const res = await post(`http://localhost:${port}/api/connectors/email/reconnect`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ ok: false, error: "invalid_grant" });
    });

    it("should return 404 for an unknown connector slug", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/connectors/nope/reconnect`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(404);
    });

    it("should update getConnectorHealth() immediately, not wait for the next scheduled poll", async () => {
        const port = nextPort();
        const conn: IConnector = { slug: "rss", name: "RSS", poll: async () => [] };
        const hub = new IngestionHub([conn]);
        const server = new AcediaApiServer(
            new EventStore(),
            [conn],
            hub,
            null,
            nullAI,
            SECRET,
            new ActionTierStore(),
            new PendingActionStore(null),
        );
        server.start(port);
        expect(hub.getConnectorHealth()[0]!.lastSuccessAt).toBeNull();
        await post(`http://localhost:${port}/api/connectors/rss/reconnect`, {}, AUTH);
        server.stop();
        expect(hub.getConnectorHealth()[0]!.lastSuccessAt).not.toBeNull();
    });
});

describe("AcediaApiServer — POST /api/chat", () => {
    it("should return 503 when AI provider is none", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/chat`, { text: "hello" }, AUTH);
        server.stop();
        expect(res.status).toBe(503);
    });

    it("should return AI response when provider is configured", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn().mockResolvedValue("Butler response"),
            digest: vi.fn().mockResolvedValue(""),
        };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        const res = await post(`http://localhost:${port}/api/chat`, { text: "What's up?" }, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>)["response"]).toBe("Butler response");
    });

    it("should return 400 when text is missing", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = { mode: "openai", chat: vi.fn(), digest: vi.fn() };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        const res = await post(`http://localhost:${port}/api/chat`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(400);
    });

    it("should return 502 when AI provider throws", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn().mockRejectedValue(new Error("Network error")),
            digest: vi.fn(),
        };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        const res = await post(`http://localhost:${port}/api/chat`, { text: "hello" }, AUTH);
        server.stop();
        expect(res.status).toBe(502);
    });

    it("should prepend context facts to the query sent to the AI provider", async () => {
        const port = nextPort();
        const chatSpy = vi.fn().mockResolvedValue("Butler response");
        const mockAI: IAIProvider = { mode: "openai", chat: chatSpy, digest: vi.fn() };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        await post(
            `http://localhost:${port}/api/chat`,
            { text: "Any urgent mail?", context: ["Boss is on leave until Friday"] },
            AUTH,
        );
        server.stop();
        const query = chatSpy.mock.calls[0]![0] as string;
        expect(query).toContain("Boss is on leave until Friday");
        expect(query).toContain("Any urgent mail?");
    });

    it("should log the caller identity when provided", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn().mockResolvedValue("ok"),
            digest: vi.fn(),
        };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        await post(
            `http://localhost:${port}/api/chat`,
            { text: "hello", callerId: "natsume-core" },
            AUTH,
        );
        server.stop();
        const logged = warnSpy.mock.calls.some((call) => String(call[0]).includes("natsume-core"));
        warnSpy.mockRestore();
        expect(logged).toBe(true);
    });
});

describe("AcediaApiServer — GET /api/digest", () => {
    it("nothing unread: nothing to summarize, the model is not called", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1", read: true }));
        const digest = vi.fn();
        const server = makeServer(store, [], { mode: "openai", chat: vi.fn(), digest });
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ response: "", count: 0, urgent: [] });
        expect(digest).not.toHaveBeenCalled();
    });

    it("lists the unread urgent items itself, with their reason, and summarizes only the other unread ones", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(
            makeEvent({
                dedupeKey: "u1",
                title: "Du boss",
                priority: "urgent",
                priorityReason: "VIP",
            }),
        );
        store.push(makeEvent({ dedupeKey: "u2", priority: "urgent", read: true }));
        store.push(makeEvent({ dedupeKey: "n1", title: "Newsletter", priority: "normal" }));
        store.push(makeEvent({ dedupeKey: "n2", priority: "normal", read: true }));
        const digest = vi.fn().mockResolvedValue("Une newsletter.");
        const server = makeServer(store, [], { mode: "openai", chat: vi.fn(), digest });
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            response: "Une newsletter.",
            count: 2,
            urgent: [{ key: "u1", title: "Du boss", source: "email", priorityReason: "VIP" }],
        });
        expect((digest.mock.calls[0]![0] as AcediaEvent[]).map((e) => e.dedupeKey)).toEqual(["n1"]);
    });

    it("without an AI provider, still lists the urgent items — just no summary", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "u1", title: "Urgent", priority: "urgent" }));
        store.push(makeEvent({ dedupeKey: "n1", priority: "normal" }));
        const server = makeServer(store);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            response: "",
            count: 2,
            urgent: [{ key: "u1", title: "Urgent", source: "email" }],
        });
    });

    it("should return digest from AI provider", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1" }));
        const mockAI: IAIProvider = {
            mode: "natsume",
            chat: vi.fn(),
            digest: vi.fn().mockResolvedValue("Today you have 1 email."),
        };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        const body = res.body as { response: string; count: number; urgent: unknown[] };
        expect(body.response).toBe("Today you have 1 email.");
        expect(body.count).toBe(1);
        expect(body.urgent).toEqual([]);
    });

    it("should return 502 when AI provider throws", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn(),
            digest: vi.fn().mockRejectedValue(new Error("Timeout")),
        };
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1" }));
        const server = makeServer(store, [], mockAI);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(502);
    });
});

describe("AcediaApiServer — GET /api/calendar/free-slots", () => {
    it("returns the whole default window as free when there are no calendar events", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/calendar/free-slots`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        const slots = res.body as { start: string; end: string }[];
        expect(slots).toHaveLength(1);
    });

    it("excludes busy timed calendar events from the free slots", async () => {
        const port = nextPort();
        const store = new EventStore();
        const start = new Date(Date.now() + 2 * 3_600_000).toISOString();
        const end = new Date(Date.now() + 3 * 3_600_000).toISOString();
        store.push(
            makeEvent({
                dedupeKey: "cal-1",
                source: "calendar",
                type: "calendar.upcoming",
                meta: { start, end },
            }),
        );
        const server = makeServer(store);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/calendar/free-slots?minGapMin=5`, AUTH);
        server.stop();
        const slots = res.body as { start: string; end: string }[];
        // Busy 2h-3h from now splits the 24h window into a before-gap and an after-gap.
        expect(slots.length).toBe(2);
    });

    it("ignores all-day events (date-only, no time component)", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(
            makeEvent({
                dedupeKey: "cal-1",
                source: "calendar",
                type: "calendar.upcoming",
                meta: { start: "2026-08-20", end: "2026-08-21" },
            }),
        );
        const server = makeServer(store);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/calendar/free-slots`, AUTH);
        server.stop();
        const slots = res.body as { start: string; end: string }[];
        expect(slots).toHaveLength(1);
    });
});

describe("AcediaApiServer — GET /api/proposals", () => {
    it("should return 503 when AI provider is none", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        expect(res.status).toBe(503);
    });

    it("only sends urgent/conflict unread events to the AI, not routine ones", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1", priority: "info", title: "Newsletter" }));
        store.push(makeEvent({ dedupeKey: "e2", priority: "urgent", title: "Server down" }));
        store.push(
            makeEvent({
                dedupeKey: "e3",
                type: "calendar.conflict",
                title: "Overlap",
                priority: "urgent",
            }),
        );
        const chatSpy = vi.fn().mockResolvedValue("1. Restart the server. 2. Decline one meeting.");
        const mockAI: IAIProvider = { mode: "natsume", chat: chatSpy, digest: vi.fn() };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        const body = res.body as { proposals: string; count: number };
        expect(body.count).toBe(2);
        expect(body.proposals).toContain("Restart the server");
        const promptSent = chatSpy.mock.calls[0]![0] as string;
        expect(promptSent).toContain("Server down");
        expect(promptSent).toContain("Overlap");
        expect(promptSent).not.toContain("Newsletter");
    });

    it("passes open calendar slots to the AI when a conflict is present", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(
            makeEvent({
                dedupeKey: "e1",
                type: "calendar.conflict",
                title: "Overlap",
                priority: "urgent",
            }),
        );
        const chatSpy = vi.fn().mockResolvedValue("Move the second meeting to the open slot.");
        const mockAI: IAIProvider = { mode: "natsume", chat: chatSpy, digest: vi.fn() };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        const promptSent = chatSpy.mock.calls[0]![0] as string;
        expect(promptSent).toContain("Open calendar slots");
    });

    it("does not include a slots block when there is no conflict, even with free calendar time", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1", priority: "urgent", title: "Server down" }));
        const chatSpy = vi.fn().mockResolvedValue("Restart it.");
        const mockAI: IAIProvider = { mode: "natsume", chat: chatSpy, digest: vi.fn() };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        const promptSent = chatSpy.mock.calls[0]![0] as string;
        expect(promptSent).not.toContain("Open calendar slots");
    });

    it("does not mark events as read — proposals are read-only", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1", priority: "urgent", title: "Urgent thing" }));
        const mockAI: IAIProvider = {
            mode: "natsume",
            chat: vi.fn().mockResolvedValue("Do it."),
            digest: vi.fn(),
        };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        expect(store.unreadCount).toBe(1);
    });

    it("should return 502 when AI provider throws", async () => {
        const port = nextPort();
        const store = new EventStore();
        store.push(makeEvent({ dedupeKey: "e1", priority: "urgent" }));
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn().mockRejectedValue(new Error("Timeout")),
            digest: vi.fn(),
        };
        const server = makeServer(store, [], mockAI);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/proposals`, AUTH);
        server.stop();
        expect(res.status).toBe(502);
    });
});

describe("AcediaApiServer — /api/devices/push-token", () => {
    it("should return 503 when FCM is not configured", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/devices/push-token`,
            { token: "abc" },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(503);
    });

    it("should return 404 for unknown routes", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/nonexistent`, AUTH);
        server.stop();
        expect(res.status).toBe(404);
    });
});

describe("AcediaApiServer — POST /api/events/:dedupeKey/read", () => {
    it("should return 204 and mark the event as read", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ dedupeKey: "email-read-me", title: "Read me" }));
        const res = await post(`http://localhost:${port}/api/events/email-read-me/read`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("email-read-me")?.read).toBe(true);
    });

    it("should return 204 even for unknown dedupeKey (idempotent)", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/events/no-such-key/read`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(204);
    });

    it("should return 401 without auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/events/e1/read`, {}, {});
        server.stop();
        expect(res.status).toBe(401);
    });
});

describe("AcediaApiServer — POST /api/events/read-all", () => {
    it("should return 204 and mark all events as read", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ dedupeKey: "e1" }));
        store.push(makeEvent({ dedupeKey: "e2" }));
        const res = await post(`http://localhost:${port}/api/events/read-all`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(204);
        expect(store.get("e1")?.read).toBe(true);
        expect(store.get("e2")?.read).toBe(true);
    });

    it("should return 401 without auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/events/read-all`, {}, {});
        server.stop();
        expect(res.status).toBe(401);
    });
});

describe("AcediaApiServer — POST /api/events/clear-read", () => {
    it("should drop only read events and report how many were removed", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ dedupeKey: "e1" }));
        store.push(makeEvent({ dedupeKey: "e2" }));
        store.markRead("e1");
        const res = await post(`http://localhost:${port}/api/events/clear-read`, {}, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ removed: 1 });
        expect(store.get("e1")).toBeUndefined();
        expect(store.get("e2")).toBeDefined();
    });

    it("should return 401 without auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/events/clear-read`, {}, {});
        server.stop();
        expect(res.status).toBe(401);
    });
});

describe("AcediaApiServer — POST /api/events/held", () => {
    it("reports which keys the box still holds, with their read state", async () => {
        const port = nextPort();
        const store = new EventStore();
        const server = makeServer(store);
        server.start(port);
        store.push(makeEvent({ dedupeKey: "e1" }));
        store.push(makeEvent({ dedupeKey: "e2" }));
        store.markRead("e2");
        const res = await post(
            `http://localhost:${port}/api/events/held`,
            { keys: ["e1", "e2", "gone"] },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            held: { e1: { read: false }, e2: { read: true } },
            ready: false, // the hub was never started: its initial sweep has not run
        });
    });

    it("refuses a body that is not a bounded list of keys", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const bad = await post(`http://localhost:${port}/api/events/held`, { keys: [1] }, AUTH);
        const big = await post(
            `http://localhost:${port}/api/events/held`,
            { keys: Array.from({ length: 2001 }, (_, i) => `k${i}`) },
            AUTH,
        );
        server.stop();
        expect(bad.status).toBe(400);
        expect(big.status).toBe(400);
    });

    it("should return 401 without auth", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(`http://localhost:${port}/api/events/held`, { keys: [] }, {});
        server.stop();
        expect(res.status).toBe(401);
    });
});

describe("AcediaApiServer — GET /api/events?unread=true", () => {
    let port: number;
    let store: EventStore;
    let server: AcediaApiServer;

    beforeEach(() => {
        port = nextPort();
        store = new EventStore();
        server = makeServer(store);
        server.start(port);
    });
    afterEach(() => server.stop());

    it("should return only unread events when unread=true", async () => {
        store.push(makeEvent({ dedupeKey: "e1", title: "Unread" }));
        store.push(makeEvent({ dedupeKey: "e2", title: "Read" }));
        store.markRead("e2");
        const res = await get(`http://localhost:${port}/api/events?unread=true`, AUTH);
        const body = res.body as { events: AcediaEvent[]; total: number };
        expect(res.status).toBe(200);
        expect(body.events).toHaveLength(1);
        expect(body.events[0]!.dedupeKey).toBe("e1");
    });

    it("should return all events when unread param is absent", async () => {
        store.push(makeEvent({ dedupeKey: "e1" }));
        store.push(makeEvent({ dedupeKey: "e2" }));
        store.markRead("e2");
        const res = await get(`http://localhost:${port}/api/events`, AUTH);
        const body = res.body as { events: AcediaEvent[]; total: number };
        expect(body.events).toHaveLength(2);
    });

    it("should return empty list when all events are read and unread=true", async () => {
        store.push(makeEvent({ dedupeKey: "e1" }));
        store.markAllRead();
        const res = await get(`http://localhost:${port}/api/events?unread=true`, AUTH);
        const body = res.body as { events: AcediaEvent[]; total: number };
        expect(body.events).toHaveLength(0);
        expect(body.total).toBe(0);
    });
});

describe("AcediaApiServer — POST /api/config/ai-provider", () => {
    let tmpDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lunacedia-ai-onboard-"));
        cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
        process.env["STORAGE_DIR"] = tmpDir;
        delete process.env["AI_PROVIDER"];
        delete process.env["OPENAI_API_KEY"];
    });

    afterEach(() => {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env["STORAGE_DIR"];
        delete process.env["AI_PROVIDER"];
        delete process.env["OPENAI_API_KEY"];
    });

    it("configures openai and the change is live immediately (no restart)", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/config/ai-provider`,
            { provider: "openai", apiKey: "sk-test-key" },
            AUTH,
        );
        expect(res.status).toBe(200);
        expect((res.body as Record<string, unknown>)["provider"]).toBe("openai");
        expect((res.body as Record<string, unknown>)["apiKey"]).toBeUndefined();

        const health = await get(`http://localhost:${port}/api/health`, AUTH);
        server.stop();
        expect((health.body as Record<string, unknown>)["ai"]).toBe("openai");
    });

    it("returns 400 for openai without an apiKey", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/config/ai-provider`,
            { provider: "openai" },
            AUTH,
        );
        server.stop();
        expect(res.status).toBe(400);
    });

    it("requires auth like every other route", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/config/ai-provider`,
            { provider: "openai", apiKey: "sk-x" },
            {},
        );
        server.stop();
        expect(res.status).toBe(401);
    });
});

describe("AcediaApiServer — GET /api/identity", () => {
    afterEach(() => {
        delete process.env["ASSISTANT_NAME"];
    });

    it("names the assistant LunAcedia by default — never Natsume", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/identity`, AUTH);
        server.stop();
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ name: "LunAcedia", kind: "lunacedia" });
    });

    it("uses ASSISTANT_NAME when set, and requires the token", async () => {
        process.env["ASSISTANT_NAME"] = "Alfred";
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const ok = await get(`http://localhost:${port}/api/identity`, AUTH);
        const anon = await get(`http://localhost:${port}/api/identity`, {});
        server.stop();
        expect(ok.body).toMatchObject({ name: "Alfred" });
        expect(anon.status).toBe(401);
    });
});
