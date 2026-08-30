import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
    mockReadFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
    default: {
        readFile: h.mockReadFile,
        writeFile: h.mockWriteFile,
        mkdir: h.mockMkdir,
    },
    readFile: h.mockReadFile,
    writeFile: h.mockWriteFile,
    mkdir: h.mockMkdir,
}));

import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { DEFAULT_ACTION_TIERS } from "../../source/types/action_tier.js";

describe("ActionTierStore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        h.mockWriteFile.mockResolvedValue(undefined);
        h.mockMkdir.mockResolvedValue(undefined);
    });

    it("defaults every action kind to DEFAULT_ACTION_TIERS — fail-safe, never 'auto' out of the box", () => {
        const store = new ActionTierStore("/tmp/does-not-matter.json");
        expect(store.getAll()).toEqual(DEFAULT_ACTION_TIERS);
        expect(Object.values(store.getAll())).not.toContain("auto");
    });

    it("load() applies a persisted valid tier over the default", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ reply: "auto" }));
        const store = new ActionTierStore("/tmp/tiers.json");
        await store.load();
        expect(store.getTier("reply")).toBe("auto");
        expect(store.getTier("complete_task")).toBe("confirm");
    });

    it("load() ignores an invalid persisted tier value and keeps the default", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ reply: "yolo" }));
        const store = new ActionTierStore("/tmp/tiers.json");
        await store.load();
        expect(store.getTier("reply")).toBe("confirm");
    });

    it("load() keeps defaults when the file does not exist", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        await store.load();
        expect(store.getAll()).toEqual(DEFAULT_ACTION_TIERS);
    });

    it("load() ignores a persisted attempt to relax merge_pr", async () => {
        h.mockReadFile.mockResolvedValue(JSON.stringify({ merge_pr: "auto" }));
        const store = new ActionTierStore("/tmp/tiers.json");
        await store.load();
        expect(store.getTier("merge_pr")).toBe("manual");
    });

    it("patch() applies valid (kind, tier) pairs and persists them", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const changed = await store.patch({ reply: "auto", complete_task: "manual" });
        expect(changed.sort()).toEqual(["complete_task", "reply"]);
        expect(store.getTier("reply")).toBe("auto");
        expect(store.getTier("complete_task")).toBe("manual");
        expect(h.mockWriteFile).toHaveBeenCalledOnce();
    });

    it("patch() silently drops an attempt to change merge_pr — 'merger reste toujours humain'", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const changed = await store.patch({ merge_pr: "auto" });
        expect(changed).toEqual([]);
        expect(store.getTier("merge_pr")).toBe("manual");
        expect(h.mockWriteFile).not.toHaveBeenCalled();
    });

    it("patch() ignoring merge_pr does not block other valid pairs in the same call", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const changed = await store.patch({ merge_pr: "auto", reply: "auto" });
        expect(changed).toEqual(["reply"]);
        expect(store.getTier("merge_pr")).toBe("manual");
        expect(store.getTier("reply")).toBe("auto");
    });

    it("patch() rejects an unknown action kind without touching disk", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const changed = await store.patch({ notAKind: "auto" });
        expect(changed).toEqual([]);
        expect(h.mockWriteFile).not.toHaveBeenCalled();
    });

    it("patch() rejects an invalid tier value without touching disk", async () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const changed = await store.patch({ reply: "sometimes" });
        expect(changed).toEqual([]);
        expect(store.getTier("reply")).toBe("confirm");
        expect(h.mockWriteFile).not.toHaveBeenCalled();
    });

    it("getAll() returns a copy, not a live reference", () => {
        const store = new ActionTierStore("/tmp/tiers.json");
        const snapshot = store.getAll();
        snapshot.reply = "auto";
        expect(store.getTier("reply")).toBe("confirm");
    });

    // Backlog #329 P1 "paliers d'autonomie par type d'action ET par expéditeur/repo".
    describe("scoped overrides (per sender/repo)", () => {
        it("getTier() falls back to the kind-level tier when no override matches the scope", () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            expect(store.getTier("reply", "boss@corp.com")).toBe("confirm");
        });

        it("patchOverride() sets a scoped override that getTier() then prefers over the kind default", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("reply", "boss@corp.com", "manual");
            expect(ok).toBe(true);
            expect(store.getTier("reply", "boss@corp.com")).toBe("manual");
            // Unscoped and other-scoped calls are unaffected.
            expect(store.getTier("reply")).toBe("confirm");
            expect(store.getTier("reply", "someone-else@corp.com")).toBe("confirm");
            expect(h.mockWriteFile).toHaveBeenCalledOnce();
        });

        it("patchOverride() with tier: null removes an existing override", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            await store.patchOverride("reply", "boss@corp.com", "manual");
            const ok = await store.patchOverride("reply", "boss@corp.com", null);
            expect(ok).toBe(true);
            expect(store.getTier("reply", "boss@corp.com")).toBe("confirm");
        });

        it("patchOverride() with tier: null on a non-existent override is a no-op returning false", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("reply", "nobody@corp.com", null);
            expect(ok).toBe(false);
            expect(h.mockWriteFile).not.toHaveBeenCalled();
        });

        it("patchOverride() rejects an unknown kind", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("notAKind", "boss@corp.com", "manual");
            expect(ok).toBe(false);
            expect(h.mockWriteFile).not.toHaveBeenCalled();
        });

        it("patchOverride() rejects merge_pr — immutable kinds can't be overridden either", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("merge_pr", "owner/repo", "auto");
            expect(ok).toBe(false);
            expect(store.getTier("merge_pr", "owner/repo")).toBe("manual");
        });

        it("patchOverride() rejects an invalid tier value", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("reply", "boss@corp.com", "sometimes");
            expect(ok).toBe(false);
            expect(h.mockWriteFile).not.toHaveBeenCalled();
        });

        it("patchOverride() rejects an empty scope", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            const ok = await store.patchOverride("reply", "", "manual");
            expect(ok).toBe(false);
        });

        it("load() restores persisted overrides, ignoring a malformed entry", async () => {
            h.mockReadFile.mockImplementation((p: string) => {
                if (p === "/tmp/overrides.json") {
                    return Promise.resolve(
                        JSON.stringify({
                            "reply:boss@corp.com": "manual",
                            "notAKind:x": "manual", // unknown kind — dropped
                            "reply:someone@corp.com": "yolo", // invalid tier — dropped
                        }),
                    );
                }
                return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
            });
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            await store.load();
            expect(store.getTier("reply", "boss@corp.com")).toBe("manual");
            expect(store.getTier("reply", "someone@corp.com")).toBe("confirm");
            expect(store.getOverrides()).toEqual({ "reply:boss@corp.com": "manual" });
        });

        it("getOverrides() returns a copy, not a live reference", async () => {
            const store = new ActionTierStore("/tmp/tiers.json", "/tmp/overrides.json");
            await store.patchOverride("reply", "boss@corp.com", "manual");
            const snapshot = store.getOverrides();
            delete snapshot["reply:boss@corp.com"];
            expect(store.getTier("reply", "boss@corp.com")).toBe("manual");
        });
    });
});
