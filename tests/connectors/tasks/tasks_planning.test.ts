import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TasksConnector } from "../../../source/connectors/tasks/tasks_connector.js";
import { clearGoogleTokenCache } from "../../../source/auth/google_oauth.js";

const SINCE = Date.parse("2026-09-29T00:00:00Z");

interface Fixture {
    lists?: object[] | "fail";
    open?: Record<string, object[] | "fail">;
    done?: Record<string, object[]>;
}

function makeFetch(f: Fixture) {
    return vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        const ok = (body: object) =>
            Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        if (u.includes("oauth2.googleapis.com"))
            return ok({ access_token: "tok", expires_in: 3600 });
        if (u.includes("/users/@me/lists")) {
            if (f.lists === "fail")
                return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
            return ok({ items: f.lists ?? [] });
        }
        const list = /\/lists\/([^/]+)\/tasks/.exec(u)?.[1] ?? "";
        if (u.includes("showCompleted=true")) return ok({ items: f.done?.[list] ?? [] });
        const open = f.open?.[list];
        if (open === "fail")
            return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        return ok({ items: open ?? [] });
    });
}

beforeEach(() => {
    clearGoogleTokenCache();
    process.env["GTASKS_CLIENT_ID"] = "client-id";
    process.env["GTASKS_CLIENT_SECRET"] = "client-secret";
    process.env["GTASKS_REFRESH_TOKEN"] = "refresh-token";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    ["GTASKS_CLIENT_ID", "GTASKS_CLIENT_SECRET", "GTASKS_REFRESH_TOKEN", "GTASKS_LIST_ID"].forEach(
        (k) => delete process.env[k],
    );
});

describe("TasksConnector.readPlanning", () => {
    it("reads every open task, whatever its due date, and the recently completed ones, from every list", async () => {
        const fetchMock = makeFetch({
            lists: [
                { id: "list-a", title: "Mes tâches" },
                { id: "list-b", title: "Courses" },
            ],
            open: {
                "list-a": [
                    {
                        id: "t1",
                        title: "Rendre le dossier",
                        due: "2027-03-15T00:00:00.000Z",
                        notes: "avant midi",
                        status: "needsAction",
                        updated: "2026-10-12T08:00:00.000Z",
                    },
                    {
                        id: "t2",
                        title: "Sans date",
                        status: "needsAction",
                        updated: "2026-10-12T08:00:00.000Z",
                    },
                ],
                "list-b": [
                    {
                        id: "t3",
                        title: "Pain",
                        status: "needsAction",
                        updated: "2026-10-12T08:00:00.000Z",
                    },
                ],
            },
            done: {
                "list-a": [
                    {
                        id: "t4",
                        title: "Fait",
                        status: "completed",
                        completed: "2026-10-10T09:00:00.000Z",
                        updated: "2026-10-10T09:00:00.000Z",
                    },
                ],
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        const tasks = await new TasksConnector().readPlanning(SINCE);

        expect(tasks).toEqual([
            {
                id: "list-a/t1",
                listId: "list-a",
                listTitle: "Mes tâches",
                title: "Rendre le dossier",
                notes: "avant midi",
                due: "2027-03-15",
                status: "open",
                updatedAt: Date.parse("2026-10-12T08:00:00.000Z"),
            },
            {
                id: "list-a/t2",
                listId: "list-a",
                listTitle: "Mes tâches",
                title: "Sans date",
                status: "open",
                updatedAt: Date.parse("2026-10-12T08:00:00.000Z"),
            },
            {
                id: "list-a/t4",
                listId: "list-a",
                listTitle: "Mes tâches",
                title: "Fait",
                status: "completed",
                completedAt: Date.parse("2026-10-10T09:00:00.000Z"),
                updatedAt: Date.parse("2026-10-10T09:00:00.000Z"),
            },
            {
                id: "list-b/t3",
                listId: "list-b",
                listTitle: "Courses",
                title: "Pain",
                status: "open",
                updatedAt: Date.parse("2026-10-12T08:00:00.000Z"),
            },
        ]);
        const completedAsked = fetchMock.mock.calls
            .map((c) => String(c[0]))
            .find((u) => u.includes("showCompleted=true"))!;
        expect(completedAsked).toContain(
            `completedMin=${encodeURIComponent(new Date(SINCE).toISOString())}`,
        );
    });

    it("is null when one list cannot be read — never a partial picture", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch({
                lists: [{ id: "list-a" }, { id: "list-b" }],
                open: { "list-a": [], "list-b": "fail" },
            }),
        );
        expect(await new TasksConnector().readPlanning(SINCE)).toBeNull();
    });

    it("is null when the lists cannot be read", async () => {
        vi.stubGlobal("fetch", makeFetch({ lists: "fail" }));
        expect(await new TasksConnector().readPlanning(SINCE)).toBeNull();
    });

    it("reads only GTASKS_LIST_ID when it is set", async () => {
        process.env["GTASKS_LIST_ID"] = "only";
        const fetchMock = makeFetch({
            open: {
                only: [
                    {
                        id: "t",
                        title: "x",
                        status: "needsAction",
                        updated: "2026-10-12T08:00:00.000Z",
                    },
                ],
            },
        });
        vi.stubGlobal("fetch", fetchMock);
        const tasks = await new TasksConnector().readPlanning(SINCE);
        expect(tasks!.map((t) => t.id)).toEqual(["only/t"]);
        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/users/@me/lists"))).toBe(
            false,
        );
    });

    it("is null when not configured", async () => {
        delete process.env["GTASKS_REFRESH_TOKEN"];
        expect(await new TasksConnector().readPlanning(SINCE)).toBeNull();
    });
});

describe("TasksConnector — no box items once the planning holds the tasks (AT4)", () => {
    it("still reads the lists on a poll, gives the box nothing, and fails loudly when the read fails", async () => {
        vi.stubGlobal(
            "fetch",
            makeFetch({
                lists: [{ id: "list-a" }],
                open: {
                    "list-a": [
                        {
                            id: "t",
                            title: "x",
                            status: "needsAction",
                            updated: "2026-10-12T08:00:00.000Z",
                        },
                    ],
                },
            }),
        );
        const c = new TasksConnector();
        expect(await c.poll()).toHaveLength(1);
        c.boxItems = false;
        expect(await c.poll()).toEqual([]);

        vi.stubGlobal("fetch", makeFetch({ lists: "fail" }));
        await expect(c.poll()).rejects.toThrow("could not be read");
    });
});
