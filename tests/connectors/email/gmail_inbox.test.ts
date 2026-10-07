import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";
import type { AcediaEvent } from "../../../source/types/acedia_event.js";

// The inbox follows Gmail's own inbox: read and unread mail, and what happens at the source.

const NOW = Date.now();
const FRESH = String(NOW - 1_000);

interface FakeMail {
    id: string;
    labels: string[];
    subject?: string;
    body?: string;
    status?: number;
    /** Older than the bounded listing: in the inbox, but not returned by the list queries. */
    beyondListing?: boolean;
}

/** A small fake of the Gmail REST API: list queries, metadata/minimal/full gets, and the mutations. */
function fakeGmail(mails: FakeMail[]) {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        calls.push({ method, url: u });
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
            });
        }
        if (u.includes("/messages?q=")) {
            const q = decodeURIComponent(u.slice(u.indexOf("q=") + 2).split("&")[0]!);
            const inInbox = mails.filter((m) => m.labels.includes("INBOX") && !m.beyondListing);
            const listed = q.includes("is:unread")
                ? inInbox.filter((m) => m.labels.includes("UNREAD"))
                : inInbox;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ messages: listed.map((m) => ({ id: m.id })) }),
            });
        }
        const mail = mails.find((m) => u.includes(`/messages/${m.id}`));
        if (!mail || mail.status === 404)
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        if (method === "POST")
            return Promise.resolve({
                ok: true,
                status: 200,
                text: () => Promise.resolve(""),
                json: () => Promise.resolve({}),
            });
        const full = u.includes("format=full");
        return Promise.resolve({
            ok: true,
            json: () =>
                Promise.resolve({
                    id: mail.id,
                    threadId: `t-${mail.id}`,
                    internalDate: FRESH,
                    snippet: "snippet",
                    labelIds: mail.labels,
                    payload: full
                        ? {
                              mimeType: "multipart/alternative",
                              headers: [],
                              parts: [
                                  {
                                      mimeType: "text/plain",
                                      body: {
                                          data: Buffer.from(mail.body ?? "").toString("base64url"),
                                      },
                                  },
                                  {
                                      mimeType: "text/html",
                                      body: {
                                          data: Buffer.from("<p>html</p>").toString("base64url"),
                                      },
                                  },
                              ],
                          }
                        : {
                              headers: [
                                  { name: "From", value: "paul@example.com" },
                                  { name: "Subject", value: mail.subject ?? "Hello" },
                              ],
                          },
                }),
        });
    });
    return { fetchImpl, calls };
}

function event(id: string, read = false): AcediaEvent {
    return {
        type: "email.received",
        ts: NOW,
        source: "email",
        title: id,
        priority: "normal",
        dedupeKey: `email-${id}`,
        meta: { messageId: id },
        read,
    };
}

beforeEach(() => {
    clearTokenCache();
    process.env["GMAIL_CLIENT_ID"] = "c";
    process.env["GMAIL_CLIENT_SECRET"] = "s";
    process.env["GMAIL_REFRESH_TOKEN"] = "r";
    process.env["GMAIL_MAX_AGE_HOURS"] = "24";
    process.env["GMAIL_RULES"] = "[]";
});
afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of [
        "GMAIL_CLIENT_ID",
        "GMAIL_CLIENT_SECRET",
        "GMAIL_REFRESH_TOKEN",
        "GMAIL_MAX_AGE_HOURS",
        "GMAIL_RULES",
    ])
        delete process.env[k];
});

