import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubConnector } from "../../../source/connectors/github/github_connector.js";

function makeThread(
    overrides: Partial<{
        id: string;
        reason: string;
        unread: boolean;
        repoName: string;
        title: string;
        type: string;
        url: string;
    }> = {},
) {
    return {
        id: overrides.id ?? "t1",
        reason: overrides.reason ?? "mention",
        unread: overrides.unread ?? true,
        subject: {
            title: overrides.title ?? "Fix bug",
            type: overrides.type ?? "Issue",
            url: overrides.url,
        },
        repository: { full_name: overrides.repoName ?? "CrOliX-AltF4/LunAnima" },
    };
}

function makeCheckRuns(runs: Array<{ id: number; name: string; conclusion: string }>) {
    return {
        ok: true,
        json: () =>
            Promise.resolve({
                check_runs: runs.map((r) => ({
                    ...r,
                    html_url: `https://github.com/checks/${r.id}`,
                    check_suite: { id: 99 },
                })),
            }),
    };
}

beforeEach(() => {
    process.env["GITHUB_TOKEN"] = "test-token";
    delete process.env["GITHUB_EXCLUDE_REPOS"];
    delete process.env["GITHUB_WATCHED_REPOS"];
    delete process.env["GITHUB_POLL_INTERVAL_SEC"];
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_EXCLUDE_REPOS"];
    delete process.env["GITHUB_WATCHED_REPOS"];
    delete process.env["GITHUB_POLL_INTERVAL_SEC"];
});

describe("GitHubConnector", () => {
    it("should return empty array when GITHUB_TOKEN is missing", async () => {
        delete process.env["GITHUB_TOKEN"];
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should return empty array on 304 Not Modified", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ status: 304, ok: false, headers: { get: () => null } }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should return empty array on non-ok response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => null } }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should return empty array on network error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when all threads are read", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([makeThread({ unread: false })]),
            }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should return an event for an unread thread", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([makeThread({ reason: "mention" })]),
            }),
        );
        const events = await new GitHubConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe("github.mention");
        expect(events[0]!.source).toBe("github");
        expect(events[0]!.title).toContain("Fix bug");
    });

    it("should exclude repos in GITHUB_EXCLUDE_REPOS", async () => {
        process.env["GITHUB_EXCLUDE_REPOS"] = JSON.stringify(["CrOliX-AltF4/LunAnima"]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([makeThread()]),
            }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should only include repos in GITHUB_WATCHED_REPOS when set", async () => {
        process.env["GITHUB_WATCHED_REPOS"] = JSON.stringify(["other/repo"]);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([makeThread()]), // LunAnima — not in watched list
            }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(0);
    });

    it("should include all repos when GITHUB_WATCHED_REPOS is * (default)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () =>
                    Promise.resolve([
                        makeThread({ repoName: "CrOliX-AltF4/LunAnima" }),
                        makeThread({ id: "t2", repoName: "CrOliX-AltF4/LunAcedia" }),
                    ]),
            }),
        );
        expect(await new GitHubConnector().poll()).toHaveLength(2);
    });

    it("should set dedupeKey as gh-{reason}-{id}", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([makeThread({ id: "abc", reason: "mention" })]),
            }),
        );
        const events = await new GitHubConnector().poll();
        expect(events[0]!.dedupeKey).toBe("gh-mention-abc");
    });

    it("should store Last-Modified header and send If-Modified-Since on next poll", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: {
                    get: (h: string) =>
                        h === "Last-Modified" ? "Mon, 16 Jun 2026 10:00:00 GMT" : null,
                },
                json: () => Promise.resolve([]),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve([]),
            });
        vi.stubGlobal("fetch", fetchMock);

        const connector = new GitHubConnector();
        await connector.poll();
        await connector.poll();

        const secondCallHeaders = (
            fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }]
        )[1].headers;
        expect(secondCallHeaders["If-Modified-Since"]).toBe("Mon, 16 Jun 2026 10:00:00 GMT");
    });

    it("should fetch check runs for ci_activity threads and emit per failed run", async () => {
        const ciThread = makeThread({
            reason: "ci_activity",
            url: "https://api.github.com/repos/CrOliX-AltF4/LunAnima/commits/abc123",
        });

        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("/notifications")) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: { get: () => null },
                        json: () => Promise.resolve([ciThread]),
                    });
                }
                return Promise.resolve(
                    makeCheckRuns([
                        { id: 1, name: "typecheck", conclusion: "failure" },
                        { id: 2, name: "test", conclusion: "success" },
                    ]),
                );
            }),
        );

        const events = await new GitHubConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.type).toBe("github.ci.failed");
        expect(events[0]!.dedupeKey).toBe("gh-ci-run-1");
    });

    it("should fall back to generic ci event when check run fetch returns no failures", async () => {
        const ciThread = makeThread({
            reason: "ci_activity",
            url: "https://api.github.com/repos/CrOliX-AltF4/LunAnima/commits/abc123",
        });

        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("/notifications")) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        headers: { get: () => null },
                        json: () => Promise.resolve([ciThread]),
                    });
                }
                return Promise.resolve(
                    makeCheckRuns([{ id: 1, name: "test", conclusion: "success" }]),
                );
            }),
        );

        const events = await new GitHubConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.dedupeKey).toBe("gh-ci_activity-t1");
    });

    it("should expose name and preferredPollIntervalMs", () => {
        const connector = new GitHubConnector();
        expect(connector.name).toBe("GitHub");
        expect(connector.slug).toBe("github");
        expect(connector.preferredPollIntervalMs).toBeGreaterThanOrEqual(30_000);
    });
});

