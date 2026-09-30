import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    ConversationFullError,
    ConversationStore,
    MAX_MESSAGES,
    titleFromText,
    toView,
} from "../../source/store/conversation_store.js";

// ADR-020 amendment 1, S1a — the pocket app's topics live here, server side.

function clock(start = Date.parse("2026-09-30T10:00:00Z")): () => number {
    let t = start;
    return () => (t += 1000);
}

function ids(): () => string {
    let n = 0;
    return () => `id-${++n}`;
}

describe("titleFromText", () => {
    it("keeps a short first message as it is, on one line", () => {
        expect(titleFromText("  Mails urgents\nde ce matin ")).toBe("Mails urgents de ce matin");
    });

    it("cuts a long one on a word", () => {
        const title = titleFromText("mot ".repeat(40));
        expect(title.length).toBeLessThanOrEqual(81);
        expect(title.endsWith("mot…")).toBe(true);
    });
});

describe("ConversationStore — in memory", () => {
    let store: ConversationStore;
    beforeEach(() => {
        store = new ConversationStore(undefined, clock(), ids());
    });

    it("creates a topic titled after its first message, then appends messages in order", async () => {
        const topic = await store.create("Qu'est-ce qui est urgent ?");
        expect(topic).toMatchObject({ title: "Qu'est-ce qui est urgent ?", archived: false, messageCount: 0 });

        await store.append(topic.id, { role: "user", text: "Qu'est-ce qui est urgent ?" });
        await store.append(topic.id, { role: "assistant", text: "Deux mails.", external: true });

        const messages = await store.messages(topic.id);
        expect(messages.map((m) => [m.role, m.text])).toEqual([
            ["user", "Qu'est-ce qui est urgent ?"],
            ["assistant", "Deux mails."],
        ]);
        expect(store.get(topic.id)!.messageCount).toBe(2);
        expect(store.get(topic.id)!.updatedAt).toBe(messages[1]!.at);
    });

    it("lists the most recently active topic first, and filters archived ones", async () => {
        const a = await store.create("a");
        const b = await store.create("b");
        await store.append(a.id, { role: "user", text: "later" });
        await store.setArchived(b.id, true);

        expect(store.list().map((m) => m.id)).toEqual([a.id, b.id]);
        expect(store.list({ archived: false }).map((m) => m.id)).toEqual([a.id]);
        expect(store.list({ archived: true }).map((m) => m.id)).toEqual([b.id]);
    });

    it("pages backwards from the newest message", async () => {
        const t = await store.create("t");
        for (let i = 1; i <= 5; i++) await store.append(t.id, { role: "user", text: `m${i}` });

        const last = await store.page(t.id, { limit: 2 });
        expect(last.messages.map((m) => m.text)).toEqual(["m4", "m5"]);
        expect(last.hasMore).toBe(true);

        const before = await store.page(t.id, { limit: 2, before: last.messages[0]!.id });
        expect(before.messages.map((m) => m.text)).toEqual(["m2", "m3"]);

        const first = await store.page(t.id, { limit: 2, before: before.messages[0]!.id });
        expect(first.messages.map((m) => m.text)).toEqual(["m1"]);
        expect(first.hasMore).toBe(false);
    });

    it("renames, and remembers who named it", async () => {
        const t = await store.create("premier message");
        await store.rename(t.id, "Factures", "user");
        expect(store.get(t.id)).toMatchObject({ title: "Factures", titleSource: "user" });
    });

    it("refuses a message beyond the limit instead of dropping old ones", async () => {
        const t = await store.create("t");
        for (let i = 0; i < MAX_MESSAGES; i++) await store.append(t.id, { role: "user", text: "x" });
        expect(store.isFull(t.id)).toBe(true);
        await expect(store.append(t.id, { role: "user", text: "one more" })).rejects.toBeInstanceOf(
            ConversationFullError,
        );
        expect((await store.messages(t.id)).length).toBe(MAX_MESSAGES);
    });

    it("deletes a topic and its messages", async () => {
        const t = await store.create("t");
        await store.append(t.id, { role: "user", text: "x" });
        expect(await store.delete(t.id)).toBe(true);
        expect(store.get(t.id)).toBeUndefined();
        expect(store.list()).toEqual([]);
        expect(await store.delete(t.id)).toBe(false);
    });

    it("never exposes the internal summary or title source", async () => {
        const t = await store.create("t");
        await store.setSummary(t.id, { text: "earlier", covers: 4, external: true });
        const view = toView(store.get(t.id)!);
        expect(view).not.toHaveProperty("summary");
        expect(view).not.toHaveProperty("titleSource");
        expect(view).toMatchObject({ id: t.id, title: "t" });
    });
});

