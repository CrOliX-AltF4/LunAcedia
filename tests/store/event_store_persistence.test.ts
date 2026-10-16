import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// Live NAS check 2026-09-28: the box lived only in memory while dedup was on disk, so every
// restart emptied it for good — the mail was "already seen" and never collected again. Since then the box and
// dedup are one state in one file: the items held, and the keys gone that must not come back.

function mail(id: string, ts: number, read = false): AcediaEvent {
    return {
        type: "email.received",
        ts,
        source: "email",
        title: `Mail ${id}`,
        priority: "normal",
        dedupeKey: `email-${id}`,
        read,
    };
}

describe("EventStore — the box survives a restart", () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "acedia-box-"));
        file = path.join(dir, "inbox_store.json");
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("reloads what was pushed, with its read state, without what was removed, and the keys gone", async () => {
        const store = new EventStore(1000, file);
        await store.load();
        store.push(mail("a", 1));
        store.push(mail("b", 2));
        store.push(mail("c", 3));
        store.markRead("email-a");
        store.remove("email-b");
        store.markGone("rss-old", 5);
        await store.flush();
        // Written atomically: no temporary file left behind.
        expect(await fs.readdir(dir)).toEqual(["inbox_store.json"]);

        const again = new EventStore(1000, file);
        await again.load();
        expect(again.isFresh()).toBe(false);
        expect(again.query().events.map((e) => [e.dedupeKey, e.read ?? false])).toEqual([
            ["email-c", false],
            ["email-a", true],
        ]);
        expect(again.knows("rss-old")).toBe(true);
        expect(again.knows("email-b")).toBe(false);
    });

    it("starts empty and fresh, without throwing, when the file is missing or corrupt", async () => {
        const missing = new EventStore(1000, file);
        await missing.load();
        expect(missing.size).toBe(0);
        expect(missing.isFresh()).toBe(true);

        await fs.writeFile(file, "{ not json", "utf-8");
        const corrupt = new EventStore(1000, file);
        await corrupt.load();
        expect(corrupt.size).toBe(0);
        expect(corrupt.isFresh()).toBe(true);
    });

    it("reads the old file (a bare list), keeping only the most recent entries up to its capacity", async () => {
        await fs.writeFile(
            file,
            JSON.stringify([mail("a", 1), mail("b", 2), mail("c", 3)]),
            "utf-8",
        );
        const store = new EventStore(2, file);
        await store.load();
        expect(store.query().events.map((e) => e.dedupeKey)).toEqual(["email-c", "email-b"]);
    });

    // Past capacity the oldest item leaves: remembered as gone, or the next collection would announce it as new.
    it("remembers an evicted item as gone, and holds a gone key again when it is pushed", () => {
        const store = new EventStore(2);
        store.push(mail("a", 1));
        store.push(mail("b", 2));
        store.push(mail("c", 3));
        expect(store.has("email-a")).toBe(false);
        expect(store.isGone("email-a")).toBe(true);
        store.push(mail("a", 4));
        expect(store.isGone("email-a")).toBe(false);
        expect(store.has("email-a")).toBe(true);
    });

    it("forgets the keys gone before a cutoff, never a held item", () => {
        const store = new EventStore();
        store.push(mail("held", 1));
        store.markGone("old", 10);
        store.markGone("recent", 100);
        expect(store.purgeGone(50)).toBe(1);
        expect(store.knows("old")).toBe(false);
        expect(store.knows("recent")).toBe(true);
        expect(store.knows("email-held")).toBe(true);
    });

    it("says whether it holds a key", () => {
        const store = new EventStore();
        store.push(mail("a", 1));
        expect(store.has("email-a")).toBe(true);
        expect(store.has("email-z")).toBe(false);
    });

    it("writes nothing when it has no file (tests, tools)", async () => {
        const store = new EventStore();
        store.push(mail("a", 1));
        await store.flush();
        expect(await fs.readdir(dir)).toEqual([]);
    });
});

describe("EventStore — newest first by date, not by arrival", () => {
    it("lists an older mail collected late below the newer ones", () => {
        const store = new EventStore();
        store.push(mail("new", 300));
        store.push(mail("mid", 200));
        store.push(mail("old", 100));
        store.push(mail("newest", 400));
        expect(store.query().events.map((e) => e.dedupeKey)).toEqual([
            "email-newest",
            "email-new",
            "email-mid",
            "email-old",
        ]);
    });
});
