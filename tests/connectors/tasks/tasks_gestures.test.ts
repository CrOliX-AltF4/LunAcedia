import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TasksConnector } from "../../../source/connectors/tasks/tasks_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

// Lot AT2: a task can be changed (title, notes, due date set or taken off, moved to another list) and reopened.

function okFetch() {
    return vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("oauth2"))
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
            });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
}

function calls(mock: ReturnType<typeof okFetch>) {
    return mock.mock.calls
        .filter(([u]: [string]) => !String(u).includes("oauth2"))
        .map(([u, o]: [string, RequestInit]) => ({
            method: o?.method,
            url: String(u),
            body: o?.body ? JSON.parse(o.body as string) : undefined,
        }));
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GTASKS_CLIENT_ID"] = "cid";
    process.env["GTASKS_CLIENT_SECRET"] = "csec";
    process.env["GTASKS_REFRESH_TOKEN"] = "rtoken";
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ["GTASKS_CLIENT_ID", "GTASKS_CLIENT_SECRET", "GTASKS_REFRESH_TOKEN"].forEach(
        (k) => delete process.env[k],
    );
});

describe("TasksConnector — update_task and reopen_task", () => {
    it("sets a due date on an undated task (the case the box could not follow)", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new TasksConnector().executeAction({
            kind: "update_task",
            sourceId: "list-a/t1",
            fields: { due: "2026-10-30" },
        });
        expect(calls(f)).toEqual([
            {
                method: "PATCH",
                url: "https://tasks.googleapis.com/tasks/v1/lists/list-a/tasks/t1",
                body: { due: "2026-10-30T00:00:00.000Z" },
            },
        ]);
    });

    it("takes the due date off with an empty string, and changes title and notes", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new TasksConnector().executeAction({
            kind: "update_task",
            sourceId: "list-a/t1",
            fields: { due: "", title: "Nouveau titre", notes: "" },
        });
        expect(calls(f)[0]!.body).toEqual({ title: "Nouveau titre", notes: "", due: null });
    });

    it("moves the task to another list first, then changes it there", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new TasksConnector().executeAction({
            kind: "update_task",
            sourceId: "list-a/t1",
            fields: { listId: "list-b", due: "2026-11-02" },
        });
        expect(calls(f)).toEqual([
            {
                method: "POST",
                url: "https://tasks.googleapis.com/tasks/v1/lists/list-a/tasks/t1/move?destinationTasklist=list-b",
                body: undefined,
            },
            {
                method: "PATCH",
                url: "https://tasks.googleapis.com/tasks/v1/lists/list-b/tasks/t1",
                body: { due: "2026-11-02T00:00:00.000Z" },
            },
        ]);
    });

    it("only moves when nothing else changes", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new TasksConnector().executeAction({
            kind: "update_task",
            sourceId: "list-a/t1",
            fields: { listId: "list-b" },
        });
        expect(calls(f).map((c) => c.method)).toEqual(["POST"]);
    });

    it.each([
        [{}, "nothing to change"],
        [{ due: "vendredi" }, "is not a date"],
    ])("refuses %j before Google is asked", async (fields, message) => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await expect(
            new TasksConnector().executeAction({
                kind: "update_task",
                sourceId: "list-a/t1",
                fields,
            }),
        ).rejects.toThrow(message);
        expect(calls(f)).toEqual([]);
    });

    it("says why when Google refuses", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation((url: string) =>
                String(url).includes("oauth2")
                    ? Promise.resolve({
                          ok: true,
                          json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
                      })
                    : Promise.resolve({
                          ok: false,
                          status: 404,
                          text: () => Promise.resolve("not found"),
                          json: () => Promise.resolve({}),
                      }),
            ),
        );
        await expect(
            new TasksConnector().executeAction({
                kind: "update_task",
                sourceId: "list-a/t1",
                fields: { title: "x" },
            }),
        ).rejects.toThrow();
    });

    it("reopens a completed task", async () => {
        const f = okFetch();
        vi.stubGlobal("fetch", f);
        await new TasksConnector().executeAction({ kind: "reopen_task", sourceId: "list-a/t1" });
        expect(calls(f)).toEqual([
            {
                method: "PATCH",
                url: "https://tasks.googleapis.com/tasks/v1/lists/list-a/tasks/t1",
                body: { status: "needsAction", completed: null },
            },
        ]);
    });
});
