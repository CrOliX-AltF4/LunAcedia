import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";

const GCAL_API = "https://www.googleapis.com/calendar/v3";

interface CalEvent {
    id: string;
    summary?: string;
    description?: string;
    htmlLink?: string;
    location?: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
}

interface CalListResponse {
    items?: CalEvent[];
}

function parseCalendars(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw) as unknown;
        const arr = Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === "string")
            : [];
        return arr.length > 0 ? arr : ["primary"];
    } catch {
        return ["primary"];
    }
}

/**
 * Polls Google Calendar for upcoming events within a configurable lookahead window.
 *
 * Config:
 *   GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN — OAuth2 credentials
 *   GCAL_CALENDARS='["primary","work@group.calendar.google.com"]' (default: ["primary"])
 *   GCAL_LOOKAHEAD_HOURS=24    — how far ahead to fetch (default 24)
 *   GCAL_POLL_INTERVAL_MIN=15
 *   GCAL_PRIORITY=normal       — priority applied to all events (urgent|normal|info)
 */
export class GcalConnector implements IConnector {
    readonly name = "GCal";
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly refreshToken: string;
    private readonly calendars: string[];
    private readonly lookaheadMs: number;
    private readonly defaultPriority: AcediaEventPriority;

    constructor() {
        this.clientId = process.env["GCAL_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GCAL_CLIENT_SECRET"] ?? "";
        this.refreshToken = process.env["GCAL_REFRESH_TOKEN"] ?? "";

        const intervalMin = parseInt(process.env["GCAL_POLL_INTERVAL_MIN"] ?? "15", 10);
        this.preferredPollIntervalMs = Math.max(5, intervalMin) * 60_000;

        const lookaheadHours = parseInt(process.env["GCAL_LOOKAHEAD_HOURS"] ?? "24", 10);
        this.lookaheadMs = Math.max(1, lookaheadHours) * 3_600_000;

        this.calendars = parseCalendars(process.env["GCAL_CALENDARS"] ?? '["primary"]');

        const raw = process.env["GCAL_PRIORITY"] ?? "normal";
        this.defaultPriority = (
            ["urgent", "normal", "info"].includes(raw) ? raw : "normal"
        ) as AcediaEventPriority;
    }

    async poll(): Promise<AcediaEvent[]> {
        if (!this.clientId || !this.clientSecret || !this.refreshToken) return [];

        let token: string;
        try {
            token = await getGoogleToken(
                this.clientId,
                this.clientSecret,
                this.refreshToken,
                "gcal",
            );
        } catch (e) {
            console.error("[GCal] token refresh error:", (e as Error).message);
            return [];
        }

        const headers = { Authorization: `Bearer ${token}` };
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + this.lookaheadMs).toISOString();

        const results = await Promise.allSettled(
            this.calendars.map((calId) => this.pollCalendar(calId, timeMin, timeMax, headers)),
        );

        return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (action.kind !== "update") return;
        if (!this.clientId || !this.clientSecret || !this.refreshToken) return;

        // sourceId = "{calendarId}/{eventId}"
        const slash = action.sourceId.indexOf("/");
        if (slash === -1) {
            console.warn("[GCal] update: sourceId must be '{calendarId}/{eventId}'");
            return;
        }
        const calId   = action.sourceId.slice(0, slash);
        const eventId = action.sourceId.slice(slash + 1);

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, this.refreshToken, "gcal");
        } catch (e) {
            console.error("[GCal] action token error:", (e as Error).message);
            return;
        }

        // Map generic `fields` to GCal event patch body (summary = title, description = body)
        const patch: Record<string, string> = {};
        if (action.fields["title"])       patch["summary"]     = action.fields["title"];
        if (action.fields["description"]) patch["description"] = action.fields["description"];
        if (action.fields["location"])    patch["location"]     = action.fields["location"];

        try {
            const resp = await fetch(
                `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(patch),
                },
            );
            if (!resp.ok) {
                console.warn(`[GCal] update returned ${resp.status}`);
            }
        } catch (e) {
            console.error("[GCal] update error:", (e as Error).message);
        }
    }

    private async pollCalendar(
        calId: string,
        timeMin: string,
        timeMax: string,
        headers: Record<string, string>,
    ): Promise<AcediaEvent[]> {
        const url =
            `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events` +
            `?timeMin=${encodeURIComponent(timeMin)}` +
            `&timeMax=${encodeURIComponent(timeMax)}` +
            `&singleEvents=true&orderBy=startTime&maxResults=50`;

        let resp: Response;
        try {
            resp = await fetch(url, { headers });
        } catch (e) {
            console.error(`[GCal] fetch error for ${calId}:`, (e as Error).message);
            return [];
        }

        if (!resp.ok) {
            if (resp.status === 401) clearGoogleTokenCache("gcal");
            console.warn(`[GCal] ${calId} returned ${resp.status}`);
            return [];
        }

        const data = (await resp.json()) as CalListResponse;
        const events = data.items ?? [];

        return events.map((ev): AcediaEvent => {
            const startRaw = ev.start.dateTime ?? ev.start.date ?? "";
            const endRaw = ev.end.dateTime ?? ev.end.date ?? "";
            const ts = startRaw ? new Date(startRaw).getTime() : Date.now();

            return {
                type: "calendar.upcoming",
                ts,
                source: "calendar",
                title: ev.summary ?? "(no title)",
                body: ev.description?.slice(0, 200).trim(),
                url: ev.htmlLink,
                priority: this.defaultPriority,
                dedupeKey: `cal-${ev.id}`,
                meta: { calendarId: calId, eventId: ev.id, start: startRaw, end: endRaw, location: ev.location },
            };
        });
    }
}
