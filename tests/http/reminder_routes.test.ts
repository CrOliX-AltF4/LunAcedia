import { describe, it, expect, vi } from "vitest";
import type http from "node:http";
import { ReminderRoutes } from "../../source/http/reminder_routes.js";
import { ReminderSettingsStore } from "../../source/planning/reminder_settings.js";
import { ReminderEngine } from "../../source/planning/reminder_engine.js";
import { DEFAULT_REMINDER_SETTINGS } from "../../source/planning/reminder_rules.js";

const NOW = new Date(2026, 9, 20, 13, 0).getTime();

function setup() {
    const settings = new ReminderSettingsStore();
    const engine = new ReminderEngine({
        planning: () => ({
            events: [
                {
                    id: "primary/ev1",
                    calendarId: "primary",
                    title: "Dentiste",
                    start: new Date(2026, 9, 20, 14, 0).toISOString(),
                    end: new Date(2026, 9, 20, 15, 0).toISOString(),
                    allDay: false,
                    recurring: false,
                    updatedAt: 1,
                },
            ],
            tasks: [],
            complete: true,
        }),
        settings: () => settings.get(),
        emit: vi.fn(),
        now: () => NOW,
    });
    const json = vi.fn();
    const onSnoozed = vi.fn();
    const routes = new ReminderRoutes({
        settings,
        engine,
        onSnoozed,
        json,
        readBody: async (req) => (req as unknown as { body: unknown }).body,
    });
    const res = {
        writeHead: vi.fn().mockReturnValue({ end: vi.fn() }),
    } as unknown as http.ServerResponse;
    const call = (method: string, path: string, body?: unknown) =>
        routes.handle(
            method,
            path,
            new URL(`http://x${path}`),
            { body } as unknown as http.IncomingMessage,
            res,
        );
    return { engine, json, onSnoozed, call, res };
}

describe("reminder routes", () => {
    it("reads and changes the settings, refusing a wrong field", async () => {
        const { json, call } = setup();
        await call("GET", "/api/config/reminders");
        expect(json.mock.calls[0]![2]).toEqual(DEFAULT_REMINDER_SETTINGS);
        await call("PUT", "/api/config/reminders", { enabled: false });
        expect(json.mock.calls[1]![1]).toBe(200);
        expect(json.mock.calls[1]![2].enabled).toBe(false);
        await call("PUT", "/api/config/reminders", { quietStart: "late" });
        expect(json.mock.calls[2]!.slice(1)).toEqual([400, { error: "quietStart: HH:MM" }]);
    });

    it("shows what was sent", async () => {
        const { engine, json, call } = setup();
        engine.tick();
        await call("GET", "/api/reminders/journal");
        expect(json.mock.calls[0]![2].entries.map((e: { title: string }) => e.title)).toEqual([
            "À 14:00 — Dentiste",
        ]);
    });

    it("snoozes a reminder and takes it out of the box until it comes back", async () => {
        const { engine, onSnoozed, call, res } = setup();
        const [sent] = engine.tick();
        expect(await call("POST", "/api/reminders/snooze", { key: sent!.key, minutes: 15 })).toBe(
            true,
        );
        expect(res.writeHead).toHaveBeenCalledWith(204);
        expect(onSnoozed).toHaveBeenCalledWith(sent!.key);
    });

    it("refuses a snooze without key, out of range, or for nothing standing", async () => {
        const { json, call } = setup();
        await call("POST", "/api/reminders/snooze", {});
        await call("POST", "/api/reminders/snooze", { key: "k", minutes: 2 });
        await call("POST", "/api/reminders/snooze", { key: "unknown" });
        expect(json.mock.calls.map((c) => c[1])).toEqual([400, 400, 404]);
    });

    it("leaves other routes alone", async () => {
        const { call } = setup();
        expect(await call("GET", "/api/planning")).toBe(false);
        expect(await call("DELETE", "/api/config/reminders")).toBe(false);
    });
});
