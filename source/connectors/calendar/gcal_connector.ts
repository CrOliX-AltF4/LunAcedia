import type { IConnector } from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";

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
 *   GCAL_PRIORITY=normal       — floor priority applied to every event (urgent|normal|info)
 *   GCAL_URGENT_WITHIN_MIN=15  — an event starting within this many minutes always escalates
 *                                to urgent, regardless of GCAL_PRIORITY (0 disables escalation)
 *
 * Also emits synthetic "calendar.conflict" events when two timed events (across any polled
 * calendar) overlap — all-day events are excluded, they're context, not a real time
 * commitment that can conflict. Deterministic, no LLM (design rule — see README).
 */
export class GcalConnector implements IConnector {
    readonly slug: ConnectorSlug = "calendar";
    get name(): string {
        return CONNECTOR_REGISTRY[this.slug].label;
    }
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly staticRefreshToken: string;
    private readonly calendars: string[];
    private readonly lookaheadMs: number;
    private readonly defaultPriority: AcediaEventPriority;
    private readonly urgentWithinMs: number;
    private readonly tokenStore?: GoogleTokenStore;

    constructor(tokenStore?: GoogleTokenStore) {
        this.tokenStore = tokenStore;
        this.clientId = process.env["GCAL_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GCAL_CLIENT_SECRET"] ?? "";
        this.staticRefreshToken = process.env["GCAL_REFRESH_TOKEN"] ?? "";

        const intervalMin = parseInt(process.env["GCAL_POLL_INTERVAL_MIN"] ?? "15", 10);
        this.preferredPollIntervalMs = Math.max(5, intervalMin) * 60_000;

        const lookaheadHours = parseInt(process.env["GCAL_LOOKAHEAD_HOURS"] ?? "24", 10);
        this.lookaheadMs = Math.max(1, lookaheadHours) * 3_600_000;

        this.calendars = parseCalendars(process.env["GCAL_CALENDARS"] ?? '["primary"]');

        const raw = process.env["GCAL_PRIORITY"] ?? "normal";
        this.defaultPriority = (
            ["urgent", "normal", "info"].includes(raw) ? raw : "normal"
        ) as AcediaEventPriority;

        const urgentWithinMin = parseInt(process.env["GCAL_URGENT_WITHIN_MIN"] ?? "15", 10);
        this.urgentWithinMs = Math.max(0, isNaN(urgentWithinMin) ? 15 : urgentWithinMin) * 60_000;

        // GCAL_ENABLED=true gates whether this connector is even constructed — if we're here
        // without credentials AND no stored token, that's a real misconfiguration, not an
        // intentional disable. poll() silently returning [] every cycle gave no visibility.
        if (!this.clientId || !this.clientSecret || !this.refreshToken()) {
            console.warn(
                "[GCal] GCAL_ENABLED=true but client_id/client_secret/refresh_token are incomplete — poll() will return nothing until fixed (or connect via the dashboard).",
            );
        }
    }

    /** Read fresh, not cached — see GmailConnector.refreshToken() for why. */
    private refreshToken(): string {
        return this.tokenStore?.get("gcal") ?? this.staticRefreshToken;
    }

    async poll(): Promise<AcediaEvent[]> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return [];

