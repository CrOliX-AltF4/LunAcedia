import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuardJournal } from "../../source/guards/guard_journal.js";
import { GuardPipeline } from "../../source/guards/guard_pipeline.js";
import { GuardRulesStore } from "../../source/guards/guard_rules_store.js";
import { GuardStats } from "../../source/guards/guard_stats.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

const DAY = 24 * 60 * 60 * 1000;

function mail(id: string, from = "deals@mail.aliexpress.com", title = "Promo"): AcediaEvent {
    return { type: "email.received", ts: 1, source: "email", title, priority: "info", dedupeKey: `email-${id}`, meta: { from, labels: ["INBOX"], headers: {} } };
}

const dropAli = { id: "drop-ali", name: "AliExpress", enabled: true, conditions: [{ field: "from", op: "domain", value: "aliexpress.com" }], actions: [{ type: "drop" }] };
const tagWork = { id: "tag-work", name: "Travail", enabled: true, conditions: [{ field: "from", op: "domain", value: "corp.com" }], actions: [{ type: "tag", tag: "travail" }, { type: "set_priority", priority: "normal" }] };

describe("GuardPipeline", () => {
    let dir: string;
    afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

    async function setup(rules: unknown[] = [], vip: string[] = []) {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-pipeline-"));
        const rulesStore = new GuardRulesStore(path.join(dir, "rules.json"));
        await rulesStore.replaceAll(rules);
        const journal = new GuardJournal(path.join(dir, "journal.jsonl"));
        const stats = new GuardStats(path.join(dir, "stats.json"));
        const pipeline = new GuardPipeline({ rules: rulesStore, journal, stats, vipSenders: () => vip });
        return { rulesStore, journal, stats, pipeline };
    }

    it("drops a matching event, journals it and counts the hit", async () => {
        const { pipeline, journal, stats } = await setup([dropAli]);
        const out = pipeline.process(mail("1"));
        expect(out.dropped).toBe(true);
        expect(journal.isFiltered("email-1")).toBe(true);
        expect(journal.get("email-1")!.ruleId).toBe("drop-ali");
        expect(stats.get("drop-ali").hits).toBe(1);
    });

    it("passes an unmatched event through unchanged (same object, nothing recorded)", async () => {
        const { pipeline, journal } = await setup([dropAli]);
        const event = mail("2", "friend@home.org");
        const out = pipeline.process(event);
        expect(out).toEqual({ dropped: false, event });
        expect(out.event).toBe(event);
        expect(journal.size).toBe(0);
    });

    it("applies tags, priority and ruleId to a copy — the input event is never mutated", async () => {
        const { pipeline } = await setup([tagWork]);
        const event = mail("3", "boss@corp.com");
        const out = pipeline.process(event);
        expect(out.dropped).toBe(false);
        expect(out.event).toMatchObject({ tags: ["travail"], priority: "normal", ruleId: "tag-work" });
        expect(event.tags).toBeUndefined();
        expect(event.priority).toBe("info");
    });

    it("never drops a VIP sender, even when a rule says so", async () => {
        const { pipeline, journal } = await setup([dropAli], ["deals@mail.aliexpress.com"]);
        expect(pipeline.process(mail("4")).dropped).toBe(false);
        expect(journal.size).toBe(0);
    });

    it("marks a dropped key as settled only while the rules are unchanged", async () => {
        const { pipeline, rulesStore } = await setup([dropAli]);
        pipeline.process(mail("5"));
        expect(pipeline.isSettled("email-5")).toBe(true);
        await rulesStore.replaceAll([]);
        expect(pipeline.isSettled("email-5")).toBe(false);
        expect(pipeline.isSettled("email-unknown")).toBe(false);
    });

    it("releases an event from the journal when a rule edit stops dropping it, without forcing it through later", async () => {
        const { pipeline, rulesStore, journal } = await setup([dropAli]);
        pipeline.process(mail("6"));
        await rulesStore.replaceAll([]);
        expect(pipeline.process(mail("6")).dropped).toBe(false);
        expect(journal.isFiltered("email-6")).toBe(false);
        expect(journal.isRestored("email-6")).toBe(false);
        await rulesStore.replaceAll([dropAli]);
        expect(pipeline.process(mail("6")).dropped).toBe(true);
    });

    it("restores an event once: it is returned for re-dispatch and never evaluated or dropped again", async () => {
        const { pipeline, journal } = await setup([dropAli]);
        pipeline.process(mail("7"));
        const restored = pipeline.restore("email-7");
        expect(restored?.dedupeKey).toBe("email-7");
        expect(journal.isFiltered("email-7")).toBe(false);
        expect(pipeline.process(mail("7")).dropped).toBe(false);
        expect(pipeline.restore("email-7")).toBeUndefined();
    });

    it("previews candidate rules without recording, counting or journaling anything", async () => {
        const { pipeline, journal, stats } = await setup([], ["boss@corp.com"]);
        const events = [mail("a"), mail("b"), mail("c", "boss@corp.com"), mail("d", "friend@home.org")];
        const preview = pipeline.preview(
            [dropAli, { ...tagWork, conditions: [{ field: "from", op: "domain", value: "home.org" }] }] as never,
            events,
        );
        expect(preview).toMatchObject({ evaluated: 4, wouldDrop: 2, wouldTag: 1, wouldChangePriority: 1, vipProtected: 0 });
        expect(preview.sample.map((s) => s.outcome)).toEqual(["drop", "drop", "tag"]);
        expect(journal.size).toBe(0);
        expect(stats.getAll()).toEqual({});
    });

    it("reports a VIP-protected mail in the preview", async () => {
        const { pipeline } = await setup([], ["deals@mail.aliexpress.com"]);
        const preview = pipeline.preview([dropAli] as never, [mail("v")]);
        expect(preview).toMatchObject({ wouldDrop: 0, vipProtected: 1 });
    });
});

