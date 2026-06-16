import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";

const NOW = Date.now();
const FRESH_TS = String(NOW - 1_000);
const OLD_TS = String(NOW - 30 * 3_600_000);

type FakeMessage = { id: string; from: string; subject: string; ts: string };

function makeFetch(messages: FakeMessage[]) {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "test-token", expires_in: 3600 }),
            });
        }
        if (u.includes("/messages?q=")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ messages: messages.map((m) => ({ id: m.id })) }),
            });
        }
        const msg = messages.find((m) => u.includes(m.id));
        if (msg) {
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        id: msg.id,
                        internalDate: msg.ts,
                        payload: {
                            headers: [
                                { name: "From", value: msg.from },
                                { name: "Subject", value: msg.subject },
                            ],
                        },
                    }),
            });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
}

beforeEach(() => {
    clearTokenCache();
    process.env["GMAIL_CLIENT_ID"] = "client-id";
    process.env["GMAIL_CLIENT_SECRET"] = "client-secret";
    process.env["GMAIL_REFRESH_TOKEN"] = "refresh-token";
    process.env["GMAIL_MAX_AGE_HOURS"] = "24";
    process.env["GMAIL_RULES"] = "[]";
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["GMAIL_CLIENT_ID"];
    delete process.env["GMAIL_CLIENT_SECRET"];
    delete process.env["GMAIL_REFRESH_TOKEN"];
    delete process.env["GMAIL_MAX_AGE_HOURS"];
    delete process.env["GMAIL_RULES"];
});

describe("GmailConnector", () => {
    it("should return empty array when credentials are missing", async () => {
        delete process.env["GMAIL_CLIENT_ID"];
        const connector = new GmailConnector();
        expect(await connector.poll()).toHaveLength(0);
    });

    it("should return events for fresh messages", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "msg1", from: "alice@example.com", subject: "Hello", ts: FRESH_TS }]),
        );
        const events = await new GmailConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.title).toBe("Hello");
        expect(events[0]!.source).toBe("email");
        expect(events[0]!.type).toBe("email.received");
    });

    it("should filter out messages older than GMAIL_MAX_AGE_HOURS", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "fresh", from: "a@a.com", subject: "Fresh", ts: FRESH_TS },
                { id: "old", from: "b@b.com", subject: "Old", ts: OLD_TS },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events.some((e) => e.title === "Fresh")).toBe(true);
        expect(events.every((e) => e.title !== "Old")).toBe(true);
    });

    it("should apply priority rules", async () => {
        process.env["GMAIL_RULES"] = JSON.stringify([
            { senderPattern: "boss@company.com", priority: "urgent" },
        ]);
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "msg1", from: "boss@company.com", subject: "Urgent matter", ts: FRESH_TS },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.priority).toBe("urgent");
    });

    it("should default to info priority when no rule matches", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "msg1", from: "unknown@somewhere.com", subject: "Newsletter", ts: FRESH_TS },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.priority).toBe("info");
    });

    it("should set dedupeKey with email- prefix", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "abc123", from: "x@x.com", subject: "Test", ts: FRESH_TS }]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.dedupeKey).toBe("email-abc123");
    });

    it("should use From header as body", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "msg1", from: "alice@example.com", subject: "Hi", ts: FRESH_TS }]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.body).toBe("alice@example.com");
    });

    it("should return empty array when token refresh fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new GmailConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when list request returns non-ok", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("oauth2.googleapis.com")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                }
                return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
            }),
        );
        expect(await new GmailConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when inbox is empty", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("oauth2.googleapis.com")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            }),
        );
        expect(await new GmailConnector().poll()).toHaveLength(0);
    });

    it("should expose name and preferredPollIntervalMs", () => {
        const connector = new GmailConnector();
        expect(connector.name).toBe("Gmail");
        expect(connector.preferredPollIntervalMs).toBeGreaterThan(0);
    });

    it("should include threadId in meta", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes("oauth2.googleapis.com"))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                if (u.includes("/messages?q="))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ messages: [{ id: "msg1" }] }),
                    });
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            id: "msg1",
                            threadId: "thread-1",
                            internalDate: FRESH_TS,
                            payload: {
                                headers: [
                                    { name: "From", value: "a@a.com" },
                                    { name: "Subject", value: "Hi" },
                                ],
                            },
                        }),
                });
            }),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.meta?.["threadId"]).toBe("thread-1");
    });
});

describe("GmailConnector.executeAction — reply", () => {
    beforeEach(() => {
        clearTokenCache();
        process.env["GMAIL_CLIENT_ID"] = "cid";
        process.env["GMAIL_CLIENT_SECRET"] = "csec";
        process.env["GMAIL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("should send a reply via Gmail API", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (u.includes("/messages/msg1?"))
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            id: "msg1",
                            threadId: "thread-1",
                            internalDate: FRESH_TS,
                            payload: {
                                headers: [
                                    { name: "From", value: "alice@example.com" },
                                    { name: "Subject", value: "Hello" },
                                    { name: "Message-Id", value: "<orig@example.com>" },
                                ],
                            },
                        }),
                });
            if (u.includes("/messages/send") && opts?.method === "POST")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        const connector = new GmailConnector();
        await connector.executeAction({ kind: "reply", sourceId: "msg1", body: "Thanks!" });
        const sendCall = mockFetch.mock.calls.find(([u]: [string]) =>
            String(u).includes("/messages/send"),
        );
        expect(sendCall).toBeDefined();
        const body = JSON.parse(sendCall![1]!.body as string) as { raw: string; threadId: string };
        expect(body.threadId).toBe("thread-1");
        const decoded = Buffer.from(body.raw, "base64url").toString();
        expect(decoded).toContain("Thanks!");
        expect(decoded).toContain("To: alice@example.com");
    });

    it("should do nothing when credentials are missing", async () => {
        delete process.env["GMAIL_CLIENT_ID"];
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GmailConnector().executeAction({ kind: "reply", sourceId: "msg1", body: "Hi" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should ignore non-reply actions", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GmailConnector().executeAction({ kind: "complete", sourceId: "msg1" });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
