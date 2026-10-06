import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuleActor, RuleActionJournal } from "../../source/guards/rule_actor.js";
import type { IConnector } from "../../source/connectors/connector_interface.js";
import type { ConnectorAction } from "../../source/types/connector_action.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// What a confirmed rule does at the source: Gmail acts, each mail touched is journaled with its rule.

const mail: AcediaEvent = {
    type: "email.received",
    ts: 5,
    source: "email",
    title: "Soldes",
    priority: "info",
    dedupeKey: "email-m1",
    meta: { messageId: "m1", from: "promo@aliexpress.com" },
};

describe("createRuleActor", () => {
    let dir: string | undefined;
    let journals: RuleActionJournal[] = [];
    afterEach(async () => {
        await Promise.all(journals.map((j) => j.flush()));
        journals = [];
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
        dir = undefined;
    });

    async function setup(fail = false) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "rule-actor-"));
        const executed: ConnectorAction[] = [];
        const gmail: IConnector = {
            slug: "email",
            name: "Gmail",
            poll: async () => [],
            executeAction: vi.fn(async (a: ConnectorAction) => {
                if (fail) throw new Error("Gmail said no");
                executed.push(a);
            }),
        };
        const journal = new RuleActionJournal(path.join(dir, "guard_actions.jsonl"));
        journals.push(journal);
        return { act: createRuleActor({ connectors: [gmail], journal }), executed, journal };
    }

    it("acts in Gmail on the mail, says it left the inbox, and journals it with the rule", async () => {
        const { act, executed, journal } = await setup();
        const r = await act(mail, [
            { ruleId: "spam-ali", action: "mark_spam" },
            { ruleId: "lbl", action: "label_email", label: "Pubs" },
        ]);
        expect(r).toEqual({ removed: true, read: false });
        // the label first: what takes the mail out of the inbox comes last
        expect(executed).toEqual([
            { kind: "label_email", sourceId: "m1", label: "Pubs" },
            { kind: "mark_spam", sourceId: "m1" },
        ]);
        expect(journal.list().map((j) => [j.ruleId, j.action, j.ok, j.key])).toEqual([
            ["spam-ali", "mark_spam", true, "email-m1"],
            ["lbl", "label_email", true, "email-m1"],
        ]);
    });

    it("a refusal at the source keeps the mail in the box and is journaled with why", async () => {
        const { act, journal } = await setup(true);
        expect(await act(mail, [{ ruleId: "spam-ali", action: "mark_spam" }])).toEqual({ removed: false, read: false });
        expect(journal.list()[0]).toMatchObject({ ok: false, error: "Gmail said no", title: "Soldes" });
    });

    it("marks read", async () => {
        const { act } = await setup();
        expect(await act(mail, [{ ruleId: "r", action: "mark_email_read" }])).toEqual({ removed: false, read: true });
    });

    it("the journal survives a restart", async () => {
        const { act, journal } = await setup();
        await act(mail, [{ ruleId: "r", action: "archive_email" }]);
        await journal.flush();
        const again = new RuleActionJournal(path.join(dir!, "guard_actions.jsonl"));
        await again.load();
        expect(again.list()).toHaveLength(1);
    });
});
