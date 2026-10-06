import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcediaApiServer } from "../../source/http/api_server.js";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { EventStore } from "../../source/store/event_store.js";
import { ActionTierStore } from "../../source/actions/action_tier_store.js";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";
import { NullAIProvider } from "../../source/ai/null_provider.js";
import { AgentService } from "../../source/agent/agent_service.js";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { ConnectorAction } from "../../source/types/connector_action.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// A port range of its own: test files run in parallel and must never collide with the other API tests.
let PORT = 48_600 + Math.floor(Math.random() * 300);
const nextPort = () => PORT++;

// Decodes arbitrary JSON responses so each test can assert on the field it cares about.
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

function mail(id: string, from: string): AcediaEvent {
    return {
        type: "email.received",
        ts: 1_000 + Number(id),
        source: "email",
        title: `Mail ${id}`,
        priority: "info",
        dedupeKey: `email-${id}`,
        meta: { messageId: id, from },
        read: false,
    };
}

// « Mets en indésirables tout ce qui vient d'aliexpress »: the selection is computed and frozen by LunAcedia
// when the batch is proposed, and a batch always waits for Master — whatever its tier says.
describe("AcediaApiServer — bulk_email", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;

    afterEach(async () => {
        server?.stop();
        server = undefined;
        await new Promise((r) => setTimeout(r, 10));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(tiers?: Record<string, string>) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-bulk-"));
        const store = new EventStore();
        for (const e of [
            mail("1", "AliExpress <promo@aliexpress.com>"),
            mail("2", "deals@aliexpress.com"),
            mail("3", "info@banque.fr"),
        ])
            store.push(e);
        const tierStore = new ActionTierStore(
            path.join(dir, "tiers.json"),
            path.join(dir, "overrides.json"),
        );
        if (tiers) await tierStore.patch(tiers);
        const executed: ConnectorAction[] = [];
        const gmail: IConnector = {
            slug: "email",
            name: "Gmail",
            poll: async () => [],
            executeAction: async (a) => {
                executed.push(a);
            },
        };
        const agent = new AgentService(path.join(dir, "agent_settings.json"));
        await agent.load();
        const rules = new GuardRulesStore(path.join(dir, "rules.json"));
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const stats = new GuardStats(path.join(dir, "stats.json"));
        const pipeline = new GuardPipeline({ rules, journal, stats, vipSenders: () => [] });
        server = new AcediaApiServer(
            store,
            [gmail],
            new IngestionHub([gmail]),
            null,
            new NullAIProvider(),
            undefined,
            tierStore,
            new PendingActionStore(null),
            undefined,
            undefined,
            undefined,
            { pipeline, rules, journal, stats },
            agent,
        );
        const port = nextPort();
        server.start(port);
        return { base: `http://localhost:${port}`, store, executed, rules };
    }

    const spamAli = {
        connector: "Gmail",
        // ids slipped in by a caller are never kept: the selection is LunAcedia's own
        action: {
            kind: "bulk_email",
            action: "mark_spam",
            match: { fromContains: "aliexpress" },
            sourceIds: ["3"],
        },
    };

    it("freezes the matching mails and waits, even with the tier on auto", async () => {
        const { base, executed } = await start({ bulk_email: "auto" });
        const r = await call("POST", `${base}/api/actions`, spamAli);
        expect(r.status).toBe(202);
        expect(executed).toEqual([]);
        const [pending] = (await call("GET", `${base}/api/actions/pending`)).body;
        expect(pending.action.sourceIds).toEqual(["2", "1"]);
        expect(pending.action.matched).toBe(2);
        expect(pending.summary).toBe(
            "Mettre un mail en indésirable × 2 — expéditeur contenant « aliexpress »",
        );
    });

    it("confirmed, it acts on the frozen mails and they leave the box", async () => {
        const { base, store, executed } = await start();
        const { body } = await call("POST", `${base}/api/actions`, spamAli);
        expect((await call("POST", `${base}/api/actions/${body.id}/confirm`)).status).toBe(204);
        expect(executed).toHaveLength(1);
        expect((executed[0] as { sourceIds: string[] }).sourceIds).toEqual(["2", "1"]);
        expect(store.get("email-1")).toBeUndefined();
        expect(store.get("email-2")).toBeUndefined();
        expect(store.get("email-3")).toBeDefined();
    });

    it("a kind set to manual is refused with where to change it", async () => {
        const { base } = await start({ bulk_email: "manual" });
        const r = await call("POST", `${base}/api/actions`, spamAli);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/manual.*Confiance/);
    });

    it("refuses a batch that matches nothing, and says so", async () => {
        const { base } = await start();
        const r = await call("POST", `${base}/api/actions`, {
            connector: "Gmail",
            action: {
                kind: "bulk_email",
                action: "archive_email",
                match: { fromContains: "nobody" },
            },
        });
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/no mail of the box matches/);
    });

    it("previews a selection without acting: how many, and a sample", async () => {
        const { base, executed } = await start();
        const r = await call("POST", `${base}/api/inbox/select`, {
            match: { fromContains: "aliexpress" },
        });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ matched: 2, limit: 200 });
        expect(r.body.sample.map((s: { key: string }) => s.key)).toEqual(["email-2", "email-1"]);
        expect(executed).toEqual([]);
    });

    // « à l'avenir, mets-les en indésirables »: a rule proposed, held for Master, added once confirmed.
    describe("create_rule", () => {
        const ruleAli = {
            connector: "Gmail",
            action: {
                kind: "create_rule",
                name: "AliExpress",
                match: { fromContains: "aliexpress" },
                action: "mark_spam",
            },
        };

        it("is held for Master whatever its tier, said in words, and changes no rule until confirmed", async () => {
            const { base, rules } = await start({ create_rule: "auto" });
            expect((await call("POST", `${base}/api/actions`, ruleAli)).status).toBe(202);
            expect(rules.getRules()).toEqual([]);
            const [pending] = (await call("GET", `${base}/api/actions/pending`)).body;
            expect(pending.summary).toBe(
                "Créer une règle « AliExpress » : Mettre un mail en indésirable à chaque collecte — expéditeur contenant « aliexpress »",
            );
        });

        it("confirmed, the rule joins the list and acts at the source from the next collection", async () => {
            const { base, rules, executed } = await start();
            const { body } = await call("POST", `${base}/api/actions`, ruleAli);
            expect((await call("POST", `${base}/api/actions/${body.id}/confirm`)).status).toBe(204);
            expect(executed).toEqual([]);
            expect(rules.getRules()).toEqual([
                expect.objectContaining({
                    name: "AliExpress",
                    enabled: true,
                    conditions: [{ field: "from", op: "contains", value: "aliexpress" }],
                    actions: [{ type: "source", action: "mark_spam" }],
                }),
            ]);
        });

        it("refuses a rule without a criterion, or a label rule without its label", async () => {
            const { base } = await start();
            const none = await call("POST", `${base}/api/actions`, {
                connector: "Gmail",
                action: { kind: "create_rule", name: "Tout", match: {}, action: "delete_email" },
            });
            expect(none.status).toBe(403);
            const noLabel = await call("POST", `${base}/api/actions`, {
                connector: "Gmail",
                action: {
                    kind: "create_rule",
                    name: "L",
                    match: { fromDomain: "x.com" },
                    action: "label_email",
                },
            });
            expect(noLabel.status).toBe(403);
        });
    });
});
