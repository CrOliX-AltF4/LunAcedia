/**
 * The planning, read.
 *
 *   GET /api/planning?from=&to=   PlanningSnapshot — the events that overlap [from, to), every task held, the
 *                                 conflicts between the events shown. `from`/`to`: ISO dates or date-times;
 *                                 default the whole horizon held (7 days back, 90 ahead). At most 366 days.
 *
 * Contract: `PlanningSnapshot` (types/planning.ts), mirrored by the Core.
 */
import type http from "node:http";
import type { PlanningStore } from "../planning/planning_store.js";
import { PLANNING_HORIZON, type PlanningSync } from "../planning/planning_sync.js";

const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 366 * DAY_MS;

export interface PlanningRouteDeps {
    store: PlanningStore;
    sync: PlanningSync;
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
    now?: () => number;
}

export class PlanningRoutes {
    constructor(private readonly deps: PlanningRouteDeps) {}

    /** Handles the request if it is a planning route; returns false otherwise. */
    handle(method: string, path: string, url: URL, res: http.ServerResponse): boolean {
        if (method !== "GET" || path !== "/api/planning") return false;
        const { store, sync, json } = this.deps;
        const now = (this.deps.now ?? Date.now)();
        const fromRaw = url.searchParams.get("from");
        const toRaw = url.searchParams.get("to");
        const from = fromRaw ? Date.parse(fromRaw) : now - PLANNING_HORIZON.pastDays * DAY_MS;
        const to = toRaw ? Date.parse(toRaw) : now + PLANNING_HORIZON.futureDays * DAY_MS;
        if (isNaN(from) || isNaN(to)) {
            json(res, 400, { error: "from and to must be ISO dates" });
            return true;
        }
        if (to <= from) {
            json(res, 400, { error: "to must come after from" });
            return true;
        }
        if (to - from > MAX_SPAN_MS) {
            json(res, 400, { error: "at most 366 days at once" });
            return true;
        }
        json(res, 200, store.snapshot(from, to, sync.configured()));
        return true;
    }
}
