import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { EventStore } from "../../source/store/event_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
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
    return { name, poll: async () => [], executeAction };
}

const nullAI = new NullAIProvider();

function makeServer(
    store: EventStore,
    connectors: IConnector[] = [],
    ai: IAIProvider = nullAI,
    secret: string | undefined = SECRET,
): AcediaApiServer {
    return new AcediaApiServer(store, connectors, null, ai, secret);
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

    it("should include ai mode in health response", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/health`);
        server.stop();
        expect((res.body as Record<string, unknown>)["ai"]).toBe("none");
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
        const server = new AcediaApiServer(new EventStore(), [], null, nullAI, undefined);
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
    it("should dispatch action to matching connector", async () => {
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
        expect(res.status).toBe(204);
        expect(called).toBe(true);
    });

    it("should return 404 when connector not found", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await post(
            `http://localhost:${port}/api/actions`,
            { connector: "NoSuchConnector", action: { kind: "complete", sourceId: "x" } },
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
            { connector: "ReadOnly", action: { kind: "complete", sourceId: "x" } },
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
});

describe("AcediaApiServer — GET /api/digest", () => {
    it("should return 503 when AI provider is none", async () => {
        const port = nextPort();
        const server = makeServer(new EventStore());
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
        server.stop();
        expect(res.status).toBe(503);
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
        const body = res.body as { response: string; count: number };
        expect(body.response).toBe("Today you have 1 email.");
        expect(body.count).toBe(1);
    });

    it("should return 502 when AI provider throws", async () => {
        const port = nextPort();
        const mockAI: IAIProvider = {
            mode: "openai",
            chat: vi.fn(),
            digest: vi.fn().mockRejectedValue(new Error("Timeout")),
        };
        const server = makeServer(new EventStore(), [], mockAI);
        server.start(port);
        const res = await get(`http://localhost:${port}/api/digest`, AUTH);
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
