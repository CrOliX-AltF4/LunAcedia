import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GcalConnector } from "../../../source/connectors/calendar/gcal_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

// Lot AT2: an event can be moved (start and end together), created all-day, and nothing malformed reaches Google.

function okFetch() {
    return vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("oauth2"))
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
            });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
}

function sent(mock: ReturnType<typeof okFetch>, method: string) {
    const call = mock.mock.calls.find(
        ([u, o]: [string, RequestInit]) => o?.method === method && !String(u).includes("oauth2"),
    );
    return call ? { url: String(call[0]), body: JSON.parse(call[1].body as string) } : undefined;
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GCAL_CLIENT_ID"] = "cid";
    process.env["GCAL_CLIENT_SECRET"] = "csec";
    process.env["GCAL_REFRESH_TOKEN"] = "rtoken";
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ["GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN"].forEach(
        (k) => delete process.env[k],
    );
});

describe("GcalConnector — moving and all-day events", () => {
    it("moves an event: start and end, the other form cleared", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new GcalConnector().executeAction({
            kind: "update_event",
            sourceId: "primary/ev1",
            fields: { start: "2026-10-21T15:00:00+02:00", end: "2026-10-21T16:00:00+02:00" },
        });
        expect(sent(f, "PATCH")!.body).toEqual({
            start: { date: null, dateTime: "2026-10-21T15:00:00+02:00" },
            end: { date: null, dateTime: "2026-10-21T16:00:00+02:00" },
        });
    });

    it("turns a timed event into an all-day one", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new GcalConnector().executeAction({
            kind: "update_event",
            sourceId: "primary/ev1",
            fields: { start: "2026-10-21", end: "2026-10-22", title: "Journée off" },
        });
        expect(sent(f, "PATCH")!.body).toEqual({
            summary: "Journée off",
            start: { date: "2026-10-21", dateTime: null },
            end: { date: "2026-10-22", dateTime: null },
        });
    });

    it("creates an all-day event", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new GcalConnector().executeAction({
            kind: "create_event",
            fields: { summary: "Congés", start: "2026-12-24", end: "2026-12-27" },
        });
        expect(sent(f, "POST")!.body).toEqual({
            summary: "Congés",
            start: { date: "2026-12-24" },
            end: { date: "2026-12-27" },
        });
    });

    it.each([
        [{ start: "2026-10-21T15:00:00Z" }, "start and end together"],
        [{ start: "2026-10-21", end: "2026-10-21T16:00:00Z" }, "both be dates or both date-times"],
        [{ start: "2026-10-21T16:00:00Z", end: "2026-10-21T15:00:00Z" }, "end must come after"],
        [{ start: "demain", end: "après-demain" }, "not a date"],
        [{}, "nothing to change"],
    ])("refuses %j before Google is asked", async (fields, message) => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await expect(
            new GcalConnector().executeAction({
                kind: "update_event",
                sourceId: "primary/ev1",
                fields,
            }),
        ).rejects.toThrow(message);
        expect(sent(f, "PATCH")).toBeUndefined();
    });
});