describe("GuardJournal", () => {
    let dir: string;
    afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

    async function freshFile(): Promise<string> {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-journal-"));
        return path.join(dir, "journal.jsonl");
    }

    it("persists entries and restores its state, including tombstones, after a restart", async () => {
        const file = await freshFile();
        const a = new GuardJournal(file);
        a.record(mail("1"), "r1", 1_000);
        a.record(mail("2"), "r1", 2_000);
        a.restore("email-2", 3_000);
        await a.flush();

        const b = new GuardJournal(file);
        await b.load(4_000);
        expect(b.list().map((e) => e.event.dedupeKey)).toEqual(["email-1"]);
        expect(b.isRestored("email-2")).toBe(true);
    });

    it("does not duplicate an event re-recorded with the same rule (restart, cache miss)", async () => {
        const file = await freshFile();
        const j = new GuardJournal(file);
        j.record(mail("1"), "r1", 1_000);
        j.record(mail("1"), "r1", 2_000);
        await j.flush();
        const lines = (await fs.readFile(file, "utf-8")).trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(j.get("email-1")!.ts).toBe(1_000);
    });

    it("lists newest first and honours the limit", async () => {
        const j = new GuardJournal(await freshFile());
        j.record(mail("old"), "r", 1_000);
        j.record(mail("new"), "r", 9_000);
        expect(j.list(1).map((e) => e.event.dedupeKey)).toEqual(["email-new"]);
    });

    it("prunes entries past the retention window and compacts the file", async () => {
        const file = await freshFile();
        const j = new GuardJournal(file, 30);
        const now = 100 * DAY;
        j.record(mail("stale"), "r", now - 40 * DAY);
        j.record(mail("fresh"), "r", now - 1 * DAY);
        await j.flush();
        await j.prune(now);
        expect(j.list().map((e) => e.event.dedupeKey)).toEqual(["email-fresh"]);
        expect((await fs.readFile(file, "utf-8")).trim().split("\n")).toHaveLength(1);
    });

    it("survives a corrupt line without losing the rest of the journal", async () => {
        const file = await freshFile();
        const good = JSON.stringify({ kind: "filtered", ts: 5, ruleId: "r", event: mail("ok") });
        await fs.writeFile(file, `${good}\n{ torn line\n`, "utf-8");
        const j = new GuardJournal(file);
        await j.load(10);
        expect(j.isFiltered("email-ok")).toBe(true);
    });
});

describe("GuardStats", () => {
    it("counts hits per rule, persists them, and forgets deleted rules", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "guard-stats-"));
        try {
            const file = path.join(dir, "stats.json");
            const s = new GuardStats(file);
            s.hit(["a", "b"], 10);
            s.hit(["a"], 20);
            expect(s.get("a")).toEqual({ hits: 2, lastHitTs: 20 });
            s.prune(new Set(["a"]));
            expect(s.get("b")).toEqual({ hits: 0, lastHitTs: 0 });
            await s.flush();

            const reloaded = new GuardStats(file);
            await reloaded.load();
            expect(reloaded.get("a")).toEqual({ hits: 2, lastHitTs: 20 });
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
