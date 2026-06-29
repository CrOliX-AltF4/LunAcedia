import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

interface Task {
    id: string;
    title?: string;
    due?: string;
    notes?: string;
    status: "needsAction" | "completed";
    updated: string;
}

interface TaskListResponse {
    items?: Task[];
}

/**
 * Polls Google Tasks for due and overdue incomplete tasks.
 *
 * Config:
 *   GTASKS_CLIENT_ID, GTASKS_CLIENT_SECRET, GTASKS_REFRESH_TOKEN — OAuth2 credentials
 *   GTASKS_LIST_ID=@default     — task list to poll (default: primary)
 *   GTASKS_POLL_INTERVAL_MIN=15
 *
 * Priority: overdue → urgent, due today → normal.
 * Rule: classification by due date only — never by LLM.
 */
export class TasksConnector implements IConnector {
    readonly name = "Tasks";
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly refreshToken: string;
    private readonly listId: string;

    constructor() {
        this.clientId = process.env["GTASKS_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GTASKS_CLIENT_SECRET"] ?? "";
        this.refreshToken = process.env["GTASKS_REFRESH_TOKEN"] ?? "";
        this.listId = process.env["GTASKS_LIST_ID"] ?? "@default";

        const intervalMin = parseInt(process.env["GTASKS_POLL_INTERVAL_MIN"] ?? "15", 10);
        this.preferredPollIntervalMs = Math.max(5, intervalMin) * 60_000;
    }

    async poll(): Promise<AcediaEvent[]> {
        if (!this.clientId || !this.clientSecret || !this.refreshToken) return [];

        let token: string;
        try {
            token = await getGoogleToken(
                this.clientId,
                this.clientSecret,
                this.refreshToken,
                "gtasks",
            );
        } catch (e) {
            console.error("[Tasks] token refresh error:", (e as Error).message);
            return [];
        }

        const headers = { Authorization: `Bearer ${token}` };

        const dueMax = new Date();
        dueMax.setHours(23, 59, 59, 999);

        // @default and other @-prefixed special IDs must NOT be percent-encoded — the API returns 503 otherwise
        const listPath = this.listId.startsWith("@") ? this.listId : encodeURIComponent(this.listId);
        const url =
            `${TASKS_API}/lists/${listPath}/tasks` +
            `?showCompleted=false&showHidden=false` +
            `&dueMax=${encodeURIComponent(dueMax.toISOString())}&maxResults=50`;

        let resp: Response;
        try {
            resp = await fetch(url, { headers });
        } catch (e) {
            console.error("[Tasks] fetch error:", (e as Error).message);
            return [];
        }

        if (!resp.ok) {
            if (resp.status === 401) clearGoogleTokenCache("gtasks");
            console.warn(`[Tasks] list returned ${resp.status}`);
            return [];
        }

        const data = (await resp.json()) as TaskListResponse;
        const tasks = (data.items ?? []).filter((t) => t.due);
        const now = Date.now();

        return tasks.map((task): AcediaEvent => {
            const dueTs = new Date(task.due!).getTime();
            const overdue = dueTs < now;

            return {
                type: "tasks.due",
                ts: dueTs,
                source: "tasks",
                title: task.title ?? "(no title)",
                body: task.notes?.slice(0, 200).trim(),
                priority: overdue ? "urgent" : "normal",
                dedupeKey: `task-${task.id}`,
                meta: { taskId: task.id, due: task.due, overdue, listId: this.listId },
            };
        });
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (action.kind !== "complete") return;
        if (!this.clientId || !this.clientSecret || !this.refreshToken) return;

        let token: string;
        try {
            token = await getGoogleToken(
                this.clientId,
                this.clientSecret,
                this.refreshToken,
                "gtasks",
            );
        } catch (e) {
            console.error("[Tasks] action token error:", (e as Error).message);
            return;
        }

        // sourceId = "{listId}/{taskId}" or just "{taskId}" (falls back to configured listId)
        const [first, second] = action.sourceId.split("/");
        const [listId, taskId] = second ? [first!, second] : [this.listId, first!];

        try {
            const listPath2 = listId.startsWith("@") ? listId : encodeURIComponent(listId);
        const resp = await fetch(
                `${TASKS_API}/lists/${listPath2}/tasks/${encodeURIComponent(taskId)}`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ status: "completed" }),
                },
            );
            if (!resp.ok) {
                console.warn(`[Tasks] complete returned ${resp.status}`);
            }
        } catch (e) {
            console.error("[Tasks] complete error:", (e as Error).message);
        }
    }
}
