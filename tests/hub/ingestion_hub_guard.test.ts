import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IngestionHub } from "../../source/hub/ingestion_hub.js";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

function mail(id: string, from: string, priority: AcediaEvent["priority"] = "info"): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: `mail ${id}`,
        priority,
        dedupeKey: `email-${id}`,
        meta: { from, labels: [], headers: {} },
    };
}

const dropShop = {
    id: "drop-shop",
    name: "Shop",
    conditions: [{ field: "from", op: "domain", value: "shop.com" }],
    actions: [{ type: "drop" }],
};
const promoteBoss = {
    id: "promote",
    name: "Boss",
    conditions: [{ field: "from", op: "domain", value: "corp.com" }],
    actions: [
        { type: "set_priority", priority: "urgent" },
        { type: "tag", tag: "travail" },
    ],
};

describe("IngestionHub — guard stage", () => {
    let dir: string;
    let hub: IngestionHub | undefined;
    let pending: Array<() => Promise<void>> = [];
    afterEach(async () => {
        hub?.stop();
        // The journal appends and the hub persists `seen` asynchronously: let them land before deleting the directory.
        await Promise.all(pending.map((f) => f()));
        pending = [];
        await new Promise((r) => setTimeout(r, 20));
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function setup(
        events: AcediaEvent[],
        rules: unknown[],
        vip: string[] = [],
        ruleActor?: ConstructorParameters<typeof IngestionHub>[4],
    ) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-guard-"));
        const rulesStore = new GuardRulesStore(path.join(dir, "rules.json"));
        await rulesStore.replaceAll(rules);
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const stats = new GuardStats(path.join(dir, "stats.json"));
        pending.push(
            () => journal.flush(),
            () => stats.flush(),
        );
        const pipeline = new GuardPipeline({
            rules: rulesStore,
            journal,
            stats,
            vipSenders: () => vip,
        });
        const settledFilter = vi.fn();
        const connector: IConnector = {
            slug: "email",
            name: "Mock",
            poll: vi.fn().mockResolvedValue(events),
            setSettledFilter: settledFilter,
        };
        hub = new IngestionHub(
            [connector],
            path.join(dir, "seen.json"),
            pipeline,
            undefined,
            ruleActor,
        );
        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        return { hub, received, journal, pipeline, rulesStore, connector, settledFilter };
    }

    it("dispatches what passes, drops what a rule drops, and journals the drop", async () => {
        const { hub, received, journal } = await setup(
            [mail("1", "promo@shop.com"), mail("2", "friend@home.org")],
            [dropShop],
        );
        await hub.pollOne("email");
        expect(received.map((e) => e.dedupeKey)).toEqual(["email-2"]);
        expect(journal.isFiltered("email-1")).toBe(true);
    });

    it("delivers tags, ruleId and the rule's priority on the dispatched event", async () => {
        const { hub, received } = await setup([mail("3", "boss@corp.com")], [promoteBoss]);
        await hub.pollOne("email");
        expect(received[0]).toMatchObject({
            tags: ["travail"],
            ruleId: "promote",
            priority: "urgent",
        });
    });

    it("lets a rule PROMOTE an event on the urgent path, which filters on priority", async () => {
        const { hub, received } = await setup(
            [mail("4", "boss@corp.com", "info"), mail("5", "friend@home.org", "info")],
            [promoteBoss],
        );
        // pollUrgent is private (driven by a 60 s timer): exercised directly so the urgent path is covered.
        await (hub as unknown as { pollUrgent(): Promise<void> }).pollUrgent();
        expect(received.map((e) => e.dedupeKey)).toEqual(["email-4"]);
    });

    it("never drops a VIP sender", async () => {
        const { hub, received } = await setup(
            [mail("6", "promo@shop.com")],
            [dropShop],
            ["promo@shop.com"],
        );
        await hub.pollOne("email");
        expect(received).toHaveLength(1);
    });

    it("hands each connector a predicate that is true for dispatched keys and for guard-dropped keys", async () => {
        const { hub, settledFilter } = await setup(
            [mail("7", "promo@shop.com"), mail("8", "friend@home.org")],
            [dropShop],
        );
        await hub.pollOne("email");
        const isSettled = settledFilter.mock.calls[0]![0] as (key: string) => boolean;
        expect(isSettled("email-7")).toBe(true); // dropped under the current rules
        expect(isSettled("email-8")).toBe(true); // already dispatched
        expect(isSettled("email-unknown")).toBe(false);
    });

    it("re-evaluates a dropped event after the rules change (the settled verdict is versioned)", async () => {
        const { hub, received, rulesStore, settledFilter } = await setup(
            [mail("9", "promo@shop.com")],
            [dropShop],
        );
        await hub.pollOne("email");
        expect(received).toHaveLength(0);
        await rulesStore.replaceAll([]);
        const isSettled = settledFilter.mock.calls[0]![0] as (key: string) => boolean;
        expect(isSettled("email-9")).toBe(false);
        await hub.pollOne("email");
        expect(received.map((e) => e.dedupeKey)).toEqual(["email-9"]);
    });

    it("dispatchRestored delivers a user-restored event, bypassing dedup and guard, and it is not dropped again", async () => {
        const { hub, received, pipeline } = await setup([mail("10", "promo@shop.com")], [dropShop]);
        await hub.pollOne("email");
        const event = pipeline.restore("email-10")!;
        hub.dispatchRestored(event);
        expect(received.map((e) => e.dedupeKey)).toEqual(["email-10"]);
        await hub.pollOne("email");
        expect(received).toHaveLength(1); // seen now, and never re-dropped
    });

    it("is inert without a guard: same behaviour as before the chantier", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-noguard-"));
        const plain: IConnector = {
            slug: "email",
            name: "Mock",
            poll: vi.fn().mockResolvedValue([mail("11", "promo@shop.com")]),
        };
        hub = new IngestionHub([plain], path.join(dir, "seen.json"));
        const received: AcediaEvent[] = [];
        hub.onEvent((e) => received.push(e));
        await hub.pollOne("email");
        expect(received).toHaveLength(1);
    });

    describe("actions at the source", () => {
        const spamAli = {
            id: "spam-ali",
            name: "AliExpress",
            conditions: [{ field: "from", op: "contains", value: "aliexpress" }],
            actions: [{ type: "source", action: "mark_spam" }],
        };
        const labelBank = {
            id: "label-bank",
            name: "Banque",
            conditions: [{ field: "from", op: "domain", value: "banque.fr" }],
            actions: [{ type: "source", action: "label_email", label: "Banque" }],
        };

        it("a mail a rule takes out of the inbox is acted on at the source, never announced, never acted on twice", async () => {
            const actor = vi.fn().mockResolvedValue({ removed: true, read: false });
            const { hub, received } = await setup(
                [mail("1", "promo@aliexpress.com"), mail("2", "friend@home.org")],
                [spamAli],
                [],
                actor,
            );
            await hub.pollOne("email");
            await hub.pollOne("email");
            expect(received.map((e) => e.dedupeKey)).toEqual(["email-2"]);
            expect(actor).toHaveBeenCalledTimes(1);
            expect(actor.mock.calls[0]![1]).toEqual([{ ruleId: "spam-ali", action: "mark_spam" }]);
        });

        it("when the source refuses, the mail stays in the box — a failed rule is never a lost mail", async () => {
            const actor = vi.fn().mockResolvedValue({ removed: false, read: false });
            const { hub, received } = await setup(
                [mail("1", "promo@aliexpress.com")],
                [spamAli],
                [],
                actor,
            );
            await hub.pollOne("email");
            expect(received.map((e) => e.dedupeKey)).toEqual(["email-1"]);
        });

        it("acts once per mail, even when the urgent pass sees it again before it is announced", async () => {
            const actor = vi.fn().mockResolvedValue({ removed: false, read: false });
            const { hub } = await setup([mail("3", "info@banque.fr")], [labelBank], [], actor);
            const urgent = (hub as unknown as { pollUrgent(): Promise<void> }).pollUrgent.bind(hub);
            await urgent();
            await urgent();
            await hub.pollOne("email");
            expect(actor).toHaveBeenCalledOnce();
        });

        it("a label is applied and the mail still arrives", async () => {
            const actor = vi.fn().mockResolvedValue({ removed: false, read: false });
            const { hub, received } = await setup(
                [mail("3", "info@banque.fr")],
                [labelBank],
                [],
                actor,
            );
            await hub.pollOne("email");
            expect(actor).toHaveBeenCalledOnce();
            expect(received).toHaveLength(1);
        });

        it("with the switch off, rules only sort the box: nothing is done at the source (law 3)", async () => {
            const actor = vi.fn();
            const { hub, received, rulesStore } = await setup(
                [mail("1", "promo@aliexpress.com")],
                [spamAli],
                [],
                actor,
            );
            await rulesStore.setSourceActionsEnabled(false);
            await hub.pollOne("email");
            expect(actor).not.toHaveBeenCalled();
            expect(received).toHaveLength(1);
        });
    });
});