describe("GmailConnector — the inbox, read and unread", () => {
    it("collects every mail of the inbox, with its read state from Gmail", async () => {
        const { fetchImpl } = fakeGmail([
            { id: "a", labels: ["INBOX", "UNREAD"] },
            { id: "b", labels: ["INBOX"] },
            { id: "c", labels: ["TRASH"] },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const events = await new GmailConnector().poll();
        expect(events.map((e) => [e.dedupeKey, e.read])).toEqual([
            ["email-a", false],
            ["email-b", true],
        ]);
    });
});

describe("GmailConnector.sourceState — what Gmail says about mail we hold", () => {
    it("reports read, unread and gone (archived, trashed or deleted at the source)", async () => {
        const { fetchImpl } = fakeGmail([
            { id: "a", labels: ["INBOX", "UNREAD"] },
            { id: "b", labels: ["INBOX"] },
            { id: "c", labels: ["TRASH"] },
            { id: "d", labels: [] },
            { id: "e", labels: [], status: 404 },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const state = await new GmailConnector().sourceState(
            ["a", "b", "c", "d", "e"].map((id) => event(id)),
        );
        expect(Object.fromEntries(state!)).toEqual({
            "email-a": "unread",
            "email-b": "read",
            "email-c": "gone",
            "email-d": "gone",
            "email-e": "gone",
        });
    });

    it("checks one by one only what the inbox listing did not show — an older mail is not gone", async () => {
        const { fetchImpl, calls } = fakeGmail([
            { id: "old", labels: ["INBOX"], beyondListing: true },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const state = await new GmailConnector().sourceState([event("old")]);
        expect(state!.get("email-old")).toBe("read");
        expect(
            calls.some((c) => c.url.includes("/messages/old") && c.url.includes("format=minimal")),
        ).toBe(true);
    });

    it("never judges when Gmail cannot be asked — nothing is removed on uncertainty", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new GmailConnector().sourceState([event("a")])).toBeNull();
    });

    it("ignores events that are not Gmail mail", async () => {
        const { fetchImpl } = fakeGmail([{ id: "a", labels: ["INBOX"] }]);
        vi.stubGlobal("fetch", fetchImpl);
        const other: AcediaEvent = { ...event("x"), source: "github", dedupeKey: "gh-x" };
        const state = await new GmailConnector().sourceState([other, event("a")]);
        expect([...state!.keys()]).toEqual(["email-a"]);
    });
});

describe("GmailConnector — opening and restoring a mail", () => {
    it("opens a mail: returns its whole plain-text body and marks it read in Gmail", async () => {
        const { fetchImpl, calls } = fakeGmail([
            { id: "a", labels: ["INBOX", "UNREAD"], body: "Bonjour,\nvoici la facture complète." },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const opened = await new GmailConnector().openMessage("a");
        expect(opened).toEqual({ body: "Bonjour,\nvoici la facture complète." });
        const modify = calls.find(
            (c) => c.method === "POST" && c.url.includes("/messages/a/modify"),
        );
        expect(modify).toBeDefined();
    });

    it("returns null for a mail Gmail no longer has", async () => {
        const { fetchImpl } = fakeGmail([]);
        vi.stubGlobal("fetch", fetchImpl);
        expect(await new GmailConnector().openMessage("nope")).toBeNull();
    });

    it("restores a mail from the trash", async () => {
        const { fetchImpl, calls } = fakeGmail([{ id: "a", labels: ["TRASH"] }]);
        vi.stubGlobal("fetch", fetchImpl);
        await new GmailConnector().restoreMessage("a");
        expect(
            calls.some((c) => c.method === "POST" && c.url.includes("/messages/a/untrash")),
        ).toBe(true);
    });
});

describe("GmailConnector.inboxGesture — Master's own gestures, applied in Gmail", () => {
    const cases: [string, string, string | null][] = [
        ["read", "/messages/a/modify", "read"],
        ["archive", "/messages/a/modify", "removed"],
        ["trash", "/messages/a/trash", "removed"],
    ];
    for (const [gesture, path, change] of cases) {
        it(`${gesture} acts in Gmail and reports the change "${change}"`, async () => {
            const { fetchImpl, calls } = fakeGmail([{ id: "a", labels: ["INBOX", "UNREAD"] }]);
            vi.stubGlobal("fetch", fetchImpl);
            const r = await new GmailConnector().inboxGesture(gesture as "read", event("a"));
            expect(r.change).toBe(change);
            expect(calls.some((c) => c.method === "POST" && c.url.includes(path))).toBe(true);
        });
    }

    it("open returns the whole body and reports the mail read", async () => {
        const { fetchImpl } = fakeGmail([
            { id: "a", labels: ["INBOX", "UNREAD"], body: "Texte intégral" },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const r = await new GmailConnector().inboxGesture("open", event("a"));
        expect(r).toEqual({ change: "read", body: "Texte intégral" });
    });

    it("refuses a gesture that has no meaning for a mail", async () => {
        await expect(new GmailConnector().inboxGesture("done", event("a"))).rejects.toThrow();
    });

    it("lists the trash, most recent first, and restores from it", async () => {
        const { fetchImpl, calls } = fakeGmail([
            { id: "t1", labels: ["TRASH"], subject: "Vieille pub" },
            { id: "a", labels: ["INBOX"] },
        ]);
        fetchImpl.mockImplementation(
            ((orig) => (url: string, init?: { method?: string }) =>
                String(url).includes("/messages?q=") &&
                decodeURIComponent(String(url)).includes("in:trash")
                    ? Promise.resolve({
                          ok: true,
                          json: () => Promise.resolve({ messages: [{ id: "t1" }] }),
                      })
                    : orig(url, init))(fetchImpl.getMockImplementation()!),
        );
        vi.stubGlobal("fetch", fetchImpl);
        const trash = await new GmailConnector().listTrash();
        expect(trash.items).toEqual([
            expect.objectContaining({ id: "t1", title: "Vieille pub", from: "paul@example.com" }),
        ]);
        await new GmailConnector().restoreMessage("t1");
        expect(calls.some((c) => c.url.includes("/messages/t1/untrash"))).toBe(true);
    });
});

// Live NAS check 2026-09-28: listTrash read each trashed mail one after the other — 18.7 s for a real
// trash, past the Core's proxy timeout, so the panel's Corbeille answered 502.
describe("GmailConnector.listTrash — reads the trash in parallel, in Gmail's order", () => {
    it("fetches several trashed mails at once and keeps their order", async () => {
        const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
        const { fetchImpl } = fakeGmail(ids.map((id) => ({ id, labels: ["TRASH"], subject: id })));
        const base = fetchImpl.getMockImplementation()!;
        let inFlight = 0;
        let maxInFlight = 0;
        fetchImpl.mockImplementation(async (url: string, init?: { method?: string }) => {
            const u = decodeURIComponent(String(url));
            if (u.includes("/messages?q=") && u.includes("in:trash"))
                return {
                    ok: true,
                    json: () => Promise.resolve({ messages: ids.map((id) => ({ id })) }),
                };
            if (!u.includes("/messages/")) return base(url, init);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight--;
            return base(url, init);
        });
        vi.stubGlobal("fetch", fetchImpl);

        const trash = await new GmailConnector().listTrash();

        expect(trash.items.map((t) => t.id)).toEqual(ids);
        expect(maxInFlight).toBeGreaterThan(1);
    });
});

// 2026-10-07: the trash was read whole (up to 500 mails, each read one by one) — slow at 300, cut
// without a word past 500, and an unreadable mail vanished from the list.
describe("GmailConnector.listTrash — one page at a time, nothing hidden", () => {
    function trashFetch(answer: (u: string) => unknown) {
        const { fetchImpl } = fakeGmail([
            { id: "t1", labels: ["TRASH"], subject: "Un" },
            { id: "gone", labels: ["TRASH"], status: 404 },
        ]);
        const base = fetchImpl.getMockImplementation()!;
        const urls: string[] = [];
        fetchImpl.mockImplementation((url: string, init?: { method?: string }) => {
            const u = decodeURIComponent(String(url));
            if (u.includes("/messages?q=") && u.includes("in:trash")) {
                urls.push(u);
                return Promise.resolve(answer(u));
            }
            return base(url, init);
        });
        vi.stubGlobal("fetch", fetchImpl);
        return urls;
    }

    it("reads a page of 50 and gives the token of the next one", async () => {
        const urls = trashFetch(() => ({
            ok: true,
            json: () => Promise.resolve({ messages: [{ id: "t1" }], nextPageToken: "p2" }),
        }));
        const page = await new GmailConnector().listTrash("p1");
        expect(urls[0]).toContain("maxResults=50");
        expect(urls[0]).toContain("pageToken=p1");
        expect(page.next).toBe("p2");
        expect(page.items.map((t) => t.id)).toEqual(["t1"]);
    });

    it("counts a mail it could not read instead of hiding it", async () => {
        trashFetch(() => ({
            ok: true,
            json: () => Promise.resolve({ messages: [{ id: "t1" }, { id: "gone" }] }),
        }));
        const page = await new GmailConnector().listTrash();
        expect(page.items.map((t) => t.id)).toEqual(["t1"]);
        expect(page.skipped).toBe(1);
        expect(page.next).toBeUndefined();
    });

    it("keeps Google's reason when the listing is refused", async () => {
        trashFetch(() => ({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
        }));
        await expect(new GmailConnector().listTrash()).rejects.toThrow(/403 \(rateLimitExceeded\)/);
    });
});
