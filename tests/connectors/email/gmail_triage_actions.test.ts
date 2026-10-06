import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";
import type { AcediaEvent } from "../../../source/types/acedia_event.js";

// Spam, follow-up (star) and labels: label mutations at the source, like archive.

interface Call {
    url: string;
    method: string;
    body: unknown;
}

function gmail(labels: Array<{ id: string; name: string }> = []): { calls: Call[] } {
    const calls: Call[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            const method = opts?.method ?? "GET";
            const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
            calls.push({ url: u, method, body });
            if (u.endsWith("/labels") && method === "GET")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ labels }) });
            if (u.endsWith("/labels") && method === "POST")
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({ id: "Label_new", name: (body as { name: string }).name }),
                });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
    );
    return { calls };
}

const modifies = (calls: Call[]) => calls.filter((c) => c.url.includes("/modify"));

describe("GmailConnector — spam, star and labels", () => {
    beforeEach(() => {
        clearTokenCache();
        process.env["GMAIL_CLIENT_ID"] = "cid";
        process.env["GMAIL_CLIENT_SECRET"] = "csec";
        process.env["GMAIL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("mark_spam moves the mail to spam, out of the inbox", async () => {
        const { calls } = gmail();
        await new GmailConnector().executeAction({ kind: "mark_spam", sourceId: "m1" });
        expect(modifies(calls)).toEqual([
            expect.objectContaining({
                url: expect.stringContaining("/messages/m1/modify"),
                body: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
            }),
        ]);
    });

    it("unmark_spam brings it back to the inbox", async () => {
        const { calls } = gmail();
        await new GmailConnector().executeAction({ kind: "unmark_spam", sourceId: "m1" });
        expect(modifies(calls)[0]!.body).toEqual({
            addLabelIds: ["INBOX"],
            removeLabelIds: ["SPAM"],
        });
    });

    it("star_email and unstar_email set and clear the star", async () => {
        const { calls } = gmail();
        const c = new GmailConnector();
        await c.executeAction({ kind: "star_email", sourceId: "m1" });
        await c.executeAction({ kind: "unstar_email", sourceId: "m1" });
        expect(modifies(calls).map((m) => m.body)).toEqual([
            { addLabelIds: ["STARRED"] },
            { removeLabelIds: ["STARRED"] },
        ]);
    });

    it("label_email uses an existing label, matched by name whatever the case", async () => {
        const { calls } = gmail([{ id: "Label_7", name: "Factures" }]);
        await new GmailConnector().executeAction({
            kind: "label_email",
            sourceId: "m1",
            label: "factures",
        });
        expect(calls.some((c) => c.url.endsWith("/labels") && c.method === "POST")).toBe(false);
        expect(modifies(calls)[0]!.body).toEqual({ addLabelIds: ["Label_7"] });
    });

    it("label_email creates the label when Gmail has none by that name", async () => {
        const { calls } = gmail();
        await new GmailConnector().executeAction({
            kind: "label_email",
            sourceId: "m1",
            label: "Pubs",
        });
        const created = calls.find((c) => c.url.endsWith("/labels") && c.method === "POST");
        expect(created?.body).toEqual({ name: "Pubs" });
        expect(modifies(calls)[0]!.body).toEqual({ addLabelIds: ["Label_new"] });
    });

    it("unlabel_email removes the label, and does nothing when it does not exist", async () => {
        const { calls } = gmail([{ id: "Label_7", name: "Factures" }]);
        const c = new GmailConnector();
        await c.executeAction({ kind: "unlabel_email", sourceId: "m1", label: "Factures" });
        await c.executeAction({ kind: "unlabel_email", sourceId: "m1", label: "Inconnu" });
        expect(modifies(calls).map((m) => m.body)).toEqual([{ removeLabelIds: ["Label_7"] }]);
        expect(calls.some((c) => c.url.endsWith("/labels") && c.method === "POST")).toBe(false);
    });

    it("the « spam » gesture moves the mail to spam and takes it out of the box", async () => {
        const { calls } = gmail();
        const event = {
            dedupeKey: "email-m1",
            meta: { messageId: "m1" },
        } as unknown as AcediaEvent;
        const result = await new GmailConnector().inboxGesture("spam", event);
        expect(result).toEqual({ change: "removed" });
        expect(modifies(calls)[0]!.body).toEqual({
            addLabelIds: ["SPAM"],
            removeLabelIds: ["INBOX"],
        });
    });
});
