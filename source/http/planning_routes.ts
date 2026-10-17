/**
 * The planning, read — and Master's own gesture on it.
 *
 *   GET /api/planning?from=&to=   PlanningSnapshot — the events that overlap [from, to), every task held, the
 *                                 conflicts between the events shown. `from`/`to`: ISO dates or date-times;
 *                                 default the whole horizon held (7 days back, 90 ahead). At most 366 days.
 *   POST /api/planning/tasks/:id/done   « Fait » on a task of the Planning screen (`:id` = "listId/taskId", encoded):
 *                                 completed at Google Tasks at once — Master's hand, like a gesture of the box, not
 *                                 the agent's write that waits for a confirmation.
 *
 * Contract: `PlanningSnapshot` (types/planning.ts), mirrored by the Core.
 */
import type http from "node:http";
import type { IConnector } from "../connectors/connector_interface.js";
import type { PlanningStore } from "../planning/planning_store.js";
import { PLANNING_HORIZON, type PlanningSync } from "../planning/planning_sync.js";

const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 366 * DAY_MS;

export interface PlanningRouteDeps {
    store: PlanningStore;
    sync: PlanningSync;
    /** Where a task is completed (the Google Tasks connector) — absent: the gesture answers 503. */
    connectors?: IConnector[];
    json: (res: http.ServerResponse, status: number, body: unknown) => void;
    now?: () => number;
}

export class PlanningRoutes {
    constructor(private readonly deps: PlanningRouteDeps) {}

    /** Handles the request if it is a planning route; returns false otherwise. */
    async handle(
        method: string,
        path: string,
        url: URL,
        res: http.ServerResponse,
    ): Promise<boolean> {
        const done = path.match(/^\/api\/planning\/tasks\/([^/]+)\/done$/);
        if (method === "POST" && done) {
            await this.complete(decodeURIComponent(done[1]!), res);
            return true;
        }
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

    private async complete(id: string, res: http.ServerResponse): Promise<void> {
        const { json, store, sync } = this.deps;
        if (!store.getTask(id)) {
            json(res, 404, { error: "No such task in the planning" });
            return;
        }
        const tasks = this.deps.connectors?.find((c) => c.slug === "tasks");
        if (!tasks?.executeAction) {
            json(res, 503, { error: "No task list to complete it in" });
            return;
        }
        try {
            await tasks.executeAction({ kind: "complete_task", sourceId: id });
        } catch (e) {
            json(res, 502, { error: (e as Error).message });
            return;
        }
        void sync.syncNow();
        json(res, 200, { ok: true });
    }
}
