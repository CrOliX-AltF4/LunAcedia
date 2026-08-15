import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
    mockReadFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
    default: { readFile: h.mockReadFile, writeFile: h.mockWriteFile, mkdir: h.mockMkdir },
    readFile: h.mockReadFile,
    writeFile: h.mockWriteFile,
    mkdir: h.mockMkdir,
}));

import { GoogleTokenStore } from "../../source/auth/google_token_store.js";

describe("GoogleTokenStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("get() returns undefined for a connector with no stored token", () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        expect(store.get("gmail")).toBeUndefined();
    });

    it("set() persists and get() returns it", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gmail", "rt-123");
        expect(store.get("gmail")).toBe("rt-123");
        expect(h.mockWriteFile).toHaveBeenCalledOnce();
    });

    it("clear() removes a stored token", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gcal", "rt-456");
        await store.clear("gcal");
        expect(store.get("gcal")).toBeUndefined();
    });

    it("load() restores persisted tokens", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ gmail: "rt-abc" }));
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.load();
        expect(store.get("gmail")).toBe("rt-abc");
    });

    it("status() reports which connectors have a stored token", async () => {
        const store = new GoogleTokenStore("/tmp/x.json");
        await store.set("gmail", "rt-1");
        expect(store.status()).toEqual({ gmail: true, gcal: false, gtasks: false });
    });
});
