import type {
    IConnector,
    InboxGesture,
    InboxGestureResult,
    SourceState,
} from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";
import { assertHttpOk } from "../connector_http.js";
import { googleClientFor } from "../../auth/google_oauth_flow.js";

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
    nextPageToken?: string;
}

/** Pages read at most per calendar and window — 10 × 250 events is far beyond any real lookahead. */
const MAX_PAGES = 10;

/** The event as the reader shows it: when, where, then the full description. */
function describeEvent(ev: CalEvent): string {
    const lines: string[] = [];
    if (ev.start.dateTime) {
        const start = new Date(ev.start.dateTime);
        const day = start.toLocaleDateString("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
        });
        const time = (d: Date) =>
            d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        const end = ev.end.dateTime ? `–${time(new Date(ev.end.dateTime))}` : "";
        lines.push(`Quand : ${day}, ${time(start)}${end}`);
    } else if (ev.start.date) {
        const day = new Date(ev.start.date).toLocaleDateString("fr-FR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            timeZone: "UTC",
        });
        lines.push(`Quand : ${day}, toute la journée`);
    }
    if (ev.location) lines.push(`Lieu : ${ev.location}`);
    const head = lines.join("\n");
    return ev.description ? `${head}\n\n${ev.description}` : head;
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
        // Its own pair, or GOOGLE_*: the same client « Connecter » obtains the token with.
        const client = googleClientFor("gcal");
        this.clientId = client?.id ?? "";
        this.clientSecret = client?.secret ?? "";
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
        return (await this.window(false)) ?? [];
    }

    /**
     * Where each held item stands. The lookahead window IS the truth for this source: an event
     * the window no longer lists was deleted, cancelled, has ended or moved out of it — gone (a moved event
     * comes back when it re-enters the window: forgetting its key lets it be collected again). A conflict
     * the window no longer produces is resolved — gone too. What the window still lists is not judged (a
     * calendar event has no read state at the source). null when any calendar cannot be read.
     */
    async sourceState(events: AcediaEvent[]): Promise<Map<string, SourceState> | null> {
        const held = events.filter((e) => e.source === "calendar");
        const state = new Map<string, SourceState>();
        if (held.length === 0) return state;
        const current = await this.window(true);
        if (!current) return null;
        const present = new Set(current.map((e) => e.dedupeKey));
        for (const e of held) if (!present.has(e.dedupeKey)) state.set(e.dedupeKey, "gone");
        return state;
    }

    /**
     * Every event of the lookahead window, plus the conflicts between them. `strict`: null as soon as one
     * calendar cannot be read (never judge on a partial picture); otherwise a failed calendar is skipped.
     */
    private async window(strict: boolean): Promise<AcediaEvent[] | null> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return strict ? null : [];

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gcal");
        } catch (e) {
            console.error("[GCal] token refresh error:", (e as Error).message);
            return strict ? null : [];
        }

        const headers = { Authorization: `Bearer ${token}` };
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + this.lookaheadMs).toISOString();

        const results = await Promise.allSettled(
            this.calendars.map((calId) => this.pollCalendar(calId, timeMin, timeMax, headers)),
        );
        if (strict && results.some((r) => r.status === "rejected" || r.value === null)) return null;

        const events = results.flatMap((r) => (r.status === "fulfilled" ? (r.value ?? []) : []));
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

    /**
     * "open" from the box: the whole event, read again at Google (the box keeps only an excerpt). An event
     * has no read state at the source — it is read in the box. Nothing else applies: an event is not
     * archived or trashed from the box (deleting one goes through the agent and its tiers).
     */
    async inboxGesture(gesture: InboxGesture, event: AcediaEvent): Promise<InboxGestureResult> {
        if (gesture !== "open") throw new Error(`[GCal] "${gesture}" does not apply to an event`);
        const calId = event.meta?.["calendarId"];
        const eventId = event.meta?.["eventId"];
        if (typeof calId !== "string" || typeof eventId !== "string")
            throw new Error("[GCal] item has no event id");
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken)
            throw new Error("[GCal] not configured");
        const token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gcal");
        const resp = await fetch(
            `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (resp.status === 404 || resp.status === 410)
            throw new Error("[GCal] event no longer exists");
        await assertHttpOk(resp, "[GCal] read event");
        return { change: "read", body: describeEvent((await resp.json()) as CalEvent) };
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (
            action.kind !== "update_event" &&
            action.kind !== "create_event" &&
            action.kind !== "delete_event"
        )
            throw new Error(`[GCal] "${action.kind}" is not a calendar action — nothing was done`);
        // Never a quiet return: the caller would count the action as done and drop its notification.
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken)
            throw new Error("[GCal] not configured — nothing was done");

        // Validate sourceId shape before spending a token fetch on a request that can't
        // proceed anyway — update_event/delete_event both address "{calendarId}/{eventId}".
        let calId = "";
        let eventId = "";
        if (action.kind !== "create_event") {
            const slash = action.sourceId.indexOf("/");
            if (slash <= 0 || slash === action.sourceId.length - 1) {
                throw new Error(
                    `[GCal] ${action.kind}: sourceId must be "calendarId/eventId", got "${action.sourceId}" — nothing was done`,
                );
            }
            calId = action.sourceId.slice(0, slash);
            eventId = action.sourceId.slice(slash + 1);
        }

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gcal");
        } catch (e) {
            console.error("[GCal] action token error:", (e as Error).message);
            throw e;
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
                const resp = await fetch(
                    `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events`,
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify(body),
                    },
                );
                await assertHttpOk(resp, "[GCal] create_event");
            } catch (e) {
                console.error("[GCal] create_event error:", (e as Error).message);
                throw e;
            }
            return;
        }

        // update_event / delete_event — calId/eventId already parsed from sourceId above
        const eventUrl = `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`;

        if (action.kind === "delete_event") {
            try {
                const resp = await fetch(eventUrl, { method: "DELETE", headers });
                // 410 = already gone — same outcome the caller wanted, not a failure.
                await assertHttpOk(resp, "[GCal] delete_event", [410]);
            } catch (e) {
                console.error("[GCal] delete_event error:", (e as Error).message);
                throw e;
            }
            return;
        }

        // update_event — map generic `fields` to GCal event patch body
        const patch: Record<string, string> = {};
        if (action.fields["title"]) patch["summary"] = action.fields["title"];
        if (action.fields["description"]) patch["description"] = action.fields["description"];
        if (action.fields["location"]) patch["location"] = action.fields["location"];
        try {
            const resp = await fetch(eventUrl, {
                method: "PATCH",
                headers,
                body: JSON.stringify(patch),
            });
            await assertHttpOk(resp, "[GCal] update_event");
        } catch (e) {
            console.error("[GCal] update_event error:", (e as Error).message);
            throw e;
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
    ): Promise<AcediaEvent[] | null> {
        const base =
            `${GCAL_API}/calendars/${encodeURIComponent(calId)}/events` +
            `?timeMin=${encodeURIComponent(timeMin)}` +
            `&timeMax=${encodeURIComponent(timeMax)}` +
            `&singleEvents=true&orderBy=startTime&maxResults=250`;

        // Paginated: the window used to stop at 50 events. null = this calendar could not be read.
        const events: CalEvent[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
            let resp: Response;
            try {
                resp = await fetch(url, { headers });
            } catch (e) {
                console.error(`[GCal] fetch error for ${calId}:`, (e as Error).message);
                return null;
            }

            if (!resp.ok) {
                if (resp.status === 401) clearGoogleTokenCache("gcal");
                console.warn(`[GCal] ${calId} returned ${resp.status}`);
                return null;
            }

            const data = (await resp.json()) as CalListResponse;
            events.push(...(data.items ?? []));
            pageToken = data.nextPageToken;
            if (!pageToken) break;
        }

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
