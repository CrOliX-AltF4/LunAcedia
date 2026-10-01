import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    UsageLedger,
    callerOf,
    currentUsageContext,
    localDay,
    priceOf,
    withUsageContext,
    withUsagePurpose,
} from "../../source/usage/llm_usage.js";
import { usageContextOf } from "../../source/http/api_server.js";

// ADR-021 P2 — LunAcedia measures its own LLM calls; it never caps them.

const NOW = Date.parse("2026-09-30T12:00:00");

describe("usage context", () => {
    it("follows the request across awaits, and a purpose keeps the caller", async () => {
        const seen = await withUsageContext({ caller: "core", purpose: "agent" }, async () => {
            await Promise.resolve();
            return withUsagePurpose("digest", () => currentUsageContext());
        });
        expect(seen).toEqual({ caller: "core", purpose: "digest" });
    });

    it("counts a purpose outside any caller as background, and nothing at all as unattributed", () => {
        expect(withUsagePurpose("digest", () => currentUsageContext())).toEqual({
            caller: "background",
            purpose: "digest",
        });
        expect(currentUsageContext()).toEqual({ caller: "unattributed", purpose: "unknown" });
    });

    it("reads the caller an agent request declares", () => {
        expect(callerOf("natsume-core")).toBe("core");
        expect(callerOf("topic")).toBe("topics");
        expect(callerOf(undefined)).toBe("api");
    });

    it("derives a request's context from its route", () => {
        expect(usageContextOf("/api/conversations/abc/messages")).toEqual({
            caller: "topics",
            purpose: "topic",
        });
        expect(usageContextOf("/api/digest")).toEqual({ caller: "api", purpose: "digest" });
        expect(usageContextOf("/api/agent?x=1")).toEqual({ caller: "api", purpose: "agent" });
        expect(usageContextOf("/api/inbox")).toEqual({ caller: "api", purpose: "other" });
    });
});

describe("priceOf", () => {
    it("knows the common models, a local model is free, an unknown one is not guessed", () => {
        expect(priceOf("gpt-4o-mini", undefined)).toEqual([0.15, 0.6]);
        expect(priceOf("ollama:llama3.2", undefined)).toEqual([0, 0]);
        expect(priceOf("mystery", undefined)).toBeNull();
        expect(priceOf("mystery", '{"mystery":[1,2]}')).toEqual([1, 2]);
    });
});

describe("UsageLedger", () => {
    it("aggregates by day, caller, purpose and model", () => {
        const ledger = new UsageLedger(undefined, () => NOW);
        ledger.record("gpt-4o-mini", 1_000_000, 0, { caller: "core", purpose: "agent" });
        ledger.record("gpt-4o-mini", 0, 1_000_000, { caller: "core", purpose: "agent" });
        ledger.record("gpt-4o-mini", 1_000_000, 0, { caller: "topics", purpose: "topic" });
        expect(ledger.list(1).find((r) => r.caller === "core")).toMatchObject({
            calls: 2,
            costUsd: 0.75,
        });
        expect(ledger.day().totalUsd).toBeCloseTo(0.9);
        expect(ledger.day().byCaller).toEqual({ core: 0.75, topics: expect.closeTo(0.15) });
    });

    it("counts an unpriced model apart", () => {
        const ledger = new UsageLedger(undefined, () => NOW);
        ledger.record("mystery", 10, 10, { caller: "api", purpose: "chat" });
        expect(ledger.day()).toMatchObject({ totalUsd: 0, calls: 1, unpricedCalls: 1 });
    });

    it("never throws, and a failing listener breaks nothing", () => {
        const ledger = new UsageLedger(undefined, () => NOW);
        const seen = vi.fn();
        ledger.onRecord(() => {
            throw new Error("boom");
        });
        ledger.onRecord(seen);
        expect(() => ledger.record("gpt-4o-mini", 1, 1)).not.toThrow();
        expect(seen).toHaveBeenCalledOnce();
    });

    describe("on disk", () => {
        let dir: string;
        beforeEach(async () => {
            dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-usage-"));
        });
        afterEach(async () => {
            await fs.rm(dir, { recursive: true, force: true });
        });

        it("survives a restart and drops days beyond the retention", async () => {
            const file = path.join(dir, "llm_usage.json");
            await fs.writeFile(
                file,
                JSON.stringify([
                    {
                        day: localDay(NOW - 120 * 86_400_000),
                        caller: "api",
                        purpose: "chat",
                        model: "gpt-4o-mini",
                        calls: 1,
                        tokensIn: 1,
                        tokensOut: 1,
                        costUsd: 0,
                    },
                ]),
                "utf-8",
            );
            const ledger = new UsageLedger(undefined, () => NOW);
            await ledger.load(file);
            ledger.record("gpt-4o-mini", 1_000_000, 0, { caller: "core", purpose: "agent" });
            await ledger.flush();

            const again = new UsageLedger(undefined, () => NOW);
            await again.load(file);
            expect(again.list(200).map((r) => r.day)).toEqual([localDay(NOW)]);
            expect(again.day().totalUsd).toBeCloseTo(0.15);
        });
    });
});
