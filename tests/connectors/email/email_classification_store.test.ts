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

import { EmailClassificationStore } from "../../../source/connectors/email/email_classification_store.js";

describe("EmailClassificationStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("starts empty and unconfigured", () => {
        const store = new EmailClassificationStore("/tmp/x.json");
        expect(store.getAll()).toEqual({ vipSenders: [], urgentKeywords: [], normalKeywords: [] });
        expect(store.isConfigured()).toBe(false);
    });

    it("patch() sets fields and marks the store configured", async () => {
        const store = new EmailClassificationStore("/tmp/x.json");
        await store.patch({ vipSenders: ["boss@corp.com"] });
        expect(store.isConfigured()).toBe(true);
        expect(store.getAll().vipSenders).toEqual(["boss@corp.com"]);
        expect(h.mockWriteFile).toHaveBeenCalledOnce();
    });

    it("patch() ignores non-string-array values", async () => {
        const store = new EmailClassificationStore("/tmp/x.json");
        await store.patch({ vipSenders: [1, 2] as unknown as string[] });
        expect(store.getAll().vipSenders).toEqual([]);
    });

    it("load() restores a persisted config", async () => {
        h.mockReadFile.mockResolvedValue(
            JSON.stringify({ vipSenders: ["a@b.com"], urgentKeywords: ["urgent"], normalKeywords: [] }),
        );
        const store = new EmailClassificationStore("/tmp/x.json");
        await store.load();
        expect(store.getAll()).toEqual({ vipSenders: ["a@b.com"], urgentKeywords: ["urgent"], normalKeywords: [] });
    });

    it("compileRules() orders vipSenders, then urgentKeywords, then normalKeywords", async () => {
        const store = new EmailClassificationStore("/tmp/x.json");
        await store.patch({
            vipSenders: ["boss@corp.com"],
            urgentKeywords: ["urgent"],
            normalKeywords: ["newsletter"],
        });
        const rules = store.compileRules();
        expect(rules).toEqual([
            { senderPattern: "boss@corp.com", priority: "urgent", label: "VIP" },
            { senderPattern: "urgent", priority: "urgent", label: "urgent keyword" },
            { senderPattern: "newsletter", priority: "normal", label: "normal keyword" },
        ]);
    });

    it("getAll() returns copies, not live references", async () => {
        const store = new EmailClassificationStore("/tmp/x.json");
        await store.patch({ vipSenders: ["a@b.com"] });
        const snapshot = store.getAll();
        snapshot.vipSenders.push("c@d.com");
        expect(store.getAll().vipSenders).toEqual(["a@b.com"]);
    });
});
