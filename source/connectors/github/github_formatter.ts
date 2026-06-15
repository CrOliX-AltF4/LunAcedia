import type { AcediaEvent, AcediaEventPriority } from "../../types/acedia_event.js";

interface GitHubThread {
    id: string;
    reason: string;
    unread: boolean;
    subject: { title: string; type: string; url?: string };
    repository: { full_name: string };
}

interface CheckRun {
    id: number;
    name: string;
    conclusion: string | null;
    html_url: string;
    check_suite: { id: number };
}

const REASON_PRIORITY: Record<string, AcediaEventPriority> = {
    ci_activity: "urgent",
    review_requested: "normal",
    mention: "normal",
    assign: "info",
    author: "info",
    comment: "info",
    subscribed: "info",
    team_mention: "normal",
};

export function formatThread(thread: GitHubThread): AcediaEvent | null {
    if (!thread.unread) return null;

    const repo = thread.repository.full_name;
    const reason = thread.reason;
    const priority = REASON_PRIORITY[reason] ?? "info";

    const htmlUrl = thread.subject.url
        ? thread.subject.url
              .replace("api.github.com/repos", "github.com")
              .replace(/\/(pulls|issues)\//, "/$1/")
              .replace("/commits/", "/commit/")
        : `https://github.com/${repo}`;

    const typeMap: Record<string, AcediaEvent["type"]> = {
        ci_activity: "github.ci.failed",
        review_requested: "github.review.requested",
        mention: "github.mention",
    };

    return {
        type: typeMap[reason] ?? "github.push",
        ts: Date.now(),
        source: "github",
        title: `[${repo}] ${thread.subject.title}`,
        body: `${reason} — ${thread.subject.type}`,
        url: htmlUrl,
        priority,
        dedupeKey: `gh-${reason}-${thread.id}`,
    };
}

export function formatFailedCheckRun(run: CheckRun, repo: string): AcediaEvent {
    return {
        type: "github.ci.failed",
        ts: Date.now(),
        source: "github",
        title: `CI rouge : ${run.name} — ${repo}`,
        body: `conclusion: ${run.conclusion}`,
        url: run.html_url,
        priority: "urgent",
        dedupeKey: `gh-ci-run-${run.id}`,
        meta: { repo, checkSuiteId: run.check_suite.id },
    };
}
