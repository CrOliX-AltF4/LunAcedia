import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TasksConnector } from "../../../source/connectors/tasks/tasks_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";
import { GoogleTokenStore } from "../../../source/auth/google_token_store.js";

const NOW = Date.now();
const DUE_TODAY = new Date(NOW + 2 * 3_600_000).toISOString(); // 2h from now
const DUE_PAST = new Date(NOW - 24 * 3_600_000).toISOString(); // yesterday
const DUE_IN_3_DAYS = new Date(NOW + 3 * 86_400_000).toISOString();
const DUE_IN_10_DAYS = new Date(NOW + 10 * 86_400_000).toISOString();
const LISTS_URL = "/users/@me/lists";

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

/** One task list ("list-a") holding `tasks` — the lists endpoint answers with it. */
function makeFetch(tasks: object[]) {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
            });
        }
        if (u.includes(LISTS_URL))
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ items: [{ id: "list-a", title: "Mes tâches" }] }),
            });
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
        expect(events[0]!.meta?.["listId"]).toBe("list-a");
    });

    it("should truncate notes to 200 chars", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Task", DUE_TODAY, "x".repeat(300))]));
        const events = await new TasksConnector().poll();
        expect(events[0]!.body).toHaveLength(200);
    });

    it("keeps a task without a due date, as info, dated when it last changed", async () => {
        const updated = new Date(NOW - 3_600_000).toISOString();
        vi.stubGlobal(
            "fetch",
            makeFetch([{ id: "t1", title: "No due", status: "needsAction", updated }]),
        );
        const events = await new TasksConnector().poll();
        expect(events).toHaveLength(1);
        expect(events[0]!.priority).toBe("info");
        expect(events[0]!.ts).toBe(new Date(updated).getTime());
    });

    it("keeps what is due within the next 7 days, leaves what is due later", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch([
                task("soon", "Soon", DUE_IN_3_DAYS),
                task("later", "Later", DUE_IN_10_DAYS),
            ]),
        );
        const events = await new TasksConnector().poll();
        expect(events.map((e) => e.title)).toEqual(["Soon"]);
        expect(events[0]!.priority).toBe("normal");
    });

    it("reads every task list, each task tied to its own list", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes("oauth2"))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                if (u.includes(LISTS_URL))
                    return Promise.resolve({
                        ok: true,
                        json: () =>
                            Promise.resolve({ items: [{ id: "perso" }, { id: "travail" }] }),
                    });
                const items = u.includes("/lists/perso/")
                    ? [task("p1", "Perso", DUE_TODAY)]
                    : [task("w1", "Travail", DUE_TODAY)];
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ items }) });
            }),
        );
        const events = await new TasksConnector().poll();
        expect(Object.fromEntries(events.map((e) => [e.title, e.meta?.["listId"]]))).toEqual({
            Perso: "perso",
            Travail: "travail",
        });
    });

    it("reads only the configured list when GTASKS_LIST_ID is set", async () => {
        process.env["GTASKS_LIST_ID"] = "only";
        const mockFetch = makeFetch([task("t1", "T", DUE_TODAY)]);
        vi.stubGlobal("fetch", mockFetch);
        const events = await new TasksConnector().poll();
        expect(events[0]!.meta?.["listId"]).toBe("only");
        expect(mockFetch.mock.calls.some(([u]: [string]) => String(u).includes(LISTS_URL))).toBe(
            false,
        );
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

    it("says so when credentials are missing, instead of claiming it was done", async () => {
        delete process.env["GTASKS_CLIENT_ID"];
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new TasksConnector().executeAction({ kind: "complete_task", sourceId: "t1" }),
        ).rejects.toThrow(/not configured/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refuses an action kind it doesn't own", async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        await expect(
            new TasksConnector().executeAction({ kind: "reply", sourceId: "t1", body: "x" }),
        ).rejects.toThrow(/not a task action/);
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

describe("TasksConnector — lifecycle at the source", () => {
    const held = (key: string) => ({
        type: "tasks.due" as const,
        ts: 1,
        source: "tasks" as const,
        title: key,
        priority: "normal" as const,
        dedupeKey: key,
    });

    it("reports gone a task the listing no longer has (completed, deleted, postponed past the horizon)", async () => {
        vi.stubGlobal("fetch", makeFetch([task("t1", "Open", DUE_TODAY)]));
        const state = await new TasksConnector().sourceState([held("task-t1"), held("task-done")]);
        expect(state?.get("task-t1")).toBeUndefined();
        expect(state?.get("task-done")).toBe("gone");
    });

    it("never judges when the list cannot be read", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) =>
                String(url).includes("oauth2")
                    ? Promise.resolve({
                          ok: true,
                          json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                      })
                    : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
            ),
        );
        expect(await new TasksConnector().sourceState([held("task-x")])).toBeNull();
    });

    it("reads the list page after page", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                const u = String(url);
                if (u.includes("oauth2"))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                if (u.includes(LISTS_URL))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ items: [{ id: "list-a" }] }),
                    });
                const second = u.includes("pageToken=p2");
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve(
                            second
                                ? { items: [task("b", "B", DUE_PAST)] }
                                : { items: [task("a", "A", DUE_TODAY)], nextPageToken: "p2" },
                        ),
                });
            }),
        );
        expect((await new TasksConnector().poll()).map((e) => e.title)).toEqual(["A", "B"]);
    });
});

