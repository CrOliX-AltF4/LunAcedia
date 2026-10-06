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
import { formatThread, formatFailedCheckRun, type RunBranch } from "./github_formatter.js";
import { assertHttpOk } from "../connector_http.js";

const GITHUB_API = "https://api.github.com";
/** Notification pages read at most — 10 × 50 threads. */
const MAX_PAGES = 10;

/** "{owner}/{repo}#{number}" → { repo: "owner/repo", number: 123 }, or null if malformed. */
function parseIssueRef(sourceId: string): { repo: string; number: number } | null {
    const hash = sourceId.lastIndexOf("#");
    if (hash === -1) return null;
    const repo = sourceId.slice(0, hash);
    const number = parseInt(sourceId.slice(hash + 1), 10);
    if (!repo || isNaN(number)) return null;
    return { repo, number };
}

interface GitHubThread {
    id: string;
    reason: string;
    unread: boolean;
    subject: { title: string; type: string; url?: string };
    repository: { full_name: string };
}

export class GitHubConnector implements IConnector {
    private readonly defaultBranches = new Map<string, string>();
    readonly slug: ConnectorSlug = "github";
    get name(): string {
        return CONNECTOR_REGISTRY[this.slug].label;
    }

    private readonly token: string;
    private readonly excludeRepos: Set<string>;
    private readonly watchedRepos: string[] | "*";
    readonly preferredPollIntervalMs: number;

    private lastModified: string | null = null;

    constructor() {
        this.token = process.env["GITHUB_TOKEN"] ?? "";

        try {
            this.excludeRepos = new Set(JSON.parse(process.env["GITHUB_EXCLUDE_REPOS"] ?? "[]"));
        } catch {
            this.excludeRepos = new Set();
        }

        try {
            const raw = process.env["GITHUB_WATCHED_REPOS"] ?? "*";
            this.watchedRepos = raw.trim() === "*" ? "*" : JSON.parse(raw);
        } catch {
            this.watchedRepos = "*";
        }

        this.preferredPollIntervalMs = Math.max(
            30_000,
            parseInt(process.env["GITHUB_POLL_INTERVAL_SEC"] ?? "120", 10) * 1000,
        );
    }

    async poll(): Promise<AcediaEvent[]> {
        if (!this.token) return [];

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.lastModified) headers["If-Modified-Since"] = this.lastModified;

        let resp: Response;
        try {
            resp = await fetch(
                `${GITHUB_API}/notifications?all=false&participating=false&per_page=50`,
                {
                    headers,
                },
            );
        } catch (e) {
            console.error("[GitHub] fetch error:", (e as Error).message);
            return [];
        }

        if (resp.status === 304) return [];
        if (!resp.ok) {
            console.warn("[GitHub] API error:", resp.status);
            return [];
        }

        const lm = resp.headers.get("Last-Modified");
        if (lm) this.lastModified = lm;

        // Paginated: the listing used to stop at the first 50 threads.
        let threads = (await resp.json()) as GitHubThread[];
        try {
            threads = threads.concat(await this.nextPages<GitHubThread>(resp));
        } catch (e) {
            console.warn("[GitHub] next pages unavailable:", (e as Error).message);
        }
        const results: AcediaEvent[] = [];

        for (const thread of threads) {
            if (!this.isWatched(thread.repository.full_name)) continue;

            const event = formatThread(thread);
            if (!event) continue;

            if (event.type === "github.ci.failed" && thread.reason === "ci_activity") {
                const enriched = await this.fetchFailedCheckRuns(
                    thread.repository.full_name,
                    thread,
                );
                results.push(...(enriched.length ? enriched : [event]));
            } else {
                results.push(event);
            }
        }

