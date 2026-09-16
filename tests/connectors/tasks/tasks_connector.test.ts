import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TasksConnector } from "../../../source/connectors/tasks/tasks_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";
import { GoogleTokenStore } from "../../../source/auth/google_token_store.js";

const NOW = Date.now();
const DUE_TODAY = new Date(NOW + 2 * 3_600_000).toISOString(); // 2h from now
const DUE_PAST = new Date(NOW - 24 * 3_600_000).toISOString(); // yesterday

function task(id: string, title: string, due: string, notes?: string) {
    return {
        id,
        title,
        due,
        notes,
        status: "needsAction" as const,
        updated: new Date().toISOString(),
    };
}

function makeFetch(tasks: object[]) {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
            });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: tasks }) });
    });
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GTASKS_CLIENT_ID"] = "client-id";
    process.env["GTASKS_CLIENT_SECRET"] = "client-secret";
    process.env["GTASKS_REFRESH_TOKEN"] = "refresh-token";
});

afterEach(() => {
    vi.unstubAllGlobals();
    [
        "GTASKS_CLIENT_ID",
        "GTASKS_CLIENT_SECRET",
        "GTASKS_REFRESH_TOKEN",
        "GTASKS_LIST_ID",
        "GTASKS_POLL_INTERVAL_MIN",
    ].forEach((k) => delete process.env[k]);
});

describe("TasksConnector", () => {
    it("should return empty array when credentials are missing", async () => {
        delete process.env["GTASKS_CLIENT_ID"];
        expect(await new TasksConnector().poll()).toHaveLength(0);
    });

    it("should warn at construction time when credentials are missing", () => {
        delete process.env["GTASKS_CLIENT_ID"];
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new TasksConnector();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GTASKS_ENABLED=true"));
        warnSpy.mockRestore();
    });

    it("should not warn at construction time when credentials are present", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        new TasksConnector();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("should return events for tasks due today", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Write tests", DUE_TODAY)]));
        const events = await new TasksConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.title).toBe("Write tests");
        expect(events[0]!.source).toBe("tasks");
        expect(events[0]!.type).toBe("tasks.due");
    });

    it("should set priority normal for tasks due today", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Meeting prep", DUE_TODAY)]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.priority).toBe("normal");
    });

    it("should set priority urgent for overdue tasks", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Overdue report", DUE_PAST)]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.priority).toBe("urgent");
    });

    it("should set dedupeKey with task- prefix", async () => {
        vi.stubGlobal("fetch", makeFetch([task("abc123", "Buy milk", DUE_TODAY)]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.dedupeKey).toBe("task-abc123");
    });

    it("should include meta with taskId, due, overdue, listId", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Task", DUE_PAST)]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.meta?.["taskId"]).toBe("t1");
        expect(events[0]!.meta?.["overdue"]).toBe(true);
        expect(events[0]!.meta?.["listId"]).toBe("@default");
    });

    it("should truncate notes to 200 chars", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Task", DUE_TODAY, "x".repeat(300))]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.body).toHaveLength(200);
    });

    it("should filter out tasks without a due date", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "t1",
                    title: "No due",
                    status: "needsAction",
                    updated: new Date().toISOString(),
                },
            ]),
        );
        const events = await new TasksConnector().poll();
        expect(events).toHaveLength(0);
    });

    it("should return empty array when token refresh fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
        expect(await new TasksConnector().poll()).toHaveLength(0);
    });

    it("should return empty array when API returns non-ok", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("oauth2")) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                }
                return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
            }),
        );
        expect(await new TasksConnector().poll()).toHaveLength(0);
    });

    it("should use (no title) for tasks without title", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                {
                    id: "t1",
                    due: DUE_TODAY,
                    status: "needsAction",
                    updated: new Date().toISOString(),
                },
            ]),
        );
        const events = await new TasksConnector().poll();
        expect(events[0]!.title).toBe("(no title)");
    });

    it("should expose name and preferredPollIntervalMs", () => {
        const c = new TasksConnector();
        expect(c.name).toBe("Tasks");
        expect(c.slug).toBe("tasks");
        expect(c.preferredPollIntervalMs).toBeGreaterThan(0);
    });
});

