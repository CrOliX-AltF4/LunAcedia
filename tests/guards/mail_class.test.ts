import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    classifyMail,
    DEFAULT_CLASSES,
    readableByAi,
    classRings,
} from "../../source/guards/mail_class.js";
import { MailClassStore, validateMailClassPatch } from "../../source/guards/mail_class_store.js";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { GuardRulesStore, validateRules } from "../../source/guards/guard_rules_store.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";
import { EventStore } from "../../source/store/event_store.js";

// Mail sorted at collection without any model: a class says if it shows, if a model may read it, if it rings.

function mail(id: string, meta: Record<string, unknown> = {}): AcediaEvent {
    return {
        type: "email.received",
        ts: 1,
        source: "email",
        title: `Mail ${id}`,
        priority: "info",
        dedupeKey: `email-${id}`,
        meta: { from: "Someone <a@b.c>", labels: ["INBOX"], headers: {}, ...meta },
    };
}

describe("classifyMail", () => {
    const none = { personal: false, vip: false };

    it("reads what Gmail knows: promotions are advertising, social / updates / forums and mailing lists notifications", () => {
        expect(classifyMail(mail("1", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }), none)).toBe(
            "pub",
        );
        expect(classifyMail(mail("2", { labels: ["CATEGORY_SOCIAL"] }), none)).toBe("notification");
        expect(classifyMail(mail("3", { labels: ["CATEGORY_UPDATES"] }), none)).toBe(
            "notification",
        );
        expect(
            classifyMail(mail("4", { headers: { "list-unsubscribe": "<mailto:x>" } }), none),
        ).toBe("notification");
        expect(classifyMail(mail("5"), none)).toBe("inconnu");
    });

    it("a rule wins, then a personal sender; a VIP is never filed as bulk mail", () => {
        const promo = mail("1", { labels: ["CATEGORY_PROMOTIONS"] });
        expect(classifyMail(promo, { ...none, ruleClass: "pro", personal: true })).toBe("pro");
        expect(classifyMail(promo, { ...none, personal: true })).toBe("perso");
        expect(classifyMail(promo, { ...none, vip: true })).toBe("inconnu");
    });

    it("by default personal mail and advertising are not for a model, notifications and advertising do not ring", () => {
        const of = (c: string) => mail("x", { mailClass: c });
        expect(readableByAi(of("perso"), DEFAULT_CLASSES)).toBe(false);
        expect(readableByAi(of("pub"), DEFAULT_CLASSES)).toBe(false);
        expect(readableByAi(of("pro"), DEFAULT_CLASSES)).toBe(true);
        // Collected before the classes: « inconnu ».
        expect(readableByAi(mail("old"), DEFAULT_CLASSES)).toBe(true);
        expect(classRings(of("notification"), DEFAULT_CLASSES)).toBe(false);
        expect(classRings(of("perso"), DEFAULT_CLASSES)).toBe(true);
        const event: AcediaEvent = {
            ...mail("e"),
            source: "calendar",
            meta: { mailClass: "perso" },
        };
        expect(readableByAi(event, DEFAULT_CLASSES)).toBe(true);
    });
});

