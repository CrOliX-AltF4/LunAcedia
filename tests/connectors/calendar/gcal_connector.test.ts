import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GcalConnector } from "../../../source/connectors/calendar/gcal_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

const START = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const END = new Date(Date.now() + 90 * 60 * 1_000).toISOString();

function calEvent(id: string, summary?: string, extra?: Record<string, unknown>) {
    return {
        id,
        summary,
        start: { dateTime: START },
        end: { dateTime: END },
        htmlLink: `https://calendar.google.com/event/${id}`,
        ...extra,
    };
}

function makeFetch(events: object[], calId = "primary") {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
            });
        }
        if (u.includes(`/calendars/${encodeURIComponent(calId)}/events`)) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: events }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
    });
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GCAL_CLIENT_ID"] = "client-id";
    process.env["GCAL_CLIENT_SECRET"] = "client-secret";
    process.env["GCAL_REFRESH_TOKEN"] = "refresh-token";
    process.env["GCAL_CALENDARS"] = '["primary"]';
    process.env["GCAL_LOOKAHEAD_HOURS"] = "24";
});

afterEach(() => {
    vi.unstubAllGlobals();
    [
        "GCAL_CLIENT_ID",
        "GCAL_CLIENT_SECRET",
        "GCAL_REFRESH_TOKEN",
        "GCAL_CALENDARS",
        "GCAL_LOOKAHEAD_HOURS",
        "GCAL_PRIORITY",
    ].forEach((k) => delete process.env[k]);
});

describe("GcalConnector", () => {
    it("should return empty array when credentials are missing", async () => {
        delete process.env["GCAL_CLIENT_ID"];
        expect(await new GcalConnector().poll()).toHaveLength(0);
    });

    it("should return events from primary calendar", async () => {
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "Team Sync")]));
        const events = await new GcalConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.title).toBe("Team Sync");
        expect(events[0]!.source).toBe("calendar");
        expect(events[0]!.type).toBe("calendar.upcoming");
    });

    it("should set dedupeKey with cal- prefix", async () => {
        vi.stubGlobal("fetch", makeFetch([calEvent("abc123", "Meeting")]));
        const events = await new GcalConnector().poll();
        expect(events[0]!.dedupeKey).toBe("cal-abc123");
    });

    it("should include meta with calendarId and start/end", async () => {
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "Standup")]));
        const events = await new GcalConnector().poll();
        expect(events[0]!.meta?.["calendarId"]).toBe("primary");
        expect(events[0]!.meta?.["start"]).toBe(START);
        expect(events[0]!.meta?.["end"]).toBe(END);
    });

    it("should default to normal priority", async () => {
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "Meeting")]));
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("normal");
    });

    it("should respect GCAL_PRIORITY env override", async () => {
        process.env["GCAL_PRIORITY"] = "urgent";
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "All-hands")]));
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("urgent");
    });

    it("should use (no title) for events without summary", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "ev1", start: { dateTime: START }, end: { dateTime: END } }]),
        );
        const events = await new GcalConnector().poll();
        expect(events[0]!.title).toBe("(no title)");
    });

    it("should truncate description to 200 chars", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([calEvent("ev1", "Mtg", { description: "x".repeat(300) })]),
        );
        const events = await new GcalConnector().poll();
        expect(events[0]!.body).toHaveLength(200);
    });

    it("should return empty array when token refresh fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new GcalConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when calendar returns non-ok", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("oauth2.googleapis.com")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                }
                return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
            }),
        );
        expect(await new GcalConnector().poll()).toHaveLength(0);
    });

    it("should handle empty event list", async () => {
        vi.stubGlobal("fetch", makeFetch([]));
        expect(await new GcalConnector().poll()).toHaveLength(0);
    });

    it("should expose name and preferredPollIntervalMs", () => {
        const c = new GcalConnector();
        expect(c.name).toBe("GCal");
        expect(c.preferredPollIntervalMs).toBeGreaterThan(0);
    });

    it("should include eventId in meta", async () => {
        vi.stubGlobal("fetch", makeFetch([calEvent("ev-xyz", "Meeting")]));
        const events = await new GcalConnector().poll();
        expect(events[0]!.meta?.["eventId"]).toBe("ev-xyz");
        expect(events[0]!.meta?.["calendarId"]).toBe("primary");
    });

    it("should poll multiple calendars and merge results", async () => {
        process.env["GCAL_CALENDARS"] = '["primary","work@group.calendar.google.com"]';
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes("oauth2.googleapis.com")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                }
                if (u.includes(encodeURIComponent("work@group.calendar.google.com"))) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ items: [calEvent("ev2", "Work Meeting")] }),
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ items: [calEvent("ev1", "Personal")] }),
                });
            }),
        );
        const events = await new GcalConnector().poll();
        expect(events).toHaveLength(2);
        expect(events.map((e) => e.title).sort()).toEqual(["Personal", "Work Meeting"]);
    });
});

describe("GcalConnector.executeAction — update", () => {
    beforeEach(() => {
        clearGoogleTokenCache();
        process.env["GCAL_CLIENT_ID"] = "cid";
        process.env["GCAL_CLIENT_SECRET"] = "csec";
        process.env["GCAL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("should PATCH the event with mapped fields", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "PATCH")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "update",
            sourceId: "primary/event-123",
            fields: { title: "New Title", description: "New desc" },
        });
        const patchCall = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "PATCH",
        );
        expect(patchCall).toBeDefined();
        expect(String(patchCall![0]!)).toContain("primary");
        expect(String(patchCall![0]!)).toContain("event-123");
        const body = JSON.parse(patchCall![1]!.body as string) as Record<string, string>;
        expect(body["summary"]).toBe("New Title");
        expect(body["description"]).toBe("New desc");
    });

    it("should warn and return when sourceId has no slash", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({ kind: "update", sourceId: "bad-id", fields: {} });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should ignore non-update actions", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({ kind: "complete", sourceId: "primary/ev1" });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
