import { describe, it, expect, vi } from "vitest";
import type http from "node:http";
import { PlanningRoutes } from "../../source/http/planning_routes.js";
import { PlanningStore } from "../../source/planning/planning_store.js";
import { PlanningSync } from "../../source/planning/planning_sync.js";
import type { PlanningEvent } from "../../source/types/planning.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");

function ev(id: string, start: string, end: string): PlanningEvent {
    return {
        id: `primary/${id}`,
        calendarId: "primary",
        title: id,
        start,
        end,
        allDay: false,
        recurring: false,
        updatedAt: 1,
    };
}

function setup() {
    const store = new PlanningStore();
    store.replaceEvents(
        [
            ev("past", "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
            ev("soon", "2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z"),
            ev("far", "2026-12-20T10:00:00Z", "2026-12-20T11:00:00Z"),
        ],
        NOW,
    );
    const sync = new PlanningSync({ store, calendar: { readPlanning: vi.fn() } });
    const json = vi.fn();
    const routes = new PlanningRoutes({ store, sync, json, now: () => NOW });
    const res = {} as http.ServerResponse;
    const get = (qs = "") =>
        routes.handle("GET", "/api/planning", new URL(`http://x/api/planning${qs}`), res);
    return { json, get, routes, res };
}

describe("GET /api/planning", () => {
    it("defaults to the whole horizon held: 7 days back, 90 ahead", () => {
        const { json, get } = setup();
        expect(get()).toBe(true);
        const [, status, body] = json.mock.calls[0]!;
        expect(status).toBe(200);
        expect(body.events.map((e: PlanningEvent) => e.title)).toEqual(["soon", "far"]);
        expect(body.complete).toBe(true);
    });

    it("serves the period asked", () => {
        const { json, get } = setup();
        get("?from=2026-10-19&to=2026-10-21");
        expect(json.mock.calls[0]![2].events.map((e: PlanningEvent) => e.title)).toEqual(["soon"]);
    });

    it("refuses dates it cannot read, a period that ends before it starts, more than 366 days", () => {
        const { json, get } = setup();
        get("?from=garbage");
        get("?from=2026-10-21&to=2026-10-19");
        get("?from=2026-01-01&to=2027-06-01");
        expect(json.mock.calls.map((c) => c[1])).toEqual([400, 400, 400]);
    });

    it("leaves other routes alone", () => {
        const { routes, res } = setup();
        expect(routes.handle("POST", "/api/planning", new URL("http://x/api/planning"), res)).toBe(
            false,
        );
        expect(routes.handle("GET", "/api/inbox", new URL("http://x/api/inbox"), res)).toBe(false);
    });
});
