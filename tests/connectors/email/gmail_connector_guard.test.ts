import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";

const FRESH_TS = String(Date.now() - 1_000);

interface FakeMessage {
    id: string;
    from: string;
    subject: string;
    labelIds?: string[];
    listUnsubscribe?: string;
}

function makeFetch(messages: FakeMessage[]) {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }) });
        }
        if (u.includes("/messages?q=")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: messages.map((m) => ({ id: m.id })) }) });
        }
        const msg = messages.find((m) => u.includes(`/messages/${m.id}`));
        if (!msg) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        const headers = [
            { name: "From", value: msg.from },
            { name: "Subject", value: msg.subject },
            ...(msg.listUnsubscribe ? [{ name: "List-Unsubscribe", value: msg.listUnsubscribe }] : []),
        ];
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: msg.id, threadId: `t-${msg.id}`, internalDate: FRESH_TS, labelIds: msg.labelIds, payload: { headers } }),
        });
    });
}

const metadataCalls = (fetchMock: ReturnType<typeof makeFetch>) =>
    fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("format=metadata"));

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
    for (const k of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_MAX_AGE_HOURS", "GMAIL_RULES"]) delete process.env[k];
});

describe("GmailConnector — data for the ingestion guards", () => {
    it("exposes Gmail's labels and the List-Unsubscribe header as neutral event meta", async () => {
        vi.stubGlobal("fetch", makeFetch([
            { id: "promo", from: "Deals <deals@mail.shop.com>", subject: "-50 %", labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], listUnsubscribe: "<mailto:unsub@shop.com>" },
        ]));
        const [event] = await new GmailConnector().poll();
        expect(event!.meta).toMatchObject({
            from: "Deals <deals@mail.shop.com>",
            messageId: "promo",
            labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
            headers: { "list-unsubscribe": "<mailto:unsub@shop.com>" },
        });
    });

    it("falls back to no labels and no headers when Gmail returns none", async () => {
        vi.stubGlobal("fetch", makeFetch([{ id: "plain", from: "a@b.c", subject: "Hi" }]));
        const [event] = await new GmailConnector().poll();
        expect(event!.meta).toMatchObject({ labels: [], headers: {} });
    });

    it("asks Gmail for the List-Unsubscribe header on the existing per-message call (no extra request)", async () => {
        const fetchMock = makeFetch([{ id: "m1", from: "a@b.c", subject: "Hi" }]);
        vi.stubGlobal("fetch", fetchMock);
        await new GmailConnector().poll();
        const calls = metadataCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("metadataHeaders=List-Unsubscribe");
    });

    it("truncates a very long List-Unsubscribe value", async () => {
        vi.stubGlobal("fetch", makeFetch([{ id: "long", from: "a@b.c", subject: "Hi", listUnsubscribe: "x".repeat(500) }]));
        const [event] = await new GmailConnector().poll();
        expect((event!.meta!["headers"] as Record<string, string>)["list-unsubscribe"]).toHaveLength(200);
    });
});

describe("GmailConnector — settled filter (no re-fetch of what is already decided)", () => {
    it("skips the metadata call for settled keys and still returns the others", async () => {
        const fetchMock = makeFetch([
            { id: "done", from: "a@b.c", subject: "Already handled" },
            { id: "fresh", from: "d@e.f", subject: "New" },
        ]);
        vi.stubGlobal("fetch", fetchMock);
        const connector = new GmailConnector();
        connector.setSettledFilter((key) => key === "email-done");

        const events = await connector.poll();
        expect(events.map((e) => e.dedupeKey)).toEqual(["email-fresh"]);
        const calls = metadataCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("/messages/fresh");
    });

    it("behaves exactly as before when no filter was set", async () => {
        const fetchMock = makeFetch([{ id: "a", from: "x@y.z", subject: "1" }, { id: "b", from: "x@y.z", subject: "2" }]);
        vi.stubGlobal("fetch", fetchMock);
        const events = await new GmailConnector().poll();
        expect(events).toHaveLength(2);
        expect(metadataCalls(fetchMock)).toHaveLength(2);
    });
});
