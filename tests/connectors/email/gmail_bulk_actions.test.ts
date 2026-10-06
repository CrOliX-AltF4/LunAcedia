import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GmailConnector } from "../../../source/connectors/email/gmail_connector.js";
import { clearTokenCache } from "../../../source/connectors/email/gmail_auth.js";

// A batch on frozen ids (ADR-023 T2): one Gmail batchModify for label changes, the trash one mail at a time.

interface Call {
    url: string;
    method: string;
    body: unknown;
}

function gmail(): Call[] {
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
            calls.push({ url: u, method, body: opts?.body ? JSON.parse(String(opts.body)) : undefined });
            if (u.endsWith("/labels") && method === "GET")
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ labels: [{ id: "Label_9", name: "Pubs" }] }),
                });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
    );
    return calls;
}

describe("GmailConnector — bulk_email", () => {
    beforeEach(() => {
        clearTokenCache();
        process.env["GMAIL_CLIENT_ID"] = "cid";
        process.env["GMAIL_CLIENT_SECRET"] = "csec";
        process.env["GMAIL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("reports every frozen mail as spam in one batchModify", async () => {
        const calls = gmail();
        await new GmailConnector().executeAction({
            kind: "bulk_email",
            action: "mark_spam",
            match: { fromContains: "aliexpress" },
            sourceIds: ["1", "2"],
        });
        const batch = calls.filter((c) => c.url.endsWith("/messages/batchModify"));
        expect(batch).toEqual([
            expect.objectContaining({
                body: { ids: ["1", "2"], addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
            }),
        ]);
    });

    it("resolves a label once for the whole batch", async () => {
        const calls = gmail();
        await new GmailConnector().executeAction({
            kind: "bulk_email",
            action: "label_email",
            label: "pubs",
            match: { fromDomain: "pub.com" },
            sourceIds: ["1", "2", "3"],
        });
        expect(calls.filter((c) => c.url.endsWith("/labels"))).toHaveLength(1);
        expect(calls.find((c) => c.url.endsWith("/batchModify"))?.body).toEqual({
            ids: ["1", "2", "3"],
            addLabelIds: ["Label_9"],
        });
    });

    it("trashes mail by mail — Gmail has no batch trash", async () => {
        const calls = gmail();
        await new GmailConnector().executeAction({
            kind: "bulk_email",
            action: "delete_email",
            match: { fromContains: "x" },
            sourceIds: ["1", "2"],
        });
        expect(calls.filter((c) => c.url.endsWith("/trash")).map((c) => c.url).sort()).toEqual([
            expect.stringContaining("/messages/1/trash"),
            expect.stringContaining("/messages/2/trash"),
        ]);
    });

    it("refuses a batch whose ids were never frozen", async () => {
        gmail();
        await expect(
            new GmailConnector().executeAction({ kind: "bulk_email", action: "archive_email", match: { fromContains: "x" } }),
        ).rejects.toThrow(/no mail/);
    });
});
