import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLegacyPriority } from "../../source/guards/priority_migration.js";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { EmailClassificationStore } from "../../source/connectors/email/email_classification_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// One way to set a priority: the keyword lists and GMAIL_RULES become guard rules, once, at startup — and every mail keeps
// the priority it had (the same substring on « sender + subject »), with a parity list of what was moved or not.

function mail(from: string, title: string): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title,
        priority: "info",
        dedupeKey: `email-${title}`,
        meta: { from },
    };
}

describe("migrateLegacyPriority", () => {
    let dir: string;
    afterEach(async () => {
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function setup(config?: {
        vipSenders?: string[];
        urgentKeywords?: string[];
        normalKeywords?: string[];
    }) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "prio-migr-"));
        const classification = new EmailClassificationStore(
            path.join(dir, "email_classification.json"),
        );
        if (config) await classification.patch(config);
        const rules = new GuardRulesStore(path.join(dir, "rules.json"));
        await rules.replaceAll([
            {
                id: "mine",
                name: "Ma règle",
                conditions: [{ field: "from", op: "domain", value: "corp.com" }],
                actions: [{ type: "set_priority", priority: "info" }],
            },
        ]);
        const pipeline = new GuardPipeline({
            rules,
            journal: new GuardJournal(path.join(dir, "journal.jsonl")),
            stats: new GuardStats(path.join(dir, "stats.json")),
            vipSenders: () => classification.getAll().vipSenders,
        });
        const run = (gmailRules?: string) =>
            migrateLegacyPriority({ classification, rules, gmailRules, storageDir: dir });
        const priorityOf = (from: string, title: string) =>
            pipeline.process(mail(from, title)).event.priority;
        return { classification, rules, run, priorityOf };
    }

    it("turns each keyword into two rules after the user's own, and every mail keeps its priority", async () => {
        const { run, rules, classification, priorityOf } = await setup({
            vipSenders: ["boss@x.fr"],
            urgentKeywords: ["deadline"],
            normalKeywords: ["facture"],
        });
        const report = await run();
        expect(report?.migrated).toHaveLength(2);
        expect(rules.getRules().map((r) => r.name)).toEqual([
            "Ma règle",
            "(migré) mot-clé urgent « deadline » — expéditeur",
            "(migré) mot-clé urgent « deadline » — sujet",
            "(migré) mot-clé normal « facture » — expéditeur",
            "(migré) mot-clé normal « facture » — sujet",
        ]);
        expect(classification.getAll()).toEqual({
            vipSenders: ["boss@x.fr"],
            urgentKeywords: [],
            normalKeywords: [],
        });
        expect(priorityOf("a@b.fr", "Deadline demain")).toBe("urgent");
        expect(priorityOf("deadline-bot@b.fr", "Rappel")).toBe("urgent");
        expect(priorityOf("a@b.fr", "Votre facture")).toBe("normal");
        // the VIP wins over every keyword, as before
        expect(priorityOf("boss@x.fr", "Votre facture")).toBe("urgent");
        // the user's own rule still comes first, as before (the guard ran after the classifier)
        expect(priorityOf("x@corp.com", "Deadline")).toBe("info");
    });

    it("takes GMAIL_RULES only when nothing was set in the store — it was ignored otherwise", async () => {
        const gmail = JSON.stringify([{ senderPattern: "@banque.fr", priority: "urgent" }]);
        const empty = await setup();
        const r1 = await empty.run(gmail);
        expect(r1?.migrated.map((m) => [m.source, m.pattern, m.priority])).toEqual([
            ["GMAIL_RULES", "@banque.fr", "urgent"],
        ]);
        expect(empty.priorityOf("conseiller@banque.fr", "RDV")).toBe("urgent");

        const configured = await setup({ vipSenders: ["boss@x.fr"] });
        const r2 = await configured.run(gmail);
        expect(r2?.migrated).toEqual([]);
        expect(r2?.skipped).toEqual([
            {
                source: "GMAIL_RULES",
                pattern: "@banque.fr",
                priority: "urgent",
                why: "ignored before: the classification store was set",
            },
        ]);
    });

    it("runs once: the parity list is written, a second start changes nothing", async () => {
        const { run, rules } = await setup({ urgentKeywords: ["deadline"] });
        await run();
        const before = rules.getRules().length;
        expect(await run()).toBeNull();
        expect(rules.getRules()).toHaveLength(before);
        const parity = JSON.parse(
            await fs.readFile(path.join(dir, "priority_migration.json"), "utf-8"),
        );
        expect(parity.migrated[0]).toMatchObject({
            source: "urgentKeywords",
            pattern: "deadline",
            priority: "urgent",
        });
    });

    it("keeps the former classification file beside the new one", async () => {
        const { run } = await setup({ urgentKeywords: ["deadline"] });
        await run();
        const backup = JSON.parse(
            await fs.readFile(path.join(dir, "email_classification.json.pre-v2"), "utf-8"),
        );
        expect(backup.urgentKeywords).toEqual(["deadline"]);
    });

    it("with nothing to move, only writes the parity list", async () => {
        const { run, rules } = await setup({ vipSenders: ["boss@x.fr"] });
        const report = await run();
        expect(report).toMatchObject({ migrated: [], skipped: [] });
        expect(rules.getRules()).toHaveLength(1);
    });
});
