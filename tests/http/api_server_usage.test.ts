import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { AgentService } from "../../source/agent/agent_service.js";
import { UsageLedger, localDay } from "../../source/usage/llm_usage.js";
import { UsageAlerts } from "../../source/usage/usage_alerts.js";
import type { IAIProvider } from "../../source/ai/ai_provider.js";

// GET /api/usage and the alert settings; and every request's LLM calls land under the right caller.

let PORT = 49_800 + Math.floor(Math.random() * 200);
const nextPort = () => PORT++;

async function call(
    method: string,
    url: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("AcediaApiServer — usage", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(ai: IAIProvider, ledger: UsageLedger, alerts: UsageAlerts) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-usage-"));
        // One unread item: the digest only calls the model when there is something to summarize.
        const store = new EventStore();
        store.push({
            type: "email.received",
            ts: Date.now(),
            source: "email",
            title: "Un mail",
            priority: "normal",
            dedupeKey: "email-1",
        });
        server = new AcediaApiServer(
            store,
            [],
            new IngestionHub([]),
            null,
            ai,
            undefined,
            new ActionTierStore(path.join(dir, "tiers.json"), path.join(dir, "overrides.json")),
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            undefined,
            new AgentService(),
            undefined,
            undefined,
            { ledger, alerts },
        );
        const port = nextPort();
        server.start(port);
        return `http://localhost:${port}`;
    }

    /** A provider that records a call like the real ones do, into `ledger`. */
    function recordingAi(ledger: UsageLedger): IAIProvider {
        return {
            mode: "openai",
            chat: vi.fn(async () => {
                ledger.record("gpt-4o-mini", 1_000_000, 0);
                return "ok";
            }),
            digest: vi.fn(async () => {
                ledger.record("gpt-4o-mini", 1_000_000, 0);
                return "digest";
            }),
        };
    }

    it("reports every day of the range, the rows, the alert settings and what fired", async () => {
        const ledger = new UsageLedger();
        const alerts = new UsageAlerts();
        await alerts.setSettings({
            dailyUsd: [0.1],
            perCallerUsd: {},
            spikeFactor: 0,
            spikeMinUsd: 0.5,
        });
        alerts.watch(ledger, () => {});
        const base = await start(recordingAi(ledger), ledger, alerts);

        await call("GET", `${base}/api/digest`);
        const r = await call("GET", `${base}/api/usage?days=7`);
        expect(r.status).toBe(200);
        expect(r.body.days).toHaveLength(7);
        expect(r.body.days[0]).toMatchObject({ day: localDay(Date.now()), calls: 1 });
        expect(r.body.rows[0]).toMatchObject({
            caller: "api",
            purpose: "digest",
            model: "gpt-4o-mini",
        });
        expect(r.body.alerts.dailyUsd).toEqual([0.1]);
        expect(r.body.fired.map((a: { kind: string }) => a.kind)).toEqual(["daily"]);
    });

    it("counts the Core's agent requests under the Core — the declared caller wins", async () => {
        const ledger = new UsageLedger();
        const ai: IAIProvider = {
            mode: "openai",
            chat: vi.fn(async () => ""),
            digest: vi.fn(async () => ""),
            chatWithTools: vi.fn(async () => {
                ledger.record("gpt-4o-mini", 10, 10);
                return { content: "ok", toolCalls: [] };
            }),
        };
        const base = await start(ai, ledger, new UsageAlerts());
        await call("POST", `${base}/api/agent`, { text: "mails ?", callerId: "natsume-core" });
        await call("POST", `${base}/api/agent`, { text: "mails ?" });
        const callers = ledger
            .list(1)
            .map((row) => `${row.caller}/${row.purpose}`)
            .sort();
        expect(callers).toEqual(["api/agent", "core/agent"]);
    });

    it("reads and changes the alert settings, refusing invalid ones", async () => {
        const ledger = new UsageLedger();
        const base = await start(recordingAi(ledger), ledger, new UsageAlerts());
        const put = await call("PUT", `${base}/api/config/usage-alerts`, {
            dailyUsd: [5, 2],
            perCallerUsd: { topics: [1] },
            spikeFactor: 3,
            spikeMinUsd: 1,
        });
        expect(put.body).toEqual({
            dailyUsd: [2, 5],
            perCallerUsd: { topics: [1] },
            spikeFactor: 3,
            spikeMinUsd: 1,
        });
        expect((await call("GET", `${base}/api/config/usage-alerts`)).body.spikeFactor).toBe(3);
        expect(
            (await call("PUT", `${base}/api/config/usage-alerts`, { dailyUsd: ["x"] })).status,
        ).toBe(400);
    });
});