describe("ConversationStore — on disk", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-topics-"));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("survives a restart: topics, messages, archive state and summary", async () => {
        const store = new ConversationStore(dir, clock(), ids());
        const t = await store.create("Mails urgents");
        await store.append(t.id, { role: "user", text: "Mails urgents", about: "email-1" });
        await store.append(t.id, {
            role: "assistant",
            text: "Un seul.",
            external: true,
            agent: { version: 1, status: "done", items: [{ key: "email-1" }], actions: [] },
        });
        await store.setArchived(t.id, true);
        await store.setSummary(t.id, { text: "s", covers: 1, external: false });

        const again = new ConversationStore(dir);
        await again.load();
        expect(again.get(t.id)).toMatchObject({ title: "Mails urgents", archived: true, messageCount: 2 });
        expect(again.get(t.id)!.summary).toEqual({ text: "s", covers: 1, external: false });
        const messages = await again.messages(t.id);
        expect(messages[0]).toMatchObject({ role: "user", about: "email-1" });
        expect(messages[1]).toMatchObject({ role: "assistant", external: true, agent: { items: [{ key: "email-1" }] } });
    });

    it("keeps the rest of a topic when its last line was torn by a crash", async () => {
        const store = new ConversationStore(dir, clock(), ids());
        const t = await store.create("t");
        await store.append(t.id, { role: "user", text: "kept" });
        await fs.appendFile(path.join(dir, `${t.id}.jsonl`), '{"id":"torn","role":"us', "utf-8");

        const again = new ConversationStore(dir);
        await again.load();
        expect((await again.messages(t.id)).map((m) => m.text)).toEqual(["kept"]);
    });

    it("starts empty on a missing or corrupt index", async () => {
        const missing = new ConversationStore(dir);
        await missing.load();
        expect(missing.list()).toEqual([]);

        await fs.writeFile(path.join(dir, "index.json"), "{ not json", "utf-8");
        const corrupt = new ConversationStore(dir);
        await corrupt.load();
        expect(corrupt.list()).toEqual([]);
    });

    it("removes the message file on delete and journals every change", async () => {
        const store = new ConversationStore(dir, clock(), ids());
        const t = await store.create("t");
        await store.append(t.id, { role: "user", text: "x" });
        await store.rename(t.id, "T", "user");
        await store.setArchived(t.id, true);
        await store.delete(t.id);

        await expect(fs.access(path.join(dir, `${t.id}.jsonl`))).rejects.toThrow();
        const journal = (await fs.readFile(path.join(dir, "journal.jsonl"), "utf-8"))
            .trim()
            .split("\n")
            .map((l) => (JSON.parse(l) as { op: string }).op);
        expect(journal).toEqual(["create", "rename", "archive", "delete"]);
    });

    it("keeps the index consistent under concurrent changes", async () => {
        const store = new ConversationStore(dir, clock(), ids());
        const topics = await Promise.all([1, 2, 3, 4, 5].map((i) => store.create(`t${i}`)));
        await Promise.all(topics.map((t) => store.append(t.id, { role: "user", text: "x" })));

        const again = new ConversationStore(dir);
        await again.load();
        expect(again.list()).toHaveLength(5);
        expect(again.list().every((m) => m.messageCount === 1)).toBe(true);
    });
});
