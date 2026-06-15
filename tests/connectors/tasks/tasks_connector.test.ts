import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TasksConnector } from "../../../source/connectors/tasks/tasks_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

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
        expect(c.preferredPollIntervalMs).toBeGreaterThan(0);
    });
});
