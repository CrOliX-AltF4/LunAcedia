import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubConnector } from "../../../source/connectors/github/github_connector.js";
import {
    formatThread,
    formatFailedCheckRun,
} from "../../../source/connectors/github/github_formatter.js";
import { EventStore } from "../../../source/store/event_store.js";
import type { AcediaEvent } from "../../../source/types/acedia_event.js";

// A GitHub notification lives in the box, read or unread, until it is done at GitHub — like a mail
// stays in the inbox until it is archived.

interface FakeThread {
    id: string;
    unread: boolean;
    status?: number;
    /** Done at GitHub: gone from the notifications listing. */
    done?: boolean;
    listed?: boolean;
}

/** `truncated`: the listing always has a next page, so it is never read to its end. */
function fakeGitHub(threads: FakeThread[], truncated = false) {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        calls.push({ method, url: u });
        if (u.includes("/notifications?")) {
            const listed = threads.filter((t) => !t.done && t.listed !== false);
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers(
                    truncated
                        ? { Link: '<https://api.github.com/notifications?page=2>; rel="next"' }
                        : {},
                ),
                json: () => Promise.resolve(listed.map((t) => ({ id: t.id, unread: t.unread }))),
            });
        }
        const m = u.match(/\/notifications\/threads\/(\w+)/);
        const t = threads.find((x) => x.id === m?.[1]);
        if (!t || t.status === 404)
            return Promise.resolve({
                ok: false,
                status: 404,
                text: () => Promise.resolve(""),
                json: () => Promise.resolve({}),
            });
        if (method === "DELETE")
            return Promise.resolve({ ok: true, status: 204, text: () => Promise.resolve("") });
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ id: t.id, unread: t.unread }),
        });
    });
    return { fetchImpl, calls };
}

function ghEvent(key: string, threadId?: string): AcediaEvent {
    return {
        type: "github.mention",
        ts: 1,
        source: "github",
        title: key,
        priority: "normal",
        dedupeKey: key,
        ...(threadId && { meta: { threadId } }),
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["GITHUB_TOKEN"];
});

describe("GitHub events keep their notification thread", () => {
    it("formatThread records the thread id", () => {
        const e = formatThread({
            id: "42",
            unread: true,
            reason: "mention",
            subject: { title: "t", type: "Issue", url: undefined },
            repository: { full_name: "o/r" },
        } as unknown as Parameters<typeof formatThread>[0]);
        expect(e!.meta).toMatchObject({ threadId: "42" });
    });

    it("a failed check run found through a thread keeps that thread", () => {
        const e = formatFailedCheckRun(
            { id: 7, name: "build", conclusion: "failure", html_url: "u", check_suite: { id: 9 } },
            "o/r",
            "42",
        );
        expect(e.meta).toMatchObject({ threadId: "42", repo: "o/r" });
    });
});

// Y2: a full listing (after a restart, or whenever GitHub has something new) used to date every notification at the
// moment it was read, so each held item looked changed and came back on top of the box dated today.
describe("a notification is dated by GitHub, not by when it was read (Y2)", () => {
    const thread = {
        id: "42",
        unread: false,
        reason: "author",
        updated_at: "2026-10-13T09:30:00Z",
        subject: { title: "feat: something", type: "PullRequest", url: undefined },
        repository: { full_name: "o/r" },
    };
    const run = {
        id: 7,
        name: "build",
        conclusion: "failure",
        html_url: "u",
        check_suite: { id: 9 },
        completed_at: "2026-10-12T18:00:00Z",
    };

    afterEach(() => vi.useRealTimers());

    it("a thread carries GitHub's date, a failed run its completion", () => {
        expect(formatThread(thread)!.ts).toBe(Date.parse("2026-10-13T09:30:00Z"));
        expect(formatFailedCheckRun(run, "o/r", "42").ts).toBe(Date.parse("2026-10-12T18:00:00Z"));
    });

    it("listing them again later changes no item the box holds", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
        const store = new EventStore();
        store.push(formatThread(thread)!);
        store.push(formatFailedCheckRun(run, "o/r", "42"));

        vi.setSystemTime(new Date("2026-10-18T22:06:00Z"));
        expect(store.refresh(formatThread(thread)!)).toBeNull();
        expect(store.refresh(formatFailedCheckRun(run, "o/r", "42"))).toBeNull();
    });

    it("new activity on the thread is a real change", () => {
        const store = new EventStore();
        store.push(formatThread(thread)!);
        const later = formatThread({ ...thread, updated_at: "2026-10-15T10:00:00Z" })!;
        expect(store.refresh(later)?.ts).toBe(Date.parse("2026-10-15T10:00:00Z"));
    });
});

