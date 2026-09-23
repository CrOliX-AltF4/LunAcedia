import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuardRulesStore, validateRules } from "../../source/guards/guard_rules_store.js";

const goodRule = {
    name: "Promotions AliExpress",
    conditions: [{ field: "from", op: "domain", value: "@AliExpress.com" }],
    actions: [{ type: "drop" }, { type: "tag", tag: "  promo " }],
};

describe("validateRules", () => {
    it("accepts a valid rule, normalises it and generates an id", () => {
        const res = validateRules([goodRule]);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.rules[0]!.id).toMatch(/[0-9a-f-]{36}/);
        expect(res.rules[0]!.enabled).toBe(true);
        expect(res.rules[0]!.conditions).toEqual([
            { field: "from", op: "domain", value: "aliexpress.com" },
        ]);
        expect(res.rules[0]!.actions).toEqual([{ type: "drop" }, { type: "tag", tag: "promo" }]);
    });

    it("keeps a given id and an explicit enabled:false", () => {
        const res = validateRules([{ ...goodRule, id: "keep-me", enabled: false }]);
        expect(res.ok && res.rules[0]).toMatchObject({ id: "keep-me", enabled: false });
    });

    it.each([
        ["a non-array", "nope", "must be an array"],
        ["a missing name", [{ ...goodRule, name: " " }], "name is required"],
        ["no conditions", [{ ...goodRule, conditions: [] }], "at least one condition"],
        ["no actions", [{ ...goodRule, actions: [] }], "at least one action"],
        [
            "an unknown condition field",
            [{ ...goodRule, conditions: [{ field: "regex", op: "matches", value: ".*" }] }],
            "unknown condition field",
        ],
        [
            "a bad from op",
            [{ ...goodRule, conditions: [{ field: "from", op: "regex", value: "x" }] }],
            "from.op",
        ],
        [
            "an empty value",
            [{ ...goodRule, conditions: [{ field: "subject", op: "contains", value: "  " }] }],
            "subject.value",
        ],
        [
            "a header name with junk",
            [{ ...goodRule, conditions: [{ field: "header", op: "present", name: "X Y;" }] }],
            "header.name",
        ],
        [
            "an unknown action",
            [{ ...goodRule, actions: [{ type: "delete_everything" }] }],
            "unknown action type",
        ],
        [
            "an invalid priority",
            [{ ...goodRule, actions: [{ type: "set_priority", priority: "critical" }] }],
            "priority must be",
        ],
        [
            "a duplicate id",
            [
                { ...goodRule, id: "a" },
                { ...goodRule, id: "a" },
            ],
            "duplicate id",
        ],
    ])("refuses %s", (_label, input, message) => {
        const res = validateRules(input);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain(message);
    });

    it("refuses more rules than the cap", () => {
        const res = validateRules(Array.from({ length: 201 }, () => goodRule));
        expect(res.ok).toBe(false);
    });
});

describe("GuardRulesStore", () => {
    let dir: string;
    afterEach(async () => {
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function freshPath(): Promise<string> {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-rules-"));
        return path.join(dir, "guard_rules.json");
    }

    it("starts empty at version 0 — nothing is ever dropped by default", async () => {
        const store = new GuardRulesStore(await freshPath());
        await store.load();
        expect(store.getRules()).toEqual([]);
        expect(store.getVersion()).toBe(0);
    });

    it("persists a replacement, bumps the version, and reloads it", async () => {
        const file = await freshPath();
        const store = new GuardRulesStore(file);
        const res = await store.replaceAll([goodRule]);
        expect(res).toEqual({ ok: true, version: 1 });

        const reloaded = new GuardRulesStore(file);
        await reloaded.load();
        expect(reloaded.getVersion()).toBe(1);
        expect(reloaded.getRules()).toHaveLength(1);
    });

    it("does not bump the version when the list is unchanged", async () => {
        const store = new GuardRulesStore(await freshPath());
        await store.replaceAll([{ ...goodRule, id: "r1" }]);
        const again = await store.replaceAll(store.getRules());
        expect(again).toEqual({ ok: true, version: 1 });
    });

    it("refuses an invalid list without touching the current rules or the version", async () => {
        const store = new GuardRulesStore(await freshPath());
        await store.replaceAll([{ ...goodRule, id: "r1" }]);
        const res = await store.replaceAll([{ name: "broken" }]);
        expect(res.ok).toBe(false);
        expect(store.getVersion()).toBe(1);
        expect(store.getRules()[0]!.id).toBe("r1");
    });

    it("returns copies — callers cannot mutate the live rules", async () => {
        const store = new GuardRulesStore(await freshPath());
        await store.replaceAll([{ ...goodRule, id: "r1" }]);
        store.getRules()[0]!.enabled = false;
        expect(store.getRules()[0]!.enabled).toBe(true);
    });

    it("falls back to no rules on a corrupt file", async () => {
        const file = await freshPath();
        await fs.writeFile(file, "{ not json", "utf-8");
        const store = new GuardRulesStore(file);
        await store.load();
        expect(store.getRules()).toEqual([]);
    });
});
