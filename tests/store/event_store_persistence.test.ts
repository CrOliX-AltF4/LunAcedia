import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

// Live NAS check 2026-09-28: the box (ADR-018) lived only in memory while dedup was on disk, so every
// restart emptied it for good — the mail was "already seen" and never collected again.

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

    it("reloads what was pushed, with its read state, and without what was removed", async () => {
        const store = new EventStore(1000, file);
        await store.load();
        store.push(mail("a", 1));
        store.push(mail("b", 2));
        store.push(mail("c", 3));
        store.markRead("email-a");
        store.remove("email-b");
        await store.flush();

        const again = new EventStore(1000, file);
        await again.load();
        expect(again.query().events.map((e) => [e.dedupeKey, e.read ?? false])).toEqual([
            ["email-c", false],
            ["email-a", true],
        ]);
    });

    it("starts empty, without throwing, when the file is missing or corrupt", async () => {
        const missing = new EventStore(1000, file);
        await missing.load();
        expect(missing.size).toBe(0);

        await fs.writeFile(file, "{ not json", "utf-8");
        const corrupt = new EventStore(1000, file);
        await corrupt.load();
        expect(corrupt.size).toBe(0);
    });

    it("keeps only the most recent entries up to its capacity on load", async () => {
        await fs.writeFile(
            file,
            JSON.stringify([mail("a", 1), mail("b", 2), mail("c", 3)]),
            "utf-8",
        );
        const store = new EventStore(2, file);
        await store.load();
        expect(store.query().events.map((e) => e.dedupeKey)).toEqual(["email-c", "email-b"]);
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