// "Fait" on a task, from the box: Master's own hand, never the agent's writes.
describe("TasksConnector.inboxGesture", () => {
    const item = {
        type: "tasks.due" as const,
        ts: NOW,
        source: "tasks" as const,
        title: "Renvoyer le formulaire",
        priority: "normal" as const,
        dedupeKey: "task-t1",
        meta: { taskId: "t1", listId: "list-9" },
    };

    function googleFetch() {
        return vi.fn().mockImplementation((url: string) => {
            if (String(url).includes("oauth2"))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });
    }

    it("done completes the task in its own list at Google, and the item leaves the box", async () => {
        const mockFetch = googleFetch();
        vi.stubGlobal("fetch", mockFetch);
        const r = await new TasksConnector().inboxGesture("done", item);
        expect(r.change).toBe("removed");
        const patch = mockFetch.mock.calls.find(
            ([, o]: [string, RequestInit]) => o?.method === "PATCH",
        );
        expect(String(patch![0])).toContain("/lists/list-9/tasks/t1");
        expect(JSON.parse(patch![1]!.body as string)).toEqual({ status: "completed" });
    });

    it("says so when Google Tasks is not configured, instead of pretending it was done", async () => {
        delete process.env["GTASKS_REFRESH_TOKEN"];
        vi.stubGlobal("fetch", googleFetch());
        await expect(new TasksConnector().inboxGesture("done", item)).rejects.toThrow(
            /not configured/,
        );
    });

    it("open reads the whole task — its due date and its full note — and marks it read in the box", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) => {
                if (String(url).includes("oauth2"))
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                    });
                expect(String(url)).toContain("/lists/list-9/tasks/t1");
                return Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            id: "t1",
                            title: "Appeler",
                            due: "2026-10-08T00:00:00.000Z",
                            notes: "x".repeat(300),
                            status: "needsAction",
                            updated: "2026-10-07T00:00:00.000Z",
                        }),
                });
            }),
        );
        const r = await new TasksConnector().inboxGesture("open", item);
        expect(r.change).toBe("read");
        expect(r.body).toContain("Échéance");
        expect(r.body).toContain("x".repeat(300));
    });

    it("refuses any other gesture, and an item without its task", async () => {
        vi.stubGlobal("fetch", googleFetch());
        await expect(new TasksConnector().inboxGesture("archive", item)).rejects.toThrow(
            /does not apply/,
        );
        await expect(
            new TasksConnector().inboxGesture("done", { ...item, meta: {} }),
        ).rejects.toThrow(/has no task/);
    });
});