        return results;
    }

    /** The branch a check suite ran on, and whether it is the repository's default — null when GitHub does not say. */
    private async runBranch(repo: string, suiteId: number): Promise<RunBranch | null> {
        const [head, main] = await Promise.all([
            this.suiteBranch(repo, suiteId),
            this.defaultBranch(repo),
        ]);
        return head && main ? { name: head, isDefault: head === main } : null;
    }

    private async suiteBranch(repo: string, suiteId: number): Promise<string | null> {
        const data = await this.getJson<{ head_branch?: unknown }>(
            `https://api.github.com/repos/${repo}/check-suites/${suiteId}`,
        );
        return typeof data?.head_branch === "string" ? data.head_branch : null;
    }

    /** Read once per repository: a default branch hardly ever changes. A failure is not kept, so it is tried again. */
    private async defaultBranch(repo: string): Promise<string | null> {
        const known = this.defaultBranches.get(repo);
        if (known) return known;
        const data = await this.getJson<{ default_branch?: unknown }>(
            `https://api.github.com/repos/${repo}`,
        );
        if (typeof data?.default_branch !== "string") return null;
        this.defaultBranches.set(repo, data.default_branch);
        return data.default_branch;
    }

    private async getJson<T>(url: string): Promise<T | null> {
        try {
            const resp = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            });
            return resp.ok ? ((await resp.json()) as T) : null;
        } catch {
            return null;
        }
    }

    private isWatched(fullName: string): boolean {
        if (this.excludeRepos.has(fullName)) return false;
        if (this.watchedRepos === "*") return true;
        return (this.watchedRepos as string[]).includes(fullName);
    }

    private async fetchFailedCheckRuns(
        repo: string,
        thread: { id: string | number; subject: { url?: string } },
    ): Promise<AcediaEvent[]> {
        const threadId = String(thread.id);
        const commitUrl = thread.subject.url;
        if (!commitUrl) return [];

        const match = commitUrl.match(/\/repos\/.+\/commits\/([a-f0-9]+)$/);
        if (!match) return [];
        const sha = match[1];

        try {
            const resp = await fetch(
                `https://api.github.com/repos/${repo}/commits/${sha}/check-runs`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        Accept: "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                },
            );
            if (!resp.ok) return [];

            const data = (await resp.json()) as {
                check_runs: Array<{
                    id: number;
                    name: string;
                    conclusion: string | null;
                    html_url: string;
                    check_suite: { id: number };
                }>;
            };

            const failed = data.check_runs.filter(
                (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
            );
            const out: AcediaEvent[] = [];
            for (const r of failed) {
                out.push(
                    formatFailedCheckRun(
                        r,
                        repo,
                        threadId,
                        await this.runBranch(repo, r.check_suite.id),
                    ),
                );
            }
            return out;
        } catch {
            return [];
        }
    }

    /**
     * The pages after `first`, following GitHub's `Link: <…>; rel="next"` header (never with
     * If-Modified-Since: the first page already said something changed). Throws when a page cannot be read.
     */
    private async nextPages<T>(first: Response): Promise<T[]> {
        const out: T[] = [];
        let link = first.headers.get("Link");
        for (let page = 1; page < MAX_PAGES && link; page++) {
            const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
            if (!next) break;
            const resp = await fetch(next, { headers: this.apiHeaders() });
            if (!resp.ok) throw new Error(`notifications page returned ${resp.status}`);
            out.push(...((await resp.json()) as T[]));
            link = resp.headers.get("Link");
        }
        return out;
    }

    private apiHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
    }

    /**
     * Where each held item stands at GitHub. v1 rule: the box holds unread notifications —
     * a thread read or done at GitHub leaves it. A thread missing from the unread listing is checked one
     * by one; an item without its thread is not judged. null when GitHub cannot be asked.
     */
    async sourceState(events: AcediaEvent[]): Promise<Map<string, SourceState> | null> {
        const held = events
            .filter((e) => e.source === "github" && e.meta?.["threadId"] !== undefined)
            .map((e) => ({ key: e.dedupeKey, threadId: String(e.meta!["threadId"]) }));
        const state = new Map<string, SourceState>();
        if (held.length === 0 || !this.token) return state;

        let unread: Set<string>;
        try {
            // No If-Modified-Since here: this is a full picture, not the incremental poll.
            const resp = await fetch(
                `${GITHUB_API}/notifications?all=false&participating=false&per_page=50`,
                { headers: this.apiHeaders() },
            );
            if (!resp.ok) throw new Error(`notifications returned ${resp.status}`);
            const threads = ((await resp.json()) as Array<{ id: string | number }>).concat(
                await this.nextPages<{ id: string | number }>(resp),
            );
            unread = new Set(threads.map((t) => String(t.id)));
        } catch (e) {
            console.warn("[GitHub] source state unavailable:", (e as Error).message);
            return null;
        }

        for (const { key, threadId } of held) {
            if (unread.has(threadId)) {
                state.set(key, "unread");
                continue;
            }
            try {
                const resp = await fetch(
                    `${GITHUB_API}/notifications/threads/${encodeURIComponent(threadId)}`,
                    {
                        headers: this.apiHeaders(),
                    },
                );
                if (resp.status === 404) {
                    state.set(key, "gone");
                    continue;
                }
                if (!resp.ok) continue;
                const thread = (await resp.json()) as { unread?: boolean };
                state.set(key, thread.unread ? "unread" : "gone");
            } catch {
                // unknown this time — never removed on uncertainty
            }
        }
        return state;
    }

    /**
     * Master's gestures on a notification. v1 rule: the box holds unread notifications, so
     * read and done both take the item out; open changes nothing (the link opens the thread).
     */
    async inboxGesture(gesture: InboxGesture, event: AcediaEvent): Promise<InboxGestureResult> {
        if (gesture === "open") return { change: null };
        const threadId = event.meta?.["threadId"];
        if (threadId === undefined) throw new Error("[GitHub] item has no notification thread");
        if (gesture === "done") {
            await this.markThreadDone(String(threadId));
            return { change: "removed" };
        }
        if (gesture === "read") {
            const resp = await fetch(
                `${GITHUB_API}/notifications/threads/${encodeURIComponent(String(threadId))}`,
                {
                    method: "PATCH",
                    headers: this.apiHeaders(),
                },
            );
            await assertHttpOk(resp, "[GitHub] mark thread read");
            return { change: "removed" };
        }
        throw new Error(`[GitHub] "${gesture}" does not apply to a notification`);
    }

    /** "Done" at GitHub: takes the thread out of the GitHub inbox. */
    async markThreadDone(threadId: string): Promise<void> {
        const resp = await fetch(
            `${GITHUB_API}/notifications/threads/${encodeURIComponent(threadId)}`,
            {
                method: "DELETE",
                headers: this.apiHeaders(),
            },
        );
        await assertHttpOk(resp, "[GitHub] mark thread done");
    }

    /**
     * Reuses GITHUB_TOKEN (the same token that reads notifications) — a fine-grained PAT with
     * both notifications:read and issues/pull-requests:write covers everything here; no
     * separate write-scoped token to configure. merge_pr's tier is hardcoded to "manual" in
     * ActionTierStore regardless of what reaches this method — this connector doesn't
     * re-enforce that (single source of truth is the tier store, checked before dispatch).
     */
    async executeAction(action: ConnectorAction): Promise<void> {
        if (
            action.kind !== "comment_issue" &&
            action.kind !== "add_label" &&
            action.kind !== "create_issue" &&
            action.kind !== "close_issue" &&
            action.kind !== "open_pr" &&
            action.kind !== "merge_pr" &&
            action.kind !== "mark_notification_read"
        ) {
            return;
        }
        if (!this.token) return;

        const headers = {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        };

        if (action.kind === "mark_notification_read") {
            // sourceId is the event's dedupeKey ("gh-{reason}-{threadId}") — see
            // connector_action.ts for why. The notification thread id GitHub's API needs is
            // always the last "-"-separated segment.
            const threadId = action.sourceId.slice(action.sourceId.lastIndexOf("-") + 1);
            try {
                const resp = await fetch(`${GITHUB_API}/notifications/threads/${threadId}`, {
                    method: "PATCH",
                    headers,
                });
                await assertHttpOk(resp, "[GitHub] mark_notification_read");
            } catch (e) {
                console.error("[GitHub] mark_notification_read error:", (e as Error).message);
                throw e;
            }
            return;
        }

        if (action.kind === "create_issue") {
            try {
                const resp = await fetch(`${GITHUB_API}/repos/${action.fields.repo}/issues`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ title: action.fields.title, body: action.fields.body }),
                });
                await assertHttpOk(resp, "[GitHub] create_issue");
            } catch (e) {
                console.error("[GitHub] create_issue error:", (e as Error).message);
                throw e;
            }
            return;
        }

        if (action.kind === "open_pr") {
            try {
                const resp = await fetch(`${GITHUB_API}/repos/${action.fields.repo}/pulls`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        title: action.fields.title,
                        head: action.fields.head,
                        base: action.fields.base,
                        body: action.fields.body,
                    }),
                });
                await assertHttpOk(resp, "[GitHub] open_pr");
            } catch (e) {
                console.error("[GitHub] open_pr error:", (e as Error).message);
                throw e;
            }
            return;
        }

        // comment_issue / add_label / close_issue / merge_pr all address an existing
        // issue or PR via sourceId = "{owner}/{repo}#{number}"
        const ref = parseIssueRef(action.sourceId);
        if (!ref) {
            console.warn(`[GitHub] ${action.kind}: sourceId must be '{owner}/{repo}#{number}'`);
            return;
        }

        try {
            let resp: Response;
            if (action.kind === "comment_issue") {
                resp = await fetch(
                    `${GITHUB_API}/repos/${ref.repo}/issues/${ref.number}/comments`,
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ body: action.body }),
                    },
                );
            } else if (action.kind === "add_label") {
                resp = await fetch(`${GITHUB_API}/repos/${ref.repo}/issues/${ref.number}/labels`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ labels: [action.label] }),
                });
            } else if (action.kind === "close_issue") {
                resp = await fetch(`${GITHUB_API}/repos/${ref.repo}/issues/${ref.number}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({ state: "closed" }),
                });
            } else {
                // merge_pr
                resp = await fetch(`${GITHUB_API}/repos/${ref.repo}/pulls/${ref.number}/merge`, {
                    method: "PUT",
                    headers,
                });
            }
            await assertHttpOk(resp, `[GitHub] ${action.kind}`);
        } catch (e) {
            console.error(`[GitHub] ${action.kind} error:`, (e as Error).message);
            throw e;
        }
    }
}