describe("TasksConnector — GoogleTokenStore", () => {
    it("prefers a stored refresh token over GTASKS_REFRESH_TOKEN once one exists", async () => {
        delete process.env["GTASKS_REFRESH_TOKEN"];
        const tokenStore = new GoogleTokenStore("/tmp/does-not-matter.json");
        await tokenStore.set("gtasks", "rt-from-oauth-flow");
        vi.stubGlobal("fetch", makeFetch([task("t1", "Buy milk", DUE_TODAY)]));
        const events = await new TasksConnector(tokenStore).poll();
        expect(events).toHaveLength(1);
    });

    it("still returns nothing when neither the store nor GTASKS_REFRESH_TOKEN has a token", async () => {
        delete process.env["GTASKS_REFRESH_TOKEN"];
        const tokenStore = new GoogleTokenStore("/tmp/does-not-matter.json");
        const events = await new TasksConnector(tokenStore).poll();
        expect(events).toHaveLength(0);
    });
});

describe("TasksConnector.executeAction — complete_task / create_task / delete_task", () => {
    beforeEach(() => {
        clearGoogleTokenCache();
        process.env["GTASKS_CLIENT_ID"] = "cid";
        process.env["GTASKS_CLIENT_SECRET"] = "csec";
        process.env["GTASKS_REFRESH_TOKEN"] = "rtoken";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("complete_task: should PATCH task status to completed", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (u.includes("/tasks/") && opts?.method === "PATCH")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({ kind: "complete_task", sourceId: "task-abc" });
        const patchCall = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "PATCH",
        );
        expect(patchCall).toBeDefined();
        expect(JSON.parse(patchCall![1]!.body as string)).toEqual({ status: "completed" });
    });

    it("complete_task: should accept listId/taskId format in sourceId", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            const u = String(url);
            if (u.includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "PATCH")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({
            kind: "complete_task",
            sourceId: "mylist/task-xyz",
        });
        const patchCall = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "PATCH",
        );
        expect(String(patchCall![0]!)).toContain("mylist");
        expect(String(patchCall![0]!)).toContain("task-xyz");
    });

    it("should do nothing when credentials are missing", async () => {
        delete process.env["GTASKS_CLIENT_ID"];
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({ kind: "complete_task", sourceId: "t1" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should ignore action kinds it doesn't own", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({ kind: "reply", sourceId: "t1", body: "x" });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("create_task: POSTs a new task to the target list", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "POST")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({
            kind: "create_task",
            fields: { title: "Buy milk", due: "2026-09-01" },
        });
        const postCall = mockFetch.mock.calls.find(
            ([u, o]: [string, RequestInit]) =>
                o?.method === "POST" && !String(u).includes("oauth2"),
        );
        expect(postCall).toBeDefined();
        const body = JSON.parse(postCall![1]!.body as string) as { title: string; due: string };
        expect(body.title).toBe("Buy milk");
        expect(body.due).toBe("2026-09-01");
    });

    it("create_task: uses fields.listId when given instead of the configured default", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "POST")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({
            kind: "create_task",
            fields: { title: "Review PR", listId: "mylist" },
        });
        const postCall = mockFetch.mock.calls.find(
            ([u, o]: [string, RequestInit]) =>
                o?.method === "POST" && !String(u).includes("oauth2"),
        );
        expect(String(postCall![0]!)).toContain("mylist");
    });

    it("delete_task: DELETEs the task at {listId}/{taskId}", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "DELETE")
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({
            kind: "delete_task",
            sourceId: "mylist/task-999",
        });
        const delCall = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "DELETE",
        );
        expect(delCall).toBeDefined();
        expect(String(delCall![0]!)).toContain("task-999");
    });

    it("delete_task: treats 404 (already gone) as success, not a warning", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "DELETE")
                return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await new TasksConnector().executeAction({
            kind: "delete_task",
            sourceId: "mylist/task-999",
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    // Regression: this used to log-and-swallow the failure, so dispatchAction's own
    // try/catch never saw it and the caller was told the action succeeded.
    it("delete_task: throws (not swallows) on a real failure status, e.g. 403", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            if (opts?.method === "DELETE")
                return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new TasksConnector().executeAction({
                kind: "delete_task",
                sourceId: "mylist/task-999",
            }),
        ).rejects.toThrow("returned 403");
    });

    it("complete_task: throws when the Tasks API rejects the request", async () => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
        });
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new TasksConnector().executeAction({ kind: "complete_task", sourceId: "task-abc" }),
        ).rejects.toThrow("returned 401");
    });

    it("throws when the token fetch itself fails", async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new TasksConnector().executeAction({ kind: "complete_task", sourceId: "task-abc" }),
        ).rejects.toThrow("network down");
    });
});