describe("mail classes in the pipeline and their settings", () => {
    let dir: string;
    afterEach(async () => {
        if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    });

    async function setup(rules: unknown[] = [], vip: string[] = []) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-class-"));
        const rulesStore = new GuardRulesStore(path.join(dir, "rules.json"));
        await rulesStore.replaceAll(rules);
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const classes = new MailClassStore(path.join(dir, "mail_classes.json"));
        const pipeline = new GuardPipeline({
            rules: rulesStore,
            journal,
            stats: new GuardStats(path.join(dir, "stats.json")),
            vipSenders: () => vip,
            classes,
        });
        return { pipeline, journal, classes };
    }

    it("gives every mail its class — a rule's, a personal sender's, Gmail's — and only mail", async () => {
        const rule = {
            id: "r-pro",
            name: "Boulot",
            enabled: true,
            conditions: [{ field: "from", op: "domain", value: "corp.com" }],
            actions: [{ type: "classify", mailClass: "pro" }],
        };
        const { pipeline, classes } = await setup([rule]);
        await classes.patch({ personalSenders: ["maman@"] });
        const classOf = (e: AcediaEvent) => pipeline.process(e).event.meta?.["mailClass"];
        expect(classOf(mail("1", { from: "Boss <boss@corp.com>" }))).toBe("pro");
        expect(classOf(mail("2", { from: "Maman <maman@famille.fr>" }))).toBe("perso");
        expect(classOf(mail("3", { labels: ["CATEGORY_PROMOTIONS"] }))).toBe("pub");
        expect(
            pipeline.prioritize(mail("4", { labels: ["CATEGORY_FORUMS"] })).meta?.["mailClass"],
        ).toBe("notification");
        const task: AcediaEvent = { ...mail("t"), source: "tasks", meta: {} };
        expect(classOf(task)).toBeUndefined();
    });

    it("a hidden class keeps its mail out, journaled and restorable — never a VIP's — and showing it again lets it in", async () => {
        const { pipeline, journal, classes } = await setup([], ["promo@vip.fr"]);
        await classes.patch({ classes: { pub: { visible: false } } });
        const promo = mail("1", { labels: ["CATEGORY_PROMOTIONS"] });
        expect(pipeline.process(promo).dropped).toBe(true);
        expect(journal.get("email-1")!.ruleId).toBe("class:pub");
        expect(pipeline.isSettled("email-1")).toBe(true);
        const vip = mail("2", { from: "promo@vip.fr", labels: ["CATEGORY_PROMOTIONS"] });
        expect(pipeline.process(vip).dropped).toBe(false);

        await classes.patch({ classes: { pub: { visible: true } } });
        expect(pipeline.isSettled("email-1")).toBe(false);
        expect(pipeline.process(promo).dropped).toBe(false);
    });

    it("the preview of a rule that classifies counts the mails that would change class", async () => {
        const { pipeline } = await setup();
        const rule = {
            id: "r",
            name: "x",
            enabled: true,
            conditions: [{ field: "from", op: "domain", value: "corp.com" }],
            actions: [{ type: "classify", mailClass: "pro" }],
        };
        const preview = pipeline.preview([rule] as never, [
            mail("1", { from: "a@corp.com", mailClass: "inconnu" }),
            mail("2", { from: "b@corp.com", mailClass: "pro" }),
            mail("3", { from: "c@else.org" }),
        ]);
        expect(preview.wouldClassify).toBe(1);
    });

    it("a mail filed by hand keeps its class when the source refreshes it", async () => {
        const store = new EventStore();
        store.push(mail("1", { mailClass: "pro", mailClassByHand: true }));
        const refreshed = store.refresh({
            ...mail("1", { mailClass: "pub" }),
            title: "Nouveau titre",
        });
        expect(refreshed!.meta).toMatchObject({ mailClass: "pro", mailClassByHand: true });
    });

    it("keeps its settings in a file, and refuses what it does not know", async () => {
        const { classes } = await setup();
        await classes.patch({ classes: { perso: { ai: true } }, personalSenders: [" papa@ ", ""] });
        const again = new MailClassStore(path.join(dir, "mail_classes.json"));
        await again.load();
        expect(again.get().classes.perso).toEqual({ visible: true, ai: true, rings: true });
        expect(again.get().personalSenders).toEqual(["papa@"]);
        expect(validateMailClassPatch({ classes: { spam: { ai: true } } })).toContain(
            "Unknown class",
        );
        expect(validateMailClassPatch({ classes: { pub: { ai: "no" } } })).toContain(
            "true or false",
        );
        expect(
            validateRules([
                {
                    id: "r",
                    name: "x",
                    enabled: true,
                    conditions: [{ field: "subject", op: "contains", value: "a" }],
                    actions: [{ type: "classify", mailClass: "spam" }],
                },
            ]).ok,
        ).toBe(false);
    });
});