describe("GitHubConnector.executeAction", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("does nothing when GITHUB_TOKEN is missing", async () => {
        delete process.env["GITHUB_TOKEN"];
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "close_issue",
            sourceId: "owner/repo#1",
        });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("ignores action kinds it doesn't own", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({ kind: "complete_task", sourceId: "x" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("comment_issue: POSTs the body to /issues/:number/comments", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "comment_issue",
            sourceId: "CrOliX-AltF4/LunAnima#42",
            body: "Looking into it.",
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect(String(url)).toBe(
            "https://api.github.com/repos/CrOliX-AltF4/LunAnima/issues/42/comments",
        );
        expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
            body: "Looking into it.",
        });
    });

    it("add_label: POSTs the label array to /issues/:number/labels", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "add_label",
            sourceId: "owner/repo#7",
            label: "needs-triage",
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues/7/labels");
        expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
            labels: ["needs-triage"],
        });
    });

    it("close_issue: PATCHes state to closed", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "close_issue",
            sourceId: "owner/repo#3",
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect((opts as RequestInit).method).toBe("PATCH");
        expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues/3");
        expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ state: "closed" });
    });

    it("create_issue: POSTs title/body to /repos/:repo/issues", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "create_issue",
            fields: { repo: "owner/repo", title: "Bug found", body: "Steps to repro..." },
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues");
        expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
            title: "Bug found",
            body: "Steps to repro...",
        });
    });

    it("open_pr: POSTs title/head/base/body to /repos/:repo/pulls", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "open_pr",
            fields: {
                repo: "owner/repo",
                title: "Fix typo",
                head: "fix/typo",
                base: "main",
                body: "",
            },
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect(String(url)).toBe("https://api.github.com/repos/owner/repo/pulls");
        expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
            title: "Fix typo",
            head: "fix/typo",
            base: "main",
            body: "",
        });
    });

    it("merge_pr: PUTs to /repos/:repo/pulls/:number/merge", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({ kind: "merge_pr", sourceId: "owner/repo#9" });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect((opts as RequestInit).method).toBe("PUT");
        expect(String(url)).toBe("https://api.github.com/repos/owner/repo/pulls/9/merge");
    });

    it("mark_notification_read: PATCHes /notifications/threads/:id, id parsed from the dedupeKey", async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal("fetch", mockFetch);
        await new GitHubConnector().executeAction({
            kind: "mark_notification_read",
            sourceId: "gh-mention-98765",
        });
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect((opts as RequestInit).method).toBe("PATCH");
        expect(String(url)).toBe("https://api.github.com/notifications/threads/98765");
    });

    it("warns and does nothing for a malformed sourceId (no '#')", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        await new GitHubConnector().executeAction({
            kind: "close_issue",
            sourceId: "owner/repo-no-hash",
        });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});
