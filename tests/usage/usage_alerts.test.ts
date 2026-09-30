import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UsageLedger, localDay, type UsageCaller } from "../../source/usage/llm_usage.js";
import {
    UsageAlerts,
    defaultSettings,
    parseCallerPaliers,
    parsePaliers,
    validateSettings,
    type FiredAlert,
} from "../../source/usage/usage_alerts.js";

// ADR-021 P2 — LunAcedia's spend alerts inform, they never cut.

const NOW = Date.parse("2026-09-30T12:00:00");
const spend = (ledger: UsageLedger, usd: number, caller: UsageCaller = "core") =>
    ledger.record("gpt-4o-mini", Math.round((usd / 0.15) * 1_000_000), 0, { caller, purpose: "agent" });

describe("settings", () => {
    it("reads paliers and caller paliers", () => {
        expect(parsePaliers("10/5")).toEqual([5, 10]);
        expect(parseCallerPaliers("topics=1/2, core=5, fridge=1")).toEqual({ topics: [1, 2], core: [5] });
    });

    it("takes the environment as defaults of a fresh install", () => {
        expect(defaultSettings({ LLM_ALERT_DAILY_USD: "5/10", LLM_ALERT_SPIKE_FACTOR: "0" })).toEqual({
            dailyUsd: [5, 10], perCallerUsd: {}, spikeFactor: 0, spikeMinUsd: 0.5,
        });
    });

    it("refuses what the dashboard should never send", () => {
        expect(validateSettings({ dailyUsd: [-1] })).toEqual({ error: "dailyUsd must be a list of positive amounts" });
        expect(validateSettings({ perCallerUsd: { fridge: [1] } })).toEqual({ error: "unknown caller fridge" });
        expect(validateSettings({ spikeFactor: -2 })).toEqual({ error: "spikeFactor must be ≥ 0" });
        expect(validateSettings({ dailyUsd: [10, 5], perCallerUsd: { topics: [1] } })).toEqual({
            dailyUsd: [5, 10], perCallerUsd: { topics: [1] }, spikeFactor: 5, spikeMinUsd: 0.5,
        });
    });
});

describe("UsageAlerts", () => {
    let t: number;
    let ledger: UsageLedger;
    let alerts: UsageAlerts;
    let delivered: FiredAlert[];

    beforeEach(async () => {
        t = NOW;
        ledger = new UsageLedger(undefined, () => t);
        alerts = new UsageAlerts(undefined, () => t);
        await alerts.setSettings({ dailyUsd: [1, 2], perCallerUsd: { topics: [0.5] }, spikeFactor: 0, spikeMinUsd: 0.5 });
        delivered = [];
        alerts.watch(ledger, (a) => { delivered.push(a); });
    });

    it("tells once per palier and per day, as information", () => {
        spend(ledger, 0.9);
        expect(delivered).toEqual([]);
        spend(ledger, 0.2);
        spend(ledger, 0.1);
        expect(delivered.map((a) => a.title)).toEqual(["LunAcedia — dépense LLM : 1.00 $ atteints aujourd'hui"]);
        expect(delivered[0]).toMatchObject({ kind: "daily", priority: "normal" });
        expect(delivered[0]!.body).toContain("Rien n'est coupé");
    });

    it("tells per caller", () => {
        spend(ledger, 0.6, "topics");
        expect(delivered.map((a) => a.kind)).toEqual(["caller"]);
        expect(delivered[0]!.title).toContain("sujets du téléphone");
    });

    it("keeps what it fired for the week, newest first — what the Core relays", () => {
        spend(ledger, 2.5);
        expect(alerts.recent().map((a) => a.kind)).toEqual(["daily", "daily"]);
        t += 8 * 24 * 60 * 60 * 1000;
        expect(alerts.recent()).toEqual([]);
    });

    it("warns, urgently, on an unusual hour — and cuts nothing", async () => {
        const storage = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "acedia-usage-")), "llm_usage.json");
        await fs.writeFile(storage, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((d) => ({
            day: localDay(NOW - d * 86_400_000), caller: "core", purpose: "agent", model: "gpt-4o-mini",
            calls: 1, tokensIn: 0, tokensOut: 0, costUsd: 2.4,
        }))), "utf-8");
        const l = new UsageLedger(undefined, () => t);
        await l.load(storage);
        const a = new UsageAlerts(undefined, () => t);
        await a.setSettings({ dailyUsd: [], perCallerUsd: {}, spikeFactor: 5, spikeMinUsd: 0.5 });
        const got: FiredAlert[] = [];
        a.watch(l, (x) => { got.push(x); });
        spend(l, 1);
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ kind: "spike", priority: "urgent" });
        expect(l.day().calls).toBe(1);
    });

    it("never breaks a call when delivering fails", () => {
        const l = new UsageLedger(undefined, () => t);
        const a = new UsageAlerts(undefined, () => t);
        void a.setSettings({ dailyUsd: [0.01], perCallerUsd: {}, spikeFactor: 0, spikeMinUsd: 0.5 });
        a.watch(l, () => { throw new Error("push down"); });
        expect(() => spend(l, 1)).not.toThrow();
    });

    describe("on disk", () => {
        let dir: string;
        beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-alerts-")); });
        afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

        it("keeps the settings and what was fired across a restart — the phone is not told twice", async () => {
            const file = path.join(dir, "usage_alerts.json");
            const first = new UsageAlerts(file, () => t);
            await first.load();
            await first.setSettings({ dailyUsd: [1], perCallerUsd: {}, spikeFactor: 0, spikeMinUsd: 0.5 });
            const l = new UsageLedger(undefined, () => t);
            spend(l, 1.5);
            expect(first.evaluate(l)).toHaveLength(1);
            await first.flush();

            const again = new UsageAlerts(file, () => t);
            await again.load();
            expect(again.getSettings().dailyUsd).toEqual([1]);
            expect(again.evaluate(l)).toEqual([]);
        });
    });
});

// The point of D2: spend is never a reason to refuse a call.
describe("no cap", () => {
    it("records every call whatever the spend", () => {
        const ledger = new UsageLedger(undefined, () => NOW);
        const alerts = new UsageAlerts(undefined, () => NOW);
        void alerts.setSettings({ dailyUsd: [0.01], perCallerUsd: {}, spikeFactor: 0, spikeMinUsd: 0.5 });
        alerts.watch(ledger, vi.fn());
        for (let i = 0; i < 5; i++) spend(ledger, 10);
        expect(ledger.day().calls).toBe(5);
    });
});
