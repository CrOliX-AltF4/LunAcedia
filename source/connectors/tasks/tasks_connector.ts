import type {
    IConnector,
    InboxGesture,
    InboxGestureResult,
    SourceState,
} from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";
import { assertHttpOk } from "../connector_http.js";

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
    nextPageToken?: string;
}

interface ListsResponse {
    items?: Array<{ id: string }>;
    nextPageToken?: string;
}

const DAY_MS = 86_400_000;

/** @default and other @-prefixed special ids must NOT be percent-encoded — the API answers 503 otherwise. */
function listPath(listId: string): string {
    return listId.startsWith("@") ? listId : encodeURIComponent(listId);
}

/** Pages read at most — 10 × 100 due tasks is far beyond any real list. */
const MAX_PAGES = 10;

/**
 * Polls Google Tasks for the incomplete tasks worth seeing: overdue, due within the horizon, or undated.
 *
 * Config:
 *   GTASKS_CLIENT_ID, GTASKS_CLIENT_SECRET, GTASKS_REFRESH_TOKEN — OAuth2 credentials
 *   GTASKS_LIST_ID              — one list only; unset = every list of the account
 *   GTASKS_HORIZON_DAYS=7       — how far ahead a dated task is shown
 *   GTASKS_POLL_INTERVAL_MIN=15
 *
 * Priority: overdue → urgent, due within the horizon → normal, undated → info.
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
    /** Where a new task goes, and the list of an id given without one. */
    private readonly listId: string;
    /** GTASKS_LIST_ID when set: only this list is read. Unset: every list. */
    private readonly onlyList?: string;
    private readonly horizonMs: number;
    private readonly tokenStore?: GoogleTokenStore;

    constructor(tokenStore?: GoogleTokenStore) {
        this.tokenStore = tokenStore;
        this.clientId = process.env["GTASKS_CLIENT_ID"] ?? "";
        this.clientSecret = process.env["GTASKS_CLIENT_SECRET"] ?? "";
        this.staticRefreshToken = process.env["GTASKS_REFRESH_TOKEN"] ?? "";
        this.onlyList = process.env["GTASKS_LIST_ID"] || undefined;
        this.listId = this.onlyList ?? "@default";
        const horizonDays = parseInt(process.env["GTASKS_HORIZON_DAYS"] ?? "7", 10);
        this.horizonMs =
            (Number.isFinite(horizonDays) && horizonDays >= 0 ? horizonDays : 7) * DAY_MS;

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
        return (await this.dueTasks()) ?? [];
    }

    /**
     * Where each held task stands. The listing (overdue, within the horizon, undated) IS the truth
     * for this source: a task it no longer lists was completed, deleted or pushed past the horizon — gone
     * (a postponed task comes back when it is near: forgetting its key lets it be collected again). What
     * the listing still has is not judged. null when a list cannot be read.
     */
    async sourceState(events: AcediaEvent[]): Promise<Map<string, SourceState> | null> {
        const held = events.filter((e) => e.source === "tasks");
        const state = new Map<string, SourceState>();
        if (held.length === 0) return state;
        const current = await this.dueTasks();
        if (!current) return null;
        const present = new Set(current.map((e) => e.dedupeKey));
        for (const e of held) if (!present.has(e.dedupeKey)) state.set(e.dedupeKey, "gone");
        return state;
    }

    /** Every incomplete task worth seeing, from every list read, page after page. null when one cannot be read. */
    private async dueTasks(): Promise<AcediaEvent[] | null> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken) return null;

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gtasks");
        } catch (e) {
            console.error("[Tasks] token refresh error:", (e as Error).message);
            return null;
        }
        const headers = { Authorization: `Bearer ${token}` };

        const lists = this.onlyList ? [this.onlyList] : await this.allLists(headers);
        if (!lists) return null;
        const events: AcediaEvent[] = [];
        for (const listId of lists) {
            const tasks = await this.listTasks(listId, headers);
            // A list that cannot be read: judge nothing this time, rather than call its tasks gone.
            if (!tasks) return null;
            events.push(...this.toEvents(tasks, listId));
        }
        return events;
    }

    /** The account's task lists. null when they cannot be read. */
    private async allLists(headers: Record<string, string>): Promise<string[] | null> {
        const ids: string[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url =
                `${TASKS_API}/users/@me/lists?maxResults=100` +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
            const data = await this.read<ListsResponse>(url, headers, "lists");
            if (!data) return null;
            ids.push(...(data.items ?? []).map((l) => l.id));
            pageToken = data.nextPageToken;
            if (!pageToken) break;
        }
        return ids;
    }

    /** The incomplete tasks of one list, page after page. null when it cannot be read. */
    private async listTasks(
        listId: string,
        headers: Record<string, string>,
    ): Promise<Task[] | null> {
        // No dueMax: it would leave out undated tasks. The horizon is applied here, in toEvents.
        const base =
            `${TASKS_API}/lists/${listPath(listId)}/tasks` +
            `?showCompleted=false&showHidden=false&maxResults=100`;
        const tasks: Task[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
            const data = await this.read<TaskListResponse>(url, headers, `list ${listId}`);
            if (!data) return null;
            tasks.push(...(data.items ?? []));
            pageToken = data.nextPageToken;
            if (!pageToken) break;
        }
        return tasks;
    }

    private async read<T>(
        url: string,
        headers: Record<string, string>,
        what: string,
    ): Promise<T | null> {
        let resp: Response;
        try {
            resp = await fetch(url, { headers });
        } catch (e) {
            console.error(`[Tasks] fetch error (${what}):`, (e as Error).message);
            return null;
        }
        if (!resp.ok) {
            if (resp.status === 401) clearGoogleTokenCache("gtasks");
            console.warn(`[Tasks] ${what} returned ${resp.status}`);
            return null;
        }
        return (await resp.json()) as T;
    }

    /** Overdue → urgent, due within the horizon → normal, undated → info; due later → not shown yet. */
    private toEvents(tasks: Task[], listId: string): AcediaEvent[] {
        const now = Date.now();
        const horizonEnd = new Date(now + this.horizonMs);
        horizonEnd.setHours(23, 59, 59, 999);
        const events: AcediaEvent[] = [];
        for (const task of tasks) {
            const dueTs = task.due ? new Date(task.due).getTime() : null;
            if (dueTs !== null && dueTs > horizonEnd.getTime()) continue;
            const overdue = dueTs !== null && dueTs < now;
            events.push({
                type: "tasks.due",
                ts: dueTs ?? new Date(task.updated).getTime(),
                source: "tasks",
                title: task.title ?? "(no title)",
                body: task.notes?.slice(0, 200).trim(),
                priority: dueTs === null ? "info" : overdue ? "urgent" : "normal",
                dedupeKey: `task-${task.id}`,
                meta: {
                    taskId: task.id,
                    ...(task.due && { due: task.due }),
                    overdue,
                    listId,
                },
            });
        }
        return events;
    }

    /**
     * "Fait" from the box: Master's own hand, run directly like the Gmail gestures —
     * the agent's writes stay cut. The task is completed in its own list and the item leaves the box.
     */
    async inboxGesture(gesture: InboxGesture, event: AcediaEvent): Promise<InboxGestureResult> {
        if (gesture !== "done" && gesture !== "open")
            throw new Error(`[Tasks] "${gesture}" does not apply to a task`);
        const taskId = event.meta?.["taskId"];
        if (typeof taskId !== "string") throw new Error("[Tasks] item has no task id");
        if (gesture === "open") return { change: "read", body: await this.readTask(event, taskId) };
        // executeAction returns quietly when unconfigured; a gesture must never claim it was done.
        if (!this.clientId || !this.clientSecret || !this.refreshToken())
            throw new Error("[Tasks] not configured");
        const listId =
            typeof event.meta?.["listId"] === "string" ? event.meta["listId"] : this.listId;
        await this.executeAction({ kind: "complete_task", sourceId: `${listId}/${taskId}` });
        return { change: "removed" };
    }

    /** The whole task, as the reader shows it: its due date, then its full note. */
    private async readTask(event: AcediaEvent, taskId: string): Promise<string> {
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken)
            throw new Error("[Tasks] not configured");
        const listId =
            typeof event.meta?.["listId"] === "string" ? event.meta["listId"] : this.listId;
        const token = await getGoogleToken(
            this.clientId,
            this.clientSecret,
            refreshToken,
            "gtasks",
        );
        const resp = await fetch(
            `${TASKS_API}/lists/${listPath(listId)}/tasks/${encodeURIComponent(taskId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (resp.status === 404) throw new Error("[Tasks] task no longer exists");
        await assertHttpOk(resp, "[Tasks] read task");
        const task = (await resp.json()) as Task;
        const due = task.due
            ? `Échéance : ${new Date(task.due).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}`
            : "Sans échéance";
        return task.notes ? `${due}\n\n${task.notes}` : due;
    }

    async executeAction(action: ConnectorAction): Promise<void> {
        if (
            action.kind !== "complete_task" &&
            action.kind !== "create_task" &&
            action.kind !== "delete_task"
        )
            throw new Error(`[Tasks] "${action.kind}" is not a task action — nothing was done`);
        // Never a quiet return: the caller would count the action as done and drop its notification.
        const refreshToken = this.refreshToken();
        if (!this.clientId || !this.clientSecret || !refreshToken)
            throw new Error("[Tasks] not configured — nothing was done");

        let token: string;
        try {
            token = await getGoogleToken(this.clientId, this.clientSecret, refreshToken, "gtasks");
        } catch (e) {
            console.error("[Tasks] action token error:", (e as Error).message);
            throw e;
        }
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

        if (action.kind === "create_task") {
            const listId = action.fields.listId || this.listId;
            const body: Record<string, unknown> = { title: action.fields.title };
            if (action.fields.due) body["due"] = action.fields.due;
            if (action.fields.notes) body["notes"] = action.fields.notes;
            try {
                const resp = await fetch(`${TASKS_API}/lists/${listPath(listId)}/tasks`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                });
                await assertHttpOk(resp, "[Tasks] create_task");
            } catch (e) {
                console.error("[Tasks] create_task error:", (e as Error).message);
                throw e;
            }
            return;
        }

        // complete_task / delete_task both address an existing task
        // sourceId = "{listId}/{taskId}" or just "{taskId}" (falls back to configured listId)
        const [first, second] = action.sourceId.split("/");
        const [listId, taskId] = second ? [first!, second] : [this.listId, first!];
        const taskUrl = `${TASKS_API}/lists/${listPath(listId)}/tasks/${encodeURIComponent(taskId)}`;

        if (action.kind === "delete_task") {
            try {
                const resp = await fetch(taskUrl, { method: "DELETE", headers });
                // 404 = already gone — same outcome the caller wanted, not a failure.
                await assertHttpOk(resp, "[Tasks] delete_task", [404]);
            } catch (e) {
                console.error("[Tasks] delete_task error:", (e as Error).message);
                throw e;
            }
            return;
        }

        try {
            const resp = await fetch(taskUrl, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ status: "completed" }),
            });
            await assertHttpOk(resp, "[Tasks] complete_task");
        } catch (e) {
            console.error("[Tasks] complete_task error:", (e as Error).message);
            throw e;
        }
    }
}
