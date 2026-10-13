import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GcalConnector } from "../../../source/connectors/calendar/gcal_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

const FROM = Date.parse("2026-10-06T00:00:00Z");
const TO = Date.parse("2027-01-11T00:00:00Z");

type Page = { items?: object[]; nextPageToken?: string };

/** Answers each calendar with its pages (in order); an absent calendar answers 500. */
function makeFetch(byCalendar: Record<string, Page[]>) {
    const served: Record<string, number> = {};
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com"))
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
            });
        const cal = Object.keys(byCalendar).find((c) =>
            u.includes(`/calendars/${encodeURIComponent(c)}/events`),
        );
        if (!cal)
            return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        const n = served[cal] ?? 0;
        served[cal] = n + 1;
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(byCalendar[cal]![n] ?? {}),
        });
    });
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GCAL_CLIENT_ID"] = "client-id";
    process.env["GCAL_CLIENT_SECRET"] = "client-secret";
    process.env["GCAL_REFRESH_TOKEN"] = "refresh-token";
    process.env["GCAL_CALENDARS"] = '["primary","work"]';
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ["GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN", "GCAL_CALENDARS"].forEach(
        (k) => delete process.env[k],
    );
});

describe("GcalConnector.readPlanning", () => {
    it("reads every calendar over the period as planning objects", async () => {
        const fetchMock = makeFetch({
            primary: [
                {
                    items: [
                        {
                            id: "e1",
                            summary: "Dentiste",
                            start: { dateTime: "2026-10-20T10:00:00+02:00" },
                            end: { dateTime: "2026-10-20T11:00:00+02:00" },
                            location: "Lyon",
                            htmlLink: "https://calendar.google.com/e1",
                            updated: "2026-10-01T08:00:00Z",
                        },
                        {
                            id: "e2_20261021",
                            summary: "Sport",
                            recurringEventId: "e2",
                            start: { date: "2026-10-21" },
                            end: { date: "2026-10-22" },
                        },
                    ],
                },
            ],
            work: [
                {
                    items: [
                        {
                            id: "w1",
                            start: { dateTime: "2026-10-22T09:00:00Z" },
                            end: { dateTime: "2026-10-22T10:00:00Z" },
                        },
                    ],
                },
            ],
        });
        vi.stubGlobal("fetch", fetchMock);

        const events = await new GcalConnector().readPlanning(FROM, TO);

        expect(events).toEqual([
            {
                id: "primary/e1",
                calendarId: "primary",
                title: "Dentiste",
                start: "2026-10-20T10:00:00+02:00",
                end: "2026-10-20T11:00:00+02:00",
                allDay: false,
                location: "Lyon",
                recurring: false,
                url: "https://calendar.google.com/e1",
                updatedAt: Date.parse("2026-10-01T08:00:00Z"),
            },
            {
                id: "primary/e2_20261021",
                calendarId: "primary",
                title: "Sport",
                start: "2026-10-21",
                end: "2026-10-22",
                allDay: true,
                recurring: true,
                updatedAt: 0,
            },
            {
                id: "work/w1",
                calendarId: "work",
                title: "(sans titre)",
                start: "2026-10-22T09:00:00Z",
                end: "2026-10-22T10:00:00Z",
                allDay: false,
                recurring: false,
                updatedAt: 0,
            },
        ]);
        const asked = fetchMock.mock.calls
            .map((c) => String(c[0]))
            .find((u) => u.includes("/calendars/primary/events"))!;
        expect(asked).toContain(`timeMin=${encodeURIComponent(new Date(FROM).toISOString())}`);
        expect(asked).toContain(`timeMax=${encodeURIComponent(new Date(TO).toISOString())}`);
    });

    it("follows the pages", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch({
                primary: [
                    {
                        items: [
                            {
                                id: "a",
                                start: { dateTime: "2026-10-20T10:00:00Z" },
                                end: { dateTime: "2026-10-20T11:00:00Z" },
                            },
                        ],
                        nextPageToken: "p2",
                    },
                    {
                        items: [
                            {
                                id: "b",
                                start: { dateTime: "2026-10-21T10:00:00Z" },
                                end: { dateTime: "2026-10-21T11:00:00Z" },
                            },
                        ],
                    },
                ],
                work: [{ items: [] }],
            }),
        );
        expect((await new GcalConnector().readPlanning(FROM, TO))!.map((e) => e.id)).toEqual([
            "primary/a",
            "primary/b",
        ]);
    });

    it("leaves cancelled occurrences out", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch({
                primary: [
                    {
                        items: [
                            {
                                id: "x",
                                status: "cancelled",
                                start: { dateTime: "2026-10-20T10:00:00Z" },
                                end: { dateTime: "2026-10-20T11:00:00Z" },
                            },
                        ],
                    },
                ],
                work: [{ items: [] }],
            }),
        );
        expect(await new GcalConnector().readPlanning(FROM, TO)).toEqual([]);
    });

    it("is null when one calendar cannot be read — never a partial picture", async () => {
        vi.stubGlobal("fetch", makeFetch({ primary: [{ items: [] }] })); // "work" answers 500
        expect(await new GcalConnector().readPlanning(FROM, TO)).toBeNull();
    });

    it("is null when a calendar has more pages than are read", async () => {
        const endless = Array.from({ length: 11 }, (_, i) => ({
            items: [],
            nextPageToken: `p${i + 1}`,
        }));
        vi.stubGlobal("fetch", makeFetch({ primary: endless, work: [{ items: [] }] }));
        expect(await new GcalConnector().readPlanning(FROM, TO)).toBeNull();
    });

    it("is null when not configured", async () => {
        delete process.env["GCAL_REFRESH_TOKEN"];
        expect(await new GcalConnector().readPlanning(FROM, TO)).toBeNull();
    });
});