        let token: string;
        try {
            token = await getGoogleToken(
                this.clientId,
                this.clientSecret,
                refreshToken,
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

        const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        return [...events, ...this.detectConflicts(events)];
    }

    /**
     * Pairwise overlap check across every timed (non-all-day) event in this poll batch,
     * cross-calendar included. Strict overlap only — back-to-back events that just touch
     * (A ends exactly when B starts) are not a conflict.
     */
    private detectConflicts(events: AcediaEvent[]): AcediaEvent[] {
        const timed = events
            .map((e) => {
                const start = e.meta?.["start"];
                const end = e.meta?.["end"];
                if (typeof start !== "string" || typeof end !== "string") return null;
                if (!start.includes("T") || !end.includes("T")) return null; // all-day — excluded
                const startMs = new Date(start).getTime();
                const endMs = new Date(end).getTime();
                if (isNaN(startMs) || isNaN(endMs)) return null;
                return { event: e, startMs, endMs };
            })
            .filter((x): x is { event: AcediaEvent; startMs: number; endMs: number } => x !== null);

        const conflicts: AcediaEvent[] = [];
        for (let i = 0; i < timed.length; i++) {
            for (let j = i + 1; j < timed.length; j++) {
                const a = timed[i]!;
                const b = timed[j]!;
                const overlaps = a.startMs < b.endMs && b.startMs < a.endMs;
                if (!overlaps) continue;

                const idA = String(a.event.meta?.["eventId"] ?? a.event.dedupeKey);
                const idB = String(b.event.meta?.["eventId"] ?? b.event.dedupeKey);
                const [firstId, secondId] = [idA, idB].sort();
                conflicts.push({
                    type: "calendar.conflict",
                    ts: Math.min(a.startMs, b.startMs),
                    source: "calendar",
                    title: `Conflit : "${a.event.title}" chevauche "${b.event.title}"`,
                    priority: "urgent",
                    dedupeKey: `cal-conflict-${firstId}-${secondId}`,
                    meta: { eventAId: idA, eventBId: idB },
                });
            }
        }
        return conflicts;
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (action.kind !== "update_event" && action.kind !== "create_event" && action.kind !== "delete_event") return;
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return;

        // Validate sourceId shape before spending a token fetch on a request that can't
        // proceed anyway — update_event/delete_event both address "{calendarId}/{eventId}".
        let calId = "";
        let eventId = "";
        if (action.kind !== "create_event") {
            const slash = action.sourceId.indexOf("/");
            if (slash === -1) {
                console.warn(`[GCal] ${action.kind}: sourceId must be '{calendarId}/{eventId}'`);
                return;
            }
            calId = action.sourceId.slice(0, slash);
            eventId = action.sourceId.slice(slash + 1);
        }

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gcal");
        } catch (e) {
            console.error("[GCal] action token error:", (e as Error).message);
            return;
        }
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

        if (action.kind === "create_event") {
            const calId = action.fields.calendarId || "primary";
            const body: Record<string, unknown> = {
                summary: action.fields.summary,
                start: { dateTime: action.fields.start },
                end: { dateTime: action.fields.end },
            };
            if (action.fields.description) body["description"] = action.fields.description;
            if (action.fields.location) body["location"] = action.fields.location;
            try {
                const resp = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calId)}/events`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                });
                if (!resp.ok) console.warn(`[GCal] create_event returned ${resp.status}`);
            } catch (e) {
                console.error("[GCal] create_event error:", (e as Error).message);
            }
            return;
        }

        // update_event / delete_event — calId/eventId already parsed from sourceId above
        const eventUrl = `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`;

        if (action.kind === "delete_event") {
            try {
                const resp = await fetch(eventUrl, { method: "DELETE", headers });
                if (!resp.ok && resp.status !== 410) console.warn(`[GCal] delete_event returned ${resp.status}`);
            } catch (e) {
                console.error("[GCal] delete_event error:", (e as Error).message);
            }
            return;
        }

        // update_event — map generic `fields` to GCal event patch body
        const patch: Record<string, string> = {};
        if (action.fields["title"]) patch["summary"] = action.fields["title"];
        if (action.fields["description"]) patch["description"] = action.fields["description"];
        if (action.fields["location"]) patch["location"] = action.fields["location"];
        try {
            const resp = await fetch(eventUrl, { method: "PATCH", headers, body: JSON.stringify(patch) });
            if (!resp.ok) console.warn(`[GCal] update_event returned ${resp.status}`);
        } catch (e) {
            console.error("[GCal] update_event error:", (e as Error).message);
        }
    }

    /** GCAL_PRIORITY is a floor — an event starting within GCAL_URGENT_WITHIN_MIN always escalates to urgent. */
    private computePriority(startTs: number): AcediaEventPriority {
        if (this.urgentWithinMs <= 0) return this.defaultPriority;
        const msUntil = startTs - Date.now();
        if (msUntil >= 0 && msUntil <= this.urgentWithinMs) return "urgent";
        return this.defaultPriority;
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
                priority: this.computePriority(ts),
                dedupeKey: `cal-${ev.id}`,
                meta: {
                    calendarId: calId,
                    eventId: ev.id,
                    start: startRaw,
                    end: endRaw,
                    location: ev.location,
                },
            };
        });
    }
}
