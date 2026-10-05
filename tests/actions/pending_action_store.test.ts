import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PendingActionStore, pendingTtlMs } from "../../source/actions/pending_action_store.js";

const HOUR = 60 * 60 * 1000;

describe("PendingActionStore", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("create() returns an entry retrievable via get()", () => {
        const store = new PendingActionStore(null);
        const entry = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        expect(store.get(entry.id)).toEqual(entry);
    });

    it("consume() returns the entry once and removes it", () => {
        const store = new PendingActionStore(null);
        const entry = store.create("Tasks", { kind: "complete_task", sourceId: "t1" });
        expect(store.consume(entry.id)).toEqual(entry);
        expect(store.consume(entry.id)).toBeUndefined();
        expect(store.get(entry.id)).toBeUndefined();
    });

    it("get() returns undefined for an unknown id", () => {
        const store = new PendingActionStore(null);
        expect(store.get("nope")).toBeUndefined();
    });

    it("list() returns every currently pending entry", () => {
        const store = new PendingActionStore(null);
        const a = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        const b = store.create("Tasks", { kind: "complete_task", sourceId: "t1" });
        const ids = store
            .list()
            .map((e) => e.id)
            .sort();
        expect(ids).toEqual([a.id, b.id].sort());
    });

    // Each kind its own delay: a reply goes stale fast, an event to create does not.
    it("gives each kind its own delay and says when it expires", () => {
        expect(pendingTtlMs("reply")).toBe(2 * HOUR);
        expect(pendingTtlMs("comment_issue")).toBe(2 * HOUR);
        expect(pendingTtlMs("delete_event")).toBe(2 * HOUR);
        expect(pendingTtlMs("close_issue")).toBe(2 * HOUR);
        expect(pendingTtlMs("open_pr")).toBe(2 * HOUR);
        expect(pendingTtlMs("create_event")).toBe(24 * HOUR);
        expect(pendingTtlMs("update_event")).toBe(24 * HOUR);
        expect(pendingTtlMs("create_task")).toBe(24 * HOUR);
        expect(pendingTtlMs("create_issue")).toBe(24 * HOUR);

        const store = new PendingActionStore(null);
        const entry = store.create("Calendar", {
            kind: "create_event",
            fields: { summary: "Banque", start: "2026-10-06T10:00", end: "2026-10-06T11:00" },
        });
        expect(entry.expiresAt).toBe(entry.createdAt + 24 * HOUR);
    });

    it("a reply expires after 2 hours, not before", () => {
        const store = new PendingActionStore(null);
        const entry = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        vi.advanceTimersByTime(2 * HOUR - 1000);
        expect(store.get(entry.id)).toEqual(entry);
        vi.advanceTimersByTime(2000);
        expect(store.get(entry.id)).toBeUndefined();
        expect(store.list()).toEqual([]);
    });

    it("keeps where an action came from and whether a third party's text led to it", () => {
        const store = new PendingActionStore(null);
        const entry = store.create(
            "Gmail",
            { kind: "reply", sourceId: "m1", body: "hi" },
            { origin: "agent", untrusted: true },
        );
        expect(store.get(entry.id)).toMatchObject({ origin: "agent", untrusted: true });
    });
});

// A pending write survives a restart: it is a list Master comes back to, not a 5-minute window.
describe("PendingActionStore — durable", () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "pending-"));
        file = path.join(dir, "pending_actions.json");
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("finds its pending actions again after a restart, and forgets the ones decided", async () => {
        const before = new PendingActionStore(file);
        await before.load();
        const kept = before.create("Gmail", { kind: "reply", sourceId: "m1", body: "Noté." });
        const decided = before.create("Tasks", { kind: "complete_task", sourceId: "t1" });
        before.consume(decided.id);
        await before.flush();

        const after = new PendingActionStore(file);
        await after.load();
        expect(after.list()).toEqual([kept]);
    });

    it("drops what expired while it was down", async () => {
        const before = new PendingActionStore(file);
        await before.load();
        before.create("Gmail", { kind: "reply", sourceId: "m1", body: "Noté." });
        await before.flush();

        const later = Date.now() + 3 * HOUR;
        const after = new PendingActionStore(file, () => later);
        await after.load();
        expect(after.list()).toEqual([]);
    });

    it("never revives an unknown kind or a merge from the file — the catalogue decides, not the disk", async () => {
        const now = Date.now();
        const entry = (id: string, action: unknown) => ({
            id,
            connector: "GitHub",
            action,
            createdAt: now,
            expiresAt: now + HOUR,
        });
        await fs.writeFile(
            file,
            JSON.stringify([
                entry("a", { kind: "merge_pr", sourceId: "o/r#1" }),
                entry("b", { kind: "rm_rf", sourceId: "/" }),
                entry("c", { kind: "close_issue", sourceId: "o/r#2" }),
                "garbage",
            ]),
        );
        const store = new PendingActionStore(file);
        await store.load();
        expect(store.list().map((e) => e.id)).toEqual(["c"]);
    });

    it("starts empty on a missing or unreadable file", async () => {
        await fs.writeFile(file, "{not json");
        const store = new PendingActionStore(file);
        await store.load();
        expect(store.list()).toEqual([]);
    });
});
