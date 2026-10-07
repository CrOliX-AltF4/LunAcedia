import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";

const NOW = Date.now();
const FRESH_TS = String(NOW - 1_000);
const OLD_TS = String(NOW - 30 * 3_600_000);

type FakeMessage = {
    id: string;
    from: string;
    subject: string;
    ts: string;
    snippet?: string;
    labels?: string[];
};

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
                        snippet: msg.snippet,
                        ...(msg.labels && { labelIds: msg.labels }),
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

    it("should warn at construction time when credentials are missing", () => {
        delete process.env["GMAIL_CLIENT_ID"];
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new GmailConnector();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GMAIL_ENABLED=true"));
        warnSpy.mockRestore();
    });

    it("should not warn at construction time when credentials are present", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new GmailConnector();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
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

    it("collects a mail older than GMAIL_MAX_AGE_HOURS, flagged as backlog (C7)", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "fresh", from: "a@a.com", subject: "Fresh", ts: FRESH_TS },
                { id: "old", from: "b@b.com", subject: "Old", ts: OLD_TS },
            ]),
        );
        const events = await new GmailConnector().poll();
        const fresh = events.find((e) => e.title === "Fresh");
        const old = events.find((e) => e.title === "Old");
        expect(fresh?.meta?.["backlog"]).toBeUndefined();
        expect(old?.meta?.["backlog"]).toBe(true);
    });

    it("lists the whole inbox page after page, up to GMAIL_MAX_INBOX", async () => {
        process.env["GMAIL_MAX_INBOX"] = "3";
        const listUrls: string[] = [];
        const fetchImpl = vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes("oauth2.googleapis.com"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (u.includes("/messages?q=")) {
                listUrls.push(u);
                const second = u.includes("pageToken=p2");
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve(
                            second
                                ? { messages: [{ id: "m3" }, { id: "m4" }] }
                                : { messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "p2" },
                        ),
                });
            }
            const id = /messages\/(m\d)/.exec(u)?.[1] ?? "";
            return Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        id,
                        internalDate: FRESH_TS,
                        payload: { headers: [{ name: "Subject", value: id }] },
                    }),
            });
        });
        vi.stubGlobal("fetch", fetchImpl);
        const events = await new GmailConnector().poll();
        delete process.env["GMAIL_MAX_INBOX"];
        expect(listUrls).toHaveLength(2);
        expect(events.map((e) => e.title)).toEqual(["m1", "m2", "m3"]);
    });

    // One way to set a priority: the source gives its default, the VIP list and the rules do the rest downstream.
    it("takes Gmail's own « important » as normal, and says why", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "msg1",
                    from: "mairie@ville.fr",
                    subject: "Votre dossier",
                    ts: FRESH_TS,
                    labels: ["INBOX", "IMPORTANT"],
                },
            ]),
        );
        const [e] = await new GmailConnector().poll();
        expect(e).toMatchObject({ priority: "normal", priorityReason: "Gmail : important" });
    });

    it("is info otherwise — GMAIL_RULES is no longer read by the connector", async () => {
        process.env["GMAIL_RULES"] = JSON.stringify([
            { senderPattern: "boss@company.com", priority: "urgent" },
        ]);
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "msg1", from: "boss@company.com", subject: "Urgent matter", ts: FRESH_TS },
            ]),
        );
        const [e] = await new GmailConnector().poll();
        expect(e!.priority).toBe("info");
        expect(e!.priorityReason).toBeUndefined();
    });

    it("should set dedupeKey with email- prefix", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "abc123", from: "x@x.com", subject: "Test", ts: FRESH_TS }]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.dedupeKey).toBe("email-abc123");
    });

    it("should use Gmail's snippet as body, not the sender", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "msg1",
                    from: "alice@example.com",
                    subject: "Hi",
                    ts: FRESH_TS,
                    snippet: "Hey, are we still on for tomorrow?",
                },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.body).toBe("Hey, are we still on for tomorrow?");
    });

    it("should truncate a long snippet to 200 chars", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "msg1",
                    from: "a@a.com",
                    subject: "Hi",
                    ts: FRESH_TS,
                    snippet: "x".repeat(300),
                },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.body).toHaveLength(200);
    });

    it("should leave body undefined when Gmail returns no snippet", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "msg1", from: "a@a.com", subject: "Hi", ts: FRESH_TS }]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.body).toBeUndefined();
    });

    it("still carries the sender in meta.from even though it's no longer the body", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "msg1",
                    from: "alice@example.com",
                    subject: "Hi",
                    ts: FRESH_TS,
                    snippet: "hey",
                },
            ]),
        );
        const events = await new GmailConnector().poll();
        expect(events[0]!.meta?.["from"]).toBe("alice@example.com");
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
        expect(connector.slug).toBe("email");
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

    it("says so when credentials are missing, instead of claiming it was done", async () => {
        delete process.env["GMAIL_CLIENT_ID"];
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "reply", sourceId: "msg1", body: "Hi" }),
        ).rejects.toThrow(/not configured/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses an action kind it doesn't own", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "complete", sourceId: "msg1" }),
        ).rejects.toThrow(/not a mail action/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    // Regression: this used to log-and-swallow the failure, so dispatchAction's own
    // try/catch never saw it and the caller was told the action succeeded.
    it("should throw (not swallow) when the Gmail API rejects the reply send", async () => {
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
                            payload: { headers: [{ name: "From", value: "alice@example.com" }] },
                        }),
                });
            if (u.includes("/messages/send") && opts?.method === "POST")
                return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "reply", sourceId: "msg1", body: "Hi" }),
        ).rejects.toThrow("returned 401");
    });

    it("should throw when fetching the original message for reply fails", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "reply", sourceId: "msg1", body: "Hi" }),
        ).rejects.toThrow("returned 404");
    });
});

describe("GmailConnector.executeAction — archive/delete/mark (modifyMessage)", () => {
    beforeEach(() => {
        clearTokenCache();
        process.env["GMAIL_CLIENT_ID"] = "cid";
        process.env["GMAIL_CLIENT_SECRET"] = "csec";
        process.env["GMAIL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("should throw (not swallow) when the Gmail API rejects an archive_email call", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "archive_email", sourceId: "msg1" }),
        ).rejects.toThrow("returned 403");
    });

    it("should throw when the token fetch itself fails", async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new GmailConnector().executeAction({ kind: "archive_email", sourceId: "msg1" }),
        ).rejects.toThrow("network down");
    });
});
