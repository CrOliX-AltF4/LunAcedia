import type { IConnector } from "../connector_interface.js";
import { CONNECTOR_REGISTRY } from "../connector_registry.js";
import type { ConnectorSlug } from "../connector_registry.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import type { ConnectorAction } from "../../types/connector_action.js";
import { formatThread, formatFailedCheckRun } from "./github_formatter.js";

const GITHUB_API = "https://api.github.com";

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
                "https://api.github.com/notifications?all=false&participating=false",
                { headers },
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

        const threads = (await resp.json()) as GitHubThread[];
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

    private isWatched(fullName: string): boolean {
        if (this.excludeRepos.has(fullName)) return false;
        if (this.watchedRepos === "*") return true;
        return (this.watchedRepos as string[]).includes(fullName);
    }

    private async fetchFailedCheckRuns(
        repo: string,
        thread: { subject: { url?: string } },
    ): Promise<AcediaEvent[]> {
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

            return data.check_runs
                .filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out")
                .map((r) => formatFailedCheckRun(r, repo));
        } catch {
            return [];
        }
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
                if (!resp.ok)
                    console.warn(`[GitHub] mark_notification_read returned ${resp.status}`);
            } catch (e) {
                console.error("[GitHub] mark_notification_read error:", (e as Error).message);
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
                if (!resp.ok) console.warn(`[GitHub] create_issue returned ${resp.status}`);
            } catch (e) {
                console.error("[GitHub] create_issue error:", (e as Error).message);
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
                if (!resp.ok) console.warn(`[GitHub] open_pr returned ${resp.status}`);
            } catch (e) {
                console.error("[GitHub] open_pr error:", (e as Error).message);
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
            if (!resp.ok) console.warn(`[GitHub] ${action.kind} returned ${resp.status}`);
        } catch (e) {
            console.error(`[GitHub] ${action.kind} error:`, (e as Error).message);
        }
    }
}
