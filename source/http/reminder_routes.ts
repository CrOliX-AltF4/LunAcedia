/**
 * The reminders — Master sees what was sent and sets or stops it.
 *
 *   GET  /api/config/reminders       ReminderSettings
 *   PUT  /api/config/reminders       a partial ReminderSettings → the settings (400 saying which field is wrong)
 *   GET  /api/reminders/journal      ?limit= — what was sent, newest first (30 days kept)
 *   POST /api/reminders/snooze       { key, minutes? (default 60, 5 to 1440) } → 204; the reminder leaves the box
 *                                    and comes back when its time is up. 404 when unknown or already settled.
 */
import type http from "node:http";
import type { ReminderEngine } from "../planning/reminder_engine.js";
import type { ReminderSettingsStore } from "../planning/reminder_settings.js";

export interface ReminderRouteDeps {
    settings: ReminderSettingsStore;
    engine: ReminderEngine;
    /** The reminder was snoozed: take it out of the box (and the phone) until it comes back. */
    onSnoozed: (key: string) => void;
    readBody: (req: http.IncomingMessage) => Promise<unknown>;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export class ReminderRoutes {
    constructor(private readonly deps: ReminderRouteDeps) {}

    async handle(
        method: string,
        path: string,
        url: URL,
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<boolean> {
        const { settings, engine, json } = this.deps;
        if (path === "/api/config/reminders") {
            if (method === "GET") {
                json(res, 200, settings.get());
                return true;
            }
            if (method === "PUT") {
                const body = await this.body(req, res);
                if (body === undefined) return true;
                const r = await settings.set(body);
                json(res, r.ok ? 200 : 400, r.ok ? r.value : { error: r.error });
                return true;
            }
            return false;
        }
        if (method === "GET" && path === "/api/reminders/journal") {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
            json(res, 200, { entries: engine.journal(limit) });
            return true;
        }
        if (method === "POST" && path === "/api/reminders/snooze") {
            const body = (await this.body(req, res)) as
                { key?: unknown; minutes?: unknown } | undefined;
            if (body === undefined) return true;
            const minutes = body.minutes === undefined ? 60 : body.minutes;
            if (typeof body.key !== "string" || !body.key) {
                json(res, 400, { error: "key is required" });
                return true;
            }
            if (
                !Number.isInteger(minutes) ||
                (minutes as number) < 5 ||
                (minutes as number) > 1440
            ) {
                json(res, 400, { error: "minutes: 5 to 1440" });
                return true;
            }
            if (!engine.snooze(body.key, minutes as number)) {
                json(res, 404, { error: "no reminder standing under this key" });
                return true;
            }
            this.deps.onSnoozed(body.key);
            res.writeHead(204).end();
            return true;
        }
        return false;
    }

    private async body(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
        try {
            return (await this.deps.readBody(req)) ?? {};
        } catch {
            this.deps.json(res, 400, { error: "Invalid JSON" });
            return undefined;
        }
    }
}
