import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PendingActionStore } from "../../source/actions/pending_action_store.js";

describe("PendingActionStore", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("create() returns an entry retrievable via get()", () => {
        const store = new PendingActionStore();
        const entry = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        expect(store.get(entry.id)).toEqual(entry);
    });

    it("consume() returns the entry once and removes it", () => {
        const store = new PendingActionStore();
        const entry = store.create("Tasks", { kind: "complete", sourceId: "t1" });
        expect(store.consume(entry.id)).toEqual(entry);
        expect(store.consume(entry.id)).toBeUndefined();
        expect(store.get(entry.id)).toBeUndefined();
    });

    it("get() returns undefined for an unknown id", () => {
        const store = new PendingActionStore();
        expect(store.get("nope")).toBeUndefined();
    });

    it("list() returns every currently pending entry", () => {
        const store = new PendingActionStore();
        const a = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        const b = store.create("Tasks", { kind: "complete", sourceId: "t1" });
        const ids = store
            .list()
            .map((e) => e.id)
            .sort();
        expect(ids).toEqual([a.id, b.id].sort());
    });

    it("expires a pending action after 5 minutes", () => {
        const store = new PendingActionStore();
        const entry = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        expect(store.get(entry.id)).toBeUndefined();
        expect(store.list()).toEqual([]);
    });

    it("does not expire a pending action just under the 5 minute TTL", () => {
        const store = new PendingActionStore();
        const entry = store.create("Gmail", { kind: "reply", sourceId: "m1", body: "hi" });
        vi.advanceTimersByTime(5 * 60 * 1000 - 1000);
        expect(store.get(entry.id)).toEqual(entry);
    });
});
