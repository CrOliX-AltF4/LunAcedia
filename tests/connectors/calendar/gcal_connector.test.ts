import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GcalConnector } from "../../../source/connectors/calendar/gcal_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";
import { GoogleTokenStore } from "../../../source/auth/google_token_store.js";

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
        "GCAL_URGENT_WITHIN_MIN",
    ].forEach((k) => delete process.env[k]);
});

describe("GcalConnector", () => {
    it("should return empty array when credentials are missing", async () => {
        delete process.env["GCAL_CLIENT_ID"];
        expect(await new GcalConnector().poll()).toHaveLength(0);
    });

    it("should warn at construction time when credentials are missing", () => {
        delete process.env["GCAL_CLIENT_ID"];
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new GcalConnector();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GCAL_ENABLED=true"));
        warnSpy.mockRestore();
    });

    it("should not warn at construction time when credentials are present", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new GcalConnector();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
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
        expect(c.name).toBe("Calendar");
        expect(c.slug).toBe("calendar");
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
        // "Personal" (primary) and "Work Meeting" (work calendar) share the same fixture
        // START/END, so — correctly — a 3rd synthetic conflict event is now emitted too
        // (cross-calendar overlap detection, see gcal_connector.ts's detectConflicts()).
        expect(events).toHaveLength(3);
        const upcoming = events.filter((e) => e.type === "calendar.upcoming");
        expect(upcoming.map((e) => e.title).sort()).toEqual(["Personal", "Work Meeting"]);
        const conflict = events.find((e) => e.type === "calendar.conflict");
        expect(conflict?.priority).toBe("urgent");
    });
});

describe("GcalConnector — GoogleTokenStore", () => {
    it("prefers a stored refresh token over GCAL_REFRESH_TOKEN once one exists", async () => {
        delete process.env["GCAL_REFRESH_TOKEN"]; // no static fallback — proves the store alone is enough
        const tokenStore = new GoogleTokenStore("/tmp/does-not-matter.json");
        await tokenStore.set("gcal", "rt-from-oauth-flow");
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "Meeting")]));
        const events = await new GcalConnector(tokenStore).poll();
        expect(events.length).toBeGreaterThan(0);
    });

    it("still returns nothing when neither the store nor GCAL_REFRESH_TOKEN has a token", async () => {
        delete process.env["GCAL_REFRESH_TOKEN"];
        const tokenStore = new GoogleTokenStore("/tmp/does-not-matter.json");
        const events = await new GcalConnector(tokenStore).poll();
        expect(events).toHaveLength(0);
    });
});

describe("GcalConnector — time-proximity urgent escalation", () => {
    it("escalates to urgent when the event starts within GCAL_URGENT_WITHIN_MIN", async () => {
        process.env["GCAL_PRIORITY"] = "info";
        process.env["GCAL_URGENT_WITHIN_MIN"] = "10";
        const soonStart = new Date(Date.now() + 5 * 60_000).toISOString();
        const soonEnd = new Date(Date.now() + 35 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "ev1",
                    summary: "Standup",
                    start: { dateTime: soonStart },
                    end: { dateTime: soonEnd },
                },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("urgent");
    });

    it("keeps GCAL_PRIORITY as the floor when the event is further out than the escalation window", async () => {
        process.env["GCAL_PRIORITY"] = "info";
        process.env["GCAL_URGENT_WITHIN_MIN"] = "10";
        vi.stubGlobal("fetch", makeFetch([calEvent("ev1", "Later")])); // default fixture starts in 60 min
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("info");
    });

    it("does not escalate a past-start event that is still open (msUntil negative)", async () => {
        process.env["GCAL_PRIORITY"] = "normal";
        process.env["GCAL_URGENT_WITHIN_MIN"] = "10";
        const pastStart = new Date(Date.now() - 5 * 60_000).toISOString();
        const futureEnd = new Date(Date.now() + 25 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "ev1",
                    summary: "In progress",
                    start: { dateTime: pastStart },
                    end: { dateTime: futureEnd },
                },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("normal");
    });

    it("GCAL_URGENT_WITHIN_MIN=0 disables escalation entirely", async () => {
        process.env["GCAL_PRIORITY"] = "info";
        process.env["GCAL_URGENT_WITHIN_MIN"] = "0";
        const soonStart = new Date(Date.now() + 1 * 60_000).toISOString();
        const soonEnd = new Date(Date.now() + 30 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "ev1",
                    summary: "ASAP",
                    start: { dateTime: soonStart },
                    end: { dateTime: soonEnd },
                },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events[0]!.priority).toBe("info");
    });
});

