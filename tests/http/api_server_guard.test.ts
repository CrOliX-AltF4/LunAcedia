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
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { RuleActionJournal } from "../../source/guards/rule_actor.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import type { GuardServices } from "../../source/guards/guard_services.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// A port range of its own: test files run in parallel and must never collide with the other API tests.
let PORT = 47_300 + Math.floor(Math.random() * 400);
const nextPort = () => PORT++;

function mail(id: string, from: string, extra: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: `mail ${id}`,
        priority: "info",
        dedupeKey: `email-${id}`,
        meta: { from, labels: [], headers: {} },
        ...extra,
    };
}

const dropShop = {
    name: "Shop",
    conditions: [{ field: "from", op: "domain", value: "shop.com" }],
    actions: [{ type: "drop" }],
};

// Decodes arbitrary JSON responses so each test can assert on the field it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(
    method: string,
    url: string,
    body?: unknown,
): Promise<{ status: number; body: any }> {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

describe("AcediaApiServer — ingestion guard routes", () => {
    let dir: string;
    let server: AcediaApiServer | undefined;
    let flushers: Array<() => Promise<void>> = [];

    afterEach(async () => {
        server?.stop();
        await Promise.all(flushers.map((f) => f()));
        flushers = [];
        await new Promise((r) => setTimeout(r, 20));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function start(withGuards = true) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "api-guard-"));
        const rules = new GuardRulesStore(path.join(dir, "rules.json"));
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const stats = new GuardStats(path.join(dir, "stats.json"));
        flushers.push(
            () => journal.flush(),
            () => stats.flush(),
        );
        const pipeline = new GuardPipeline({ rules, journal, stats, vipSenders: () => [] });
        const ruleActions = new RuleActionJournal(path.join(dir, "guard_actions.jsonl"));
        const guards: GuardServices = { pipeline, rules, journal, stats, ruleActions };
        const store = new EventStore();
        const hub = new IngestionHub([], path.join(dir, "seen.json"), pipeline);
        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        const port = nextPort();
        server = new AcediaApiServer(
            store,
            [],
            hub,
            null,
            new NullAIProvider(),
            undefined,
            new ActionTierStore(path.join(dir, "tiers.json")),
            new PendingActionStore(),
            undefined,
            undefined,
            undefined,
            withGuards ? guards : undefined,
        );
        server.start(port);
        return { base: `http://localhost:${port}`, guards, store, received };
    }

    it("answers 503 when the guards are not configured", async () => {
        const { base } = await start(false);
        expect((await call("GET", `${base}/api/guard/rules`)).status).toBe(503);
    });

    // what rules do at the source: one switch (law 3), and every mail touched shown.
    it("turns every rule's actions at the source off and on, and says so with the rules", async () => {
        const { base } = await start();
        expect((await call("GET", `${base}/api/guard/rules`)).body.sourceActions).toBe(true);
        const off = await call("PUT", `${base}/api/guard/source-actions`, { enabled: false });
        expect(off).toEqual({ status: 200, body: { enabled: false } });
        expect((await call("GET", `${base}/api/guard/rules`)).body.sourceActions).toBe(false);
        expect((await call("PUT", `${base}/api/guard/source-actions`, { enabled: "no" })).status).toBe(400);
    });

    it("lists what rules did at the source, newest first", async () => {
        const { base, guards } = await start();
        guards.ruleActions!.record({ ts: 1, ruleId: "r", action: "mark_spam", key: "email-1", title: "Soldes", from: "x@ali.com", ok: true });
        const r = await call("GET", `${base}/api/guard/actions`);
        expect(r.status).toBe(200);
        expect(r.body.entries).toEqual([expect.objectContaining({ ruleId: "r", action: "mark_spam", ok: true })]);
    });

    it("starts with no rule and version 0", async () => {
        const { base } = await start();
        const res = await call("GET", `${base}/api/guard/rules`);
        expect(res).toMatchObject({ status: 200, body: { version: 0, rules: [], stats: {} } });
    });

    it("saves a valid rule list, assigns ids, bumps the version", async () => {
        const { base } = await start();
        const put = await call("PUT", `${base}/api/guard/rules`, { rules: [dropShop] });
        expect(put.status).toBe(200);
        expect(put.body.version).toBe(1);
        expect(put.body.rules[0]).toMatchObject({ name: "Shop", enabled: true });
        expect(put.body.rules[0].id).toBeTruthy();
        const get = await call("GET", `${base}/api/guard/rules`);
        expect(get.body.rules).toHaveLength(1);
    });

    it("refuses an invalid list with 400 and an explanation, leaving the rules untouched", async () => {
        const { base } = await start();
        await call("PUT", `${base}/api/guard/rules`, { rules: [dropShop] });
        const bad = await call("PUT", `${base}/api/guard/rules`, {
            rules: [
                {
                    name: "regex!",
                    conditions: [{ field: "from", op: "regex", value: ".*" }],
                    actions: [{ type: "drop" }],
                },
            ],
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toContain("from.op");
        expect((await call("GET", `${base}/api/guard/rules`)).body.version).toBe(1);
    });

    it("lists the journal and restores an event, re-dispatching it through the hub", async () => {
        const { base, guards, received } = await start();
        await guards.rules.replaceAll([dropShop]);
        guards.pipeline.process(mail("1", "promo@shop.com"));

        const list = await call("GET", `${base}/api/guard/journal`);
        expect(list.body.total).toBe(1);
        expect(list.body.entries[0].event.dedupeKey).toBe("email-1");

        const restore = await call("POST", `${base}/api/guard/journal/restore`, {
            dedupeKey: "email-1",
        });
        expect(restore).toMatchObject({ status: 200, body: { restored: "email-1" } });
        expect(received.map((e) => e.dedupeKey)).toEqual(["email-1"]);
        expect((await call("GET", `${base}/api/guard/journal`)).body.total).toBe(0);
    });

    it("answers 404 for an unknown journal key and 400 without a key", async () => {
        const { base } = await start();
        expect(
            (await call("POST", `${base}/api/guard/journal/restore`, { dedupeKey: "email-nope" }))
                .status,
        ).toBe(404);
        expect((await call("POST", `${base}/api/guard/journal/restore`, {})).status).toBe(400);
    });

    it("previews candidate rules against the store and the journal without changing anything", async () => {
        const { base, guards, store } = await start();
        store.push(mail("a", "x@shop.com"));
        store.push(mail("b", "friend@home.org"));
        await guards.rules.replaceAll([
            {
                name: "keep",
                conditions: [{ field: "from", op: "domain", value: "home.org" }],
                actions: [{ type: "tag", tag: "ami" }],
            },
        ]);
        guards.pipeline.process(mail("c", "promo@other.com")); // not dropped: nothing in the journal

        const res = await call("POST", `${base}/api/guard/preview`, { rules: [dropShop] });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ evaluated: 2, wouldDrop: 1 });
        expect((await call("GET", `${base}/api/guard/journal`)).body.total).toBe(0);
        expect((await call("GET", `${base}/api/guard/rules`)).body.version).toBe(1);
    });

    it("previews the current rules when none are given, and refuses invalid candidates", async () => {
        const { base, guards, store } = await start();
        store.push(mail("a", "x@shop.com"));
        await guards.rules.replaceAll([dropShop]);
        expect((await call("POST", `${base}/api/guard/preview`, {})).body.wouldDrop).toBe(1);
        expect(
            (await call("POST", `${base}/api/guard/preview`, { rules: [{ name: "x" }] })).status,
        ).toBe(400);
    });

    it("filters /api/events by guard tag (case-insensitive)", async () => {
        const { base, store } = await start();
        store.push(mail("t1", "a@b.c", { tags: ["Travail"] }));
        store.push(mail("t2", "a@b.c"));
        const res = await call("GET", `${base}/api/events?tag=travail`);
        expect(res.body.events.map((e: AcediaEvent) => e.dedupeKey)).toEqual(["email-t1"]);
    });
});