describe("GitHubConnector.sourceState", () => {
    it("asks GitHub for read notifications too, not only the unread ones", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "1", unread: false }]);
        vi.stubGlobal("fetch", fetchImpl);
        await new GitHubConnector().sourceState([ghEvent("gh-mention-1", "1")]);
        expect(calls[0]!.url).toContain("all=true");
    });

    it("reports each thread read or unread as GitHub has it, and gone once done at GitHub", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl } = fakeGitHub([
            { id: "1", unread: true },
            { id: "2", unread: false },
            { id: "3", unread: false, done: true },
        ]);
        vi.stubGlobal("fetch", fetchImpl);
        const state = await new GitHubConnector().sourceState([
            ghEvent("gh-mention-1", "1"),
            ghEvent("gh-mention-2", "2"),
            ghEvent("gh-ci-run-9", "3"),
        ]);
        expect(Object.fromEntries(state!)).toEqual({
            "gh-mention-1": "unread",
            "gh-mention-2": "read",
            "gh-ci-run-9": "gone",
        });
    });

    it("checks a thread one by one when a listing cut short did not show it — still unread stays", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl } = fakeGitHub([{ id: "5", unread: true, listed: false }], true);
        vi.stubGlobal("fetch", fetchImpl);
        const state = await new GitHubConnector().sourceState([ghEvent("gh-mention-5", "5")]);
        expect(state!.get("gh-mention-5")).toBe("unread");
    });

    it("cannot judge an event without its thread", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl } = fakeGitHub([]);
        vi.stubGlobal("fetch", fetchImpl);
        const state = await new GitHubConnector().sourceState([ghEvent("gh-ci-run-1")]);
        expect(state!.has("gh-ci-run-1")).toBe(false);
    });

    it("changes nothing when GitHub cannot be asked", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new GitHubConnector().sourceState([ghEvent("gh-mention-1", "1")])).toBeNull();
    });
});

describe("GitHubConnector.markThreadDone", () => {
    it("marks the thread done at GitHub, which takes it out of the GitHub inbox", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "8", unread: true }]);
        vi.stubGlobal("fetch", fetchImpl);
        await new GitHubConnector().markThreadDone("8");
        expect(calls).toContainEqual({
            method: "DELETE",
            url: "https://api.github.com/notifications/threads/8",
        });
    });
});

describe("GitHubConnector.inboxGesture", () => {
    it("done takes the thread out of GitHub's inbox and the item dies", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "8", unread: true }]);
        vi.stubGlobal("fetch", fetchImpl);
        const r = await new GitHubConnector().inboxGesture("done", ghEvent("gh-mention-8", "8"));
        expect(r.change).toBe("removed");
        expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    });

    it("read marks the thread read at GitHub, and it stays in the box until done", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "8", unread: true }]);
        vi.stubGlobal("fetch", fetchImpl);
        const r = await new GitHubConnector().inboxGesture("read", ghEvent("gh-mention-8", "8"));
        expect(r.change).toBe("read");
        expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    });

    it("open is reading: an unread thread is marked read at GitHub", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "8", unread: true }]);
        vi.stubGlobal("fetch", fetchImpl);
        const r = await new GitHubConnector().inboxGesture("open", ghEvent("gh-mention-8", "8"));
        expect(r.change).toBe("read");
        expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    });

    it("open on a thread already read changes nothing at GitHub", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        const { fetchImpl, calls } = fakeGitHub([{ id: "8", unread: false }]);
        vi.stubGlobal("fetch", fetchImpl);
        const r = await new GitHubConnector().inboxGesture("open", {
            ...ghEvent("gh-mention-8", "8"),
            read: true,
        });
        expect(r.change).toBeNull();
        expect(calls).toEqual([]);
    });

    it("refuses a gesture it cannot do, or an item without its thread", async () => {
        process.env["GITHUB_TOKEN"] = "t";
        await expect(
            new GitHubConnector().inboxGesture("trash", ghEvent("gh-mention-8", "8")),
        ).rejects.toThrow();
        await expect(
            new GitHubConnector().inboxGesture("done", ghEvent("gh-ci-run-1")),
        ).rejects.toThrow();
    });
});