describe("GcalConnector — conflict detection", () => {
    it("emits a calendar.conflict event when two timed events on the same calendar overlap", async () => {
        const s1 = new Date(Date.now() + 60 * 60_000).toISOString();
        const e1 = new Date(Date.now() + 120 * 60_000).toISOString();
        const s2 = new Date(Date.now() + 90 * 60_000).toISOString(); // starts before e1 — overlaps
        const e2 = new Date(Date.now() + 150 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "ev1", summary: "A", start: { dateTime: s1 }, end: { dateTime: e1 } },
                { id: "ev2", summary: "B", start: { dateTime: s2 }, end: { dateTime: e2 } },
            ]),
        );
        const events = await new GcalConnector().poll();
        const conflicts = events.filter((e) => e.type === "calendar.conflict");
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]!.title).toContain("A");
        expect(conflicts[0]!.title).toContain("B");
        expect(conflicts[0]!.meta).toEqual({ eventAId: "ev1", eventBId: "ev2" });
    });

    it("does not flag back-to-back events that only touch (A ends exactly when B starts)", async () => {
        const s1 = new Date(Date.now() + 60 * 60_000).toISOString();
        const e1 = new Date(Date.now() + 120 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "ev1", summary: "A", start: { dateTime: s1 }, end: { dateTime: e1 } },
                {
                    id: "ev2",
                    summary: "B",
                    start: { dateTime: e1 },
                    end: { dateTime: new Date(Date.now() + 150 * 60_000).toISOString() },
                },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events.filter((e) => e.type === "calendar.conflict")).toHaveLength(0);
    });

    it("excludes all-day events from conflict detection", async () => {
        const s1 = new Date(Date.now() + 60 * 60_000).toISOString();
        const e1 = new Date(Date.now() + 120 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "ev1",
                    summary: "Timed meeting",
                    start: { dateTime: s1 },
                    end: { dateTime: e1 },
                },
                {
                    id: "ev2",
                    summary: "Vacation",
                    start: { date: "2026-08-20" },
                    end: { date: "2026-08-25" },
                },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events.filter((e) => e.type === "calendar.conflict")).toHaveLength(0);
    });

    it("does not flag two non-overlapping events", async () => {
        const s1 = new Date(Date.now() + 60 * 60_000).toISOString();
        const e1 = new Date(Date.now() + 90 * 60_000).toISOString();
        const s2 = new Date(Date.now() + 180 * 60_000).toISOString();
        const e2 = new Date(Date.now() + 210 * 60_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([
                { id: "ev1", summary: "A", start: { dateTime: s1 }, end: { dateTime: e1 } },
                { id: "ev2", summary: "B", start: { dateTime: s2 }, end: { dateTime: e2 } },
            ]),
        );
        const events = await new GcalConnector().poll();
        expect(events.filter((e) => e.type === "calendar.conflict")).toHaveLength(0);
    });
});

describe("GcalConnector.executeAction — update_event / create_event / delete_event", () => {
    beforeEach(() => {
        clearGoogleTokenCache();
        process.env["GCAL_CLIENT_ID"] = "cid";
        process.env["GCAL_CLIENT_SECRET"] = "csec";
        process.env["GCAL_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("update_event: should PATCH the event with mapped fields", async () => {
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
            kind: "update_event",
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

    it("update_event: should warn and return when sourceId has no slash", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "update_event",
            sourceId: "bad-id",
            fields: {},
        });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should ignore action kinds it doesn't own", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({ kind: "complete_task", sourceId: "primary/ev1" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("create_event: POSTs a new event with the given fields to the target calendar", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "POST")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "create_event",
            fields: {
                summary: "New meeting",
                start: "2026-09-01T10:00:00Z",
                end: "2026-09-01T10:30:00Z",
            },
        });
        const postCall = mockFetch.mock.calls.find(
            ([u, o]: [string, RequestInit]) =>
                o?.method === "POST" && !String(u).includes("oauth2"),
        );
        expect(postCall).toBeDefined();
        expect(String(postCall![0]!)).toContain("primary");
        const body = JSON.parse(postCall![1]!.body as string) as {
            summary: string;
            start: { dateTime: string };
        };
        expect(body.summary).toBe("New meeting");
        expect(body.start.dateTime).toBe("2026-09-01T10:00:00Z");
    });

    it("create_event: uses fields.calendarId when given instead of primary", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "POST")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "create_event",
            fields: {
                summary: "Team sync",
                start: "2026-09-01T10:00:00Z",
                end: "2026-09-01T10:30:00Z",
                calendarId: "work@group.calendar.google.com",
            },
        });
        const postCall = mockFetch.mock.calls.find(
            ([u, o]: [string, RequestInit]) =>
                o?.method === "POST" && !String(u).includes("oauth2"),
        );
        expect(String(postCall![0]!)).toContain(
            encodeURIComponent("work@group.calendar.google.com"),
        );
    });

    it("delete_event: DELETEs the event at {calendarId}/{eventId}", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "DELETE")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "delete_event",
            sourceId: "primary/event-999",
        });
        const delCall = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "DELETE",
        );
        expect(delCall).toBeDefined();
        expect(String(delCall![0]!)).toContain("event-999");
    });

    it("delete_event: treats 410 (already deleted) as success, not a warning", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "DELETE")
                return Promise.resolve({ ok: false, status: 410, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new GcalConnector().executeAction({
            kind: "delete_event",
            sourceId: "primary/event-999",
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
