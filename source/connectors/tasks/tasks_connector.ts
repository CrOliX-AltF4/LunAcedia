import type { IConnector } from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";

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
    readonly slug: ConnectorSlug = "tasks";
    get name(): string {
        return CONNECTOR_REGISTRY[this.slug].label;
    }
    readonly preferredPollIntervalMs: number;

    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly staticRefreshToken: string;
    private readonly listId: string;
    private readonly tokenStore?: GoogleTokenStore;

    constructor(tokenStore?: GoogleTokenStore) {
        this.tokenStore = tokenStore;
        this.clientId = process.env["GTASKS_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GTASKS_CLIENT_SECRET"] ?? "";
        this.staticRefreshToken = process.env["GTASKS_REFRESH_TOKEN"] ?? "";
        this.listId = process.env["GTASKS_LIST_ID"] ?? "@default";

        const intervalMin = parseInt(process.env["GTASKS_POLL_INTERVAL_MIN"] ?? "15", 10);
        this.preferredPollIntervalMs = Math.max(5, intervalMin) * 60_000;

        // GTASKS_ENABLED=true gates whether this connector is even constructed — if we're here
        // without credentials AND no stored token, that's a real misconfiguration, not an
        // intentional disable. poll() silently returning [] every cycle gave no visibility.
        if (!this.clientId || !this.clientSecret || !this.refreshToken()) {
            console.warn(
                "[Tasks] GTASKS_ENABLED=true but client_id/client_secret/refresh_token are incomplete — poll() will return nothing until fixed (or connect via the dashboard).",
            );
        }
    }

    /** Read fresh, not cached — see GmailConnector.refreshToken() for why. */
    private refreshToken(): string {
        return this.tokenStore?.get("gtasks") ?? this.staticRefreshToken;
    }

    async poll(): Promise<AcediaEvent[]> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return [];

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gtasks");
        } catch (e) {
            console.error("[Tasks] token refresh error:", (e as Error).message);
            return [];
        }

        const headers = { Authorization: `Bearer ${token}` };

        const dueMax = new Date();
        dueMax.setHours(23, 59, 59, 999);

        // @default and other @-prefixed special IDs must NOT be percent-encoded — the API returns 503 otherwise
        const listPath = this.listId.startsWith("@")
            ? this.listId
            : encodeURIComponent(this.listId);
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
        if (
            action.kind !== "complete_task" &&
            action.kind !== "create_task" &&
            action.kind !== "delete_task"
        )
            return;
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return;

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gtasks");
        } catch (e) {
            console.error("[Tasks] action token error:", (e as Error).message);
            return;
        }
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

        if (action.kind === "create_task") {
            const listId = action.fields.listId || this.listId;
            const listPath = listId.startsWith("@") ? listId : encodeURIComponent(listId);
            const body: Record<string, unknown> = { title: action.fields.title };
            if (action.fields.due) body["due"] = action.fields.due;
            if (action.fields.notes) body["notes"] = action.fields.notes;
            try {
                const resp = await fetch(`${TASKS_API}/lists/${listPath}/tasks`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                });
                if (!resp.ok) console.warn(`[Tasks] create_task returned ${resp.status}`);
            } catch (e) {
                console.error("[Tasks] create_task error:", (e as Error).message);
            }
            return;
        }

        // complete_task / delete_task both address an existing task
        // sourceId = "{listId}/{taskId}" or just "{taskId}" (falls back to configured listId)
        const [first, second] = action.sourceId.split("/");
        const [listId, taskId] = second ? [first!, second] : [this.listId, first!];
        const listPath = listId.startsWith("@") ? listId : encodeURIComponent(listId);
        const taskUrl = `${TASKS_API}/lists/${listPath}/tasks/${encodeURIComponent(taskId)}`;

        if (action.kind === "delete_task") {
            try {
                const resp = await fetch(taskUrl, { method: "DELETE", headers });
                if (!resp.ok && resp.status !== 404)
                    console.warn(`[Tasks] delete_task returned ${resp.status}`);
            } catch (e) {
                console.error("[Tasks] delete_task error:", (e as Error).message);
            }
            return;
        }

        try {
            const resp = await fetch(taskUrl, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ status: "completed" }),
            });
            if (!resp.ok) {
                console.warn(`[Tasks] complete_task returned ${resp.status}`);
            }
        } catch (e) {
            console.error("[Tasks] complete_task error:", (e as Error).message);
        }
    }
}
