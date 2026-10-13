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
import type { PlanningTask } from "../../types/planning.js";
import { getGoogleToken, clearGoogleTokenCache } from "../../auth/google_oauth.js";
import type { GoogleTokenStore } from "../../auth/google_token_store.js";
import { assertHttpOk } from "../connector_http.js";
import { googleClientFor } from "../../auth/google_oauth_flow.js";

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

interface Task {
    id: string;
    title?: string;
    due?: string;
    notes?: string;
    status: "needsAction" | "completed";
    updated: string;
    completed?: string;
}

interface TaskListResponse {
    items?: Task[];
    nextPageToken?: string;
}

interface ListsResponse {
    items?: Array<{ id: string; title?: string }>;
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
        // Its own pair, or GOOGLE_*: the same client « Connecter » obtains the token with.
        const client = googleClientFor("gtasks");
        this.clientId = client?.id ?? "";
        this.clientSecret = client?.secret ?? "";
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

    /**
     * False once the planning holds the tasks (lot AT4): tasks no longer go to the box — reminders do. The poll still
     * reads the lists, so the source's health stays true (a read that fails is an error, not an empty box).
     */
    boxItems = true;

    async poll(): Promise<AcediaEvent[]> {
        if (!this.boxItems) {
            if ((await this.dueTasks()) === null)
                throw new Error("the task lists could not be read");
            return [];
        }
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

        const lists = this.onlyList
            ? [this.onlyList]
            : (await this.allLists(headers))?.map((l) => l.id);
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
    private async allLists(
        headers: Record<string, string>,
    ): Promise<Array<{ id: string; title: string }> | null> {
        const lists: Array<{ id: string; title: string }> = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url =
                `${TASKS_API}/users/@me/lists?maxResults=100` +
                (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
            const data = await this.read<ListsResponse>(url, headers, "lists");
            if (!data) return null;
            lists.push(...(data.items ?? []).map((l) => ({ id: l.id, title: l.title ?? l.id })));
            pageToken = data.nextPageToken;
            if (!pageToken) return lists;
        }
        console.warn(`[Tasks] more than ${MAX_PAGES} pages of lists — not read`);
        return null;
    }

    /** The incomplete tasks of one list, page after page. null when it cannot be read. */
    private async listTasks(
        listId: string,
        headers: Record<string, string>,
    ): Promise<Task[] | null> {
        // No dueMax: it would leave out undated tasks. The horizon is applied here, in toEvents.
        return this.readPages(
            `${TASKS_API}/lists/${listPath(listId)}/tasks` +
                `?showCompleted=false&showHidden=false&maxResults=100`,
            headers,
            `list ${listId}`,
        );
    }

    /** Every page of a task listing. null when a page cannot be read, or when there are more pages than read. */
    private async readPages(
        base: string,
        headers: Record<string, string>,
        what: string,
    ): Promise<Task[] | null> {
        const tasks: Task[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
            const data = await this.read<TaskListResponse>(url, headers, what);
            if (!data) return null;
            tasks.push(...(data.items ?? []));
            pageToken = data.nextPageToken;
            if (!pageToken) return tasks;
        }
        // Cut short: a partial picture would call the tasks it did not reach gone.
        console.warn(`[Tasks] ${what}: more than ${MAX_PAGES} pages — not read`);
        return null;
    }

    /**
     * Every open task of every list read — dated or not, whatever the due date — and the tasks completed since
     * `completedSince`, as planning objects (lot AT1). Strict: null as soon as one list cannot be read.
     */
    async readPlanning(completedSince: number): Promise<PlanningTask[] | null> {
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
        const lists = this.onlyList
            ? [{ id: this.onlyList, title: this.onlyList }]
            : await this.allLists(headers);
        if (!lists) return null;
        const out: PlanningTask[] = [];
        for (const list of lists) {
            const open = await this.listTasks(list.id, headers);
            if (!open) return null;
            const done = await this.readPages(
                `${TASKS_API}/lists/${listPath(list.id)}/tasks` +
                    `?showCompleted=true&showHidden=true&maxResults=100` +
                    `&completedMin=${encodeURIComponent(new Date(completedSince).toISOString())}`,
                headers,
                `list ${list.id} (completed)`,
            );
            if (!done) return null;
            const byId = new Map<string, Task>();
            for (const t of [...open, ...done]) byId.set(t.id, t);
            for (const t of byId.values()) {
                const completed = t.status === "completed";
                out.push({
                    id: `${list.id}/${t.id}`,
                    listId: list.id,
                    listTitle: list.title,
                    title: t.title || "(sans titre)",
                    ...(t.notes && { notes: t.notes }),
                    // Google keeps a date only: "2026-10-30T00:00:00.000Z" is the 30th.
                    ...(t.due && { due: t.due.slice(0, 10) }),
                    status: completed ? "completed" : "open",
                    ...(completed && t.completed && { completedAt: Date.parse(t.completed) }),
                    updatedAt: Date.parse(t.updated) || 0,
                });
            }
        }
        return out;
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
            action.kind !== "delete_task" &&
            action.kind !== "update_task" &&
            action.kind !== "reopen_task"
        )
            throw new Error(`[Tasks] "${action.kind}" is not a task action — nothing was done`);
        // Checked before a token is spent: a request that cannot be right is refused as is.
        if (action.kind === "update_task") {
            const f = action.fields;
            if (f.title === undefined && f.notes === undefined && f.due === undefined && !f.listId)
                throw new Error("[Tasks] update_task: nothing to change — nothing was done");
            if (f.due) dueToGoogle(f.due);
        }
        if (action.kind === "create_task" && action.fields.due) dueToGoogle(action.fields.due);
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
            if (action.fields.due) body["due"] = dueToGoogle(action.fields.due);
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

        if (action.kind === "update_task") {
            const f = action.fields;
            let target = listId;
            try {
                // Another list: the task is moved first (same id), then changed where it now lives.
                if (f.listId && f.listId !== listId) {
                    const resp = await fetch(
                        `${taskUrl}/move?destinationTasklist=${encodeURIComponent(f.listId)}`,
                        { method: "POST", headers },
                    );
                    await assertHttpOk(resp, "[Tasks] update_task (move)");
                    target = f.listId;
                }
                const patch: Record<string, unknown> = {};
                if (f.title !== undefined) patch["title"] = f.title;
                if (f.notes !== undefined) patch["notes"] = f.notes;
                // "" takes the date off.
                if (f.due !== undefined) patch["due"] = f.due ? dueToGoogle(f.due) : null;
                if (Object.keys(patch).length > 0) {
                    const resp = await fetch(
                        `${TASKS_API}/lists/${listPath(target)}/tasks/${encodeURIComponent(taskId)}`,
                        { method: "PATCH", headers, body: JSON.stringify(patch) },
                    );
                    await assertHttpOk(resp, "[Tasks] update_task");
                }
            } catch (e) {
                console.error("[Tasks] update_task error:", (e as Error).message);
                throw e;
            }
            return;
        }

        const reopen = action.kind === "reopen_task";
        try {
            const resp = await fetch(taskUrl, {
                method: "PATCH",
                headers,
                body: JSON.stringify(
                    reopen ? { status: "needsAction", completed: null } : { status: "completed" },
                ),
            });
            await assertHttpOk(resp, `[Tasks] ${action.kind}`);
        } catch (e) {
            console.error(`[Tasks] ${action.kind} error:`, (e as Error).message);
            throw e;
        }
    }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The due date as Google Tasks takes it: an RFC 3339 timestamp, of which only the date is kept. A date
 * ("2026-10-30") is sent as that day at midnight UTC; a timestamp is sent as is. Anything else is refused.
 */
function dueToGoogle(due: string): string {
    if (DATE_ONLY.test(due) && !isNaN(Date.parse(due))) return `${due}T00:00:00.000Z`;
    if (!DATE_ONLY.test(due) && !isNaN(Date.parse(due))) return due;
    throw new Error(`[Tasks] "${due}" is not a date — nothing was done`);
}
