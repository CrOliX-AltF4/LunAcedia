import { describe, it, expect } from "vitest";
import { EventStore } from "../../source/store/event_store.js";
import type { AcediaEvent } from "../../source/types/acedia_event.js";

function makeEvent(overrides: Partial<AcediaEvent> = {}): AcediaEvent {
    return {
        type:       "email.received",
        ts:         Date.now(),
        source:     "email",
        title:      "Test event",
        priority:   "normal",
        dedupeKey:  `email-${Math.random()}`,
        ...overrides,
    };
}

describe("EventStore", () => {
    it("should push and retrieve events", () => {
        const store = new EventStore();
        const e = makeEvent({ dedupeKey: "email-1" });
        store.push(e);
        expect(store.get("email-1")).toEqual(e);
    });

    it("should return undefined for unknown dedupeKey", () => {
        const store = new EventStore();
        expect(store.get("nope")).toBeUndefined();
    });

    it("should evict oldest event when maxSize is exceeded", () => {
        const store = new EventStore(3);
        const events = ["a", "b", "c", "d"].map((k) => makeEvent({ dedupeKey: k }));
        events.forEach((e) => store.push(e));
        expect(store.get("a")).toBeUndefined();
        expect(store.get("b")).toBeDefined();
        expect(store.get("d")).toBeDefined();
        expect(store.size).toBe(3);
    });

    it("should return events most-recent-first", () => {
        const store = new EventStore();
        const old   = makeEvent({ dedupeKey: "old", ts: 1000 });
        const fresh = makeEvent({ dedupeKey: "fresh", ts: 2000 });
        store.push(old);
        store.push(fresh);
        const { events } = store.query();
        expect(events[0]!.dedupeKey).toBe("fresh");
        expect(events[1]!.dedupeKey).toBe("old");
    });

    it("should filter by source", () => {
        const store = new EventStore();
        store.push(makeEvent({ source: "email",    dedupeKey: "e1" }));
        store.push(makeEvent({ source: "calendar", dedupeKey: "c1" }));
        const { events } = store.query({ source: "email" });
        expect(events).toHaveLength(1);
        expect(events[0]!.source).toBe("email");
    });

    it("should filter by priority", () => {
        const store = new EventStore();
        store.push(makeEvent({ priority: "urgent", dedupeKey: "u1" }));
        store.push(makeEvent({ priority: "info",   dedupeKey: "i1" }));
        const { events } = store.query({ priority: "urgent" });
        expect(events).toHaveLength(1);
        expect(events[0]!.priority).toBe("urgent");
    });

    it("should filter by since timestamp", () => {
        const store = new EventStore();
        store.push(makeEvent({ ts: 1000, dedupeKey: "old" }));
        store.push(makeEvent({ ts: 3000, dedupeKey: "new" }));
        const { events } = store.query({ since: 2000 });
        expect(events).toHaveLength(1);
        expect(events[0]!.dedupeKey).toBe("new");
    });

    it("should paginate with limit and offset", () => {
        const store = new EventStore();
        for (let i = 0; i < 10; i++) store.push(makeEvent({ dedupeKey: `e${i}`, ts: i }));
        const { events, total } = store.query({ limit: 3, offset: 2 });
        expect(events).toHaveLength(3);
        expect(total).toBe(10);
    });

    it("should return total count reflecting filters", () => {
        const store = new EventStore();
        store.push(makeEvent({ source: "email",  dedupeKey: "e1" }));
        store.push(makeEvent({ source: "email",  dedupeKey: "e2" }));
        store.push(makeEvent({ source: "github", dedupeKey: "g1" }));
        const { total } = store.query({ source: "email" });
        expect(total).toBe(2);
    });

    it("should return stats by source", () => {
        const store = new EventStore();
        store.push(makeEvent({ source: "email",    dedupeKey: "e1" }));
        store.push(makeEvent({ source: "email",    dedupeKey: "e2" }));
        store.push(makeEvent({ source: "calendar", dedupeKey: "c1" }));
        const stats = store.stats();
        expect(stats["email"]).toBe(2);
        expect(stats["calendar"]).toBe(1);
    });

    it("should return the last pushed event for duplicate dedupeKey", () => {
        const store = new EventStore();
        const first  = makeEvent({ dedupeKey: "dup", title: "First" });
        const second = makeEvent({ dedupeKey: "dup", title: "Second" });
        store.push(first);
        store.push(second);
        expect(store.get("dup")?.title).toBe("Second");
    });
});
