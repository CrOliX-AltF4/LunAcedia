import type { IConnector } from "../connector_interface.js";
import type { AcediaEvent } from "../../types/acedia_event.js";
import { formatThread, formatFailedCheckRun } from "./github_formatter.js";

interface GitHubThread {
    id: string;
    reason: string;
    unread: boolean;
    subject: { title: string; type: string; url?: string };
    repository: { full_name: string };
}

export class GitHubConnector implements IConnector {
    readonly name = "GitHub";

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
}
